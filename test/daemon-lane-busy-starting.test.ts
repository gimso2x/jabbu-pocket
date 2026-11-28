// A lane turn still starting (child spawning, prompt not yet through) must hold off
// a landing: `laneBusy` used to read only `mailbox.state.busy`, which is false until
// the prompt resolves, so the tick landed the lane and removed its worktree under
// the spawning child (round-15 F1). The daemon now wires `laneBusy` to `turnPending`.
//
// The fake driver's `prompt()` resolves at once (only its final is held), so the
// "starting" window is faked by gating `leafId()`, which `#openTurn` awaits right
// before the prompt: while the gate holds, the turn is `turnPending` with
// `state.busy` still false. The gate is released only after the background tick
// has had time to reach the landing decision, so the two cases differ: with the
// fix the tick defers at once; without it the tick enters `#runLanding`, waits
// behind the starting turn in `stopWhenIdle`, and lands once the gate opens.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import type { DiscordMessageEvent } from "../src/discord/transport";
import { createLogger } from "../src/log";
import type { OmpSessionDriver } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	CHANNEL as CH,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { git, makeRepo } from "./helpers/git-fixtures";
import { removeRepoAndWorktrees } from "./helpers/lane-harness";

const LANE = "busy-start";
const LANE_ORIGIN = `jabbu/work/${LANE}`;
const BRANCH = "lane/L-20261128-01";

/** A snowflake-sized message id from a small number. */
const sf = (n: number): string => String(700_000_000_000_000_000n + BigInt(n));
const owner = (n: number, text: string, inThread?: number): DiscordMessageEvent => ({
	id: sf(n),
	channel_id: inThread === undefined ? CH : sf(inThread),
	guild_id: GUILD,
	author: { id: OWNER },
	content: text,
	type: 0,
});

let home: TestHome;
let daemon: Daemon | undefined;
let transport: WaitingDiscordTransport;
let repos: string[];
let drivers: FakeOmpDriver[];
/** The spawn gate of the current test; resolved in `afterEach` so a failing test never hangs the stop. */
let spawnGate: PromiseWithResolvers<void> | undefined;
let leafIdCalled = false;

beforeEach(() => {
	home = makeHome("jabbu-lane-busy-starting-");
	daemon = undefined;
	repos = [];
	drivers = [];
	spawnGate = Promise.withResolvers<void>();
	leafIdCalled = false;
});

afterEach(async () => {
	spawnGate?.resolve();
	for (const driver of drivers) driver.release();
	await daemon?.stop();
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

test("a turn still starting holds off the tick's landing", async () => {
	transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CH, type: 0, guildId: GUILD });
	transport.setChannel({ id: sf(9001), type: 11, parentId: CH, guildId: GUILD });
	const discord = home.config.channels.discord;
	if (discord === undefined) throw new Error("makeHome without channels.discord");
	const sessions = new FakeSessionStore();
	const clock = { now: () => Date.now() };
	daemon = new Daemon({
		config: {
			...home.config,
			channels: {
				...home.config.channels,
				discord: { ...discord, mentionFreeChannels: [CH] },
			},
			hostSessionCeiling: 0,
		},
		channels: [discordBinding(transport)],
		clock,
		log: createLogger({ sink: () => undefined, clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot-busy-start",
		stopDrainMs: 0,
		sweepMs: 3_600_000,
		gateSweepMs: 0,
		taskSweepMs: 0,
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
			drivers.push(driver);
			const gate = spawnGate;
			if (gate === undefined) return driver;
			let gated = false;
			return new Proxy(driver, {
				get(target, prop, receiver) {
					if (prop === "leafId" && !gated) {
						gated = true;
						return async (...args: []) => {
							leafIdCalled = true;
							await gate.promise;
							return (target.leafId as (...a: []) => Promise<string | null>)(...args);
						};
					}
					const value = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as unknown as OmpSessionDriver;
		},
	});
	await daemon.start();

	// A closed lane whose claim is one commit ahead of main, with its worktree.
	const repo = makeRepo(repos);
	const baseSha = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "-b", BRANCH);
	git(repo, "commit", "-q", "--allow-empty", "-m", "lane work");
	const sha = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "main");
	const worktree = `${repo}-l-20261128-01`;
	git(repo, "worktree", "add", "-q", worktree, BRANCH);
	daemon.store.insertLane({
		name: LANE,
		title: "busy start lane",
		threadRef: `${CH}:${sf(9001)}`,
		originKey: LANE_ORIGIN,
		cwd: worktree,
		sessionDir: join(home.dir, "sessions", LANE),
		meta: {
			startedAt: 0,
			lastProgressAt: 0,
			steerSeq: 0,
			repo,
			worktree,
			branch: BRANCH,
			baseBranch: "main",
			baseSha,
			sha,
			land: { state: "pending", requestedBy: "owner", attempts: 0 },
		},
	});
	daemon.store.transitionLane(LANE, "done-claimed", { event: "claimed" });
	daemon.store.transitionLane(LANE, "closed", { event: "closed" });

	// A question in the lane's thread starts a turn, which now waits at `leafId`:
	// `turnPending` with `state.busy` still false.
	await transport.emitMessage(owner(9002, "이 부분 설명해줘", 9001));
	const promptDeadline = Date.now() + 5_000;
	while (!leafIdCalled && Date.now() < promptDeadline)
		// sleep-ok: bounded poll for the async dispatch to reach the gated `leafId`
		await Bun.sleep(25);
	expect(leafIdCalled).toBe(true);
	expect(daemon.store.getInbound(`${CH}:${sf(9002)}`)?.originKey).toBe(LANE_ORIGIN);

	// The tick runs while the turn is still starting. Give it time to reach the
	// landing decision (all local work, far inside 2 s), then open the spawn gate:
	// with the fix the tick already deferred; without it the tick is waiting in
	// `#runLanding`'s `stopWhenIdle` and lands once the turn starts.
	await daemon.sweep();
	// sleep-ok: bounded wait for the background lane tick to reach `#tickLanding`
	await Bun.sleep(2_000);
	spawnGate?.resolve();
	const landedAt = Date.now() + 5_000;
	while (Date.now() < landedAt) {
		if (daemon.store.getLane(LANE)?.meta.land?.state !== "pending") break;
		// sleep-ok: bounded poll for the background lane tick to finish its landing attempt
		await Bun.sleep(25);
	}
	expect(daemon.store.getLane(LANE)?.meta.land?.state).toBe("pending");
	expect(existsSync(worktree)).toBe(true);
}, 30_000);
