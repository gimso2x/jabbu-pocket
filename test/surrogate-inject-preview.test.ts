// The inject marker echoes a 120-unit preview of the owner text. An emoji straddling the cut must not leave a lone
// surrogate in the posted marker.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const DISCORD_DM = "123456789012345678"; // gitleaks:allow (fake snowflake)

let home: TestHome;
let daemon: Daemon;
let discord: WaitingDiscordTransport;

beforeEach(async () => {
	home = makeHome("jabbu-inject-surrogate-");
	discord = new WaitingDiscordTransport();
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		...daemonTestOptions(),
		config: home.config,
		channels: [new DiscordBinding(new DiscordChannel(discord, { ownerUserId: OWNER }))],
		log: createLogger({ sink: () => undefined, clock: { now: () => Date.now() }, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

describe("inject preview clip", () => {
	test("an emoji across the 120-unit cut is dropped whole, not split", async () => {
		const text = `${"a".repeat(119)}😀 끝`;
		const { nonce } = await daemon.inject({ origin: `discord/dm/${DISCORD_DM}`, asOwner: true, text });
		const marker = discord.posts((body) => body.startsWith(`🧪 inject ${nonce}`))[0];
		expect(marker?.content).toBe(`🧪 inject ${nonce}\n> ${"a".repeat(119)}…`);
		expect((marker?.content ?? "").isWellFormed()).toBe(true);
	});
});
