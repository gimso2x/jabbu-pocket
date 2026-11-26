// Host tool calls carry the running turn's `opRef` into the dispatch audit context, so every process line a turn
// caused (dispatch-audit.jsonl `turn`) can be grouped and matched with that turn's log lines.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import type { CreateMessageArgs } from "../src/discord/transport";
import { type AuditContext, auditContext } from "../src/dispatch/audit";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { discordBinding, makeHome, OWNER, OWNER_DM, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const ORIGIN = `discord/dm/${OWNER_DM}`;
const SUMMARY = "force push main";

/** Records the audit context each Discord post runs in: the approval card is posted from inside the host tool. */
class ContextTransport extends WaitingDiscordTransport {
	readonly contexts: (AuditContext | undefined)[] = [];
	override async createMessage(args: CreateMessageArgs): Promise<{ id: string }> {
		if (args.content?.includes(SUMMARY)) this.contexts.push(auditContext.getStore());
		return super.createMessage(args);
	}
}

let home: TestHome;
let daemon: Daemon;
let transport: ContextTransport;
let driver: FakeOmpDriver;
/** Resolves with the `opRef` of the first `turn_start` line: the mailbox logs it right after it holds the turn. */
let turnStarted: PromiseWithResolvers<string>;

beforeEach(async () => {
	home = makeHome("jabbu-audit-turn-");
	transport = new ContextTransport();
	turnStarted = Promise.withResolvers<string>();
	driver = new FakeOmpDriver({ sessionDir: join(home.dir, "s"), store: new FakeSessionStore(), holdTurns: true });
	daemon = new Daemon({
		...daemonTestOptions(),
		config: home.config,
		channels: [discordBinding(transport)],
		log: createLogger({
			sink: (line) => {
				const opRef = /event=turn_start .*opRef=(\S+)/.exec(line)?.[1];
				if (opRef !== undefined) turnStarted.resolve(opRef);
			},
			clock: { now: () => Date.now() },
			redact,
		}),
		ompVersion: "omp-test 0",
		bootId: "boot",
		driverFactory: () => driver,
	});
	await daemon.start();
});

afterEach(async () => {
	driver.release();
	await daemon.stop();
	home.remove();
});

async function approvalContexts(): Promise<(AuditContext | undefined)[]> {
	const tool = daemon.hostToolsFor(ORIGIN).find((candidate) => candidate.name === "jabbu_request_approval");
	if (tool === undefined) throw new Error("jabbu_request_approval missing");
	const before = transport.contexts.length;
	const abort = new AbortController();
	const result = tool.execute({ summary: SUMMARY }, { signal: abort.signal });
	await transport.waitForCall(
		(call) => call.method === "editMessage" && Array.isArray(call.components) && call.components.length > 0,
	);
	abort.abort();
	await result.catch(() => undefined);
	return transport.contexts.slice(before);
}

describe("dispatch audit turn", () => {
	test("a host tool called during a turn runs with that turn's opRef and origin", async () => {
		await transport.emitMessage({
			id: "700000000000000001", // gitleaks:allow (fake snowflake)
			channel_id: OWNER_DM,
			author: { id: OWNER },
			content: "go",
			type: 0,
		});
		const opRef = await turnStarted.promise;
		const contexts = await approvalContexts();
		expect(contexts).toHaveLength(1);
		for (const context of contexts) expect(context).toEqual({ origin: ORIGIN, turn: opRef });
	});

	test("with no turn running the call carries no turn", async () => {
		const contexts = await approvalContexts();
		expect(contexts).toHaveLength(1);
		for (const context of contexts) expect(context?.turn).toBeUndefined();
	});
});
