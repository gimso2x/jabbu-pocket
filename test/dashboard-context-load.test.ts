// T-20261125-08 item 3: the thread card's context bar — from the daemon's `live` answer for a running turn, from the
// session file's last assistant usage (with a window a `live` answer taught) for an ended one; tones at 79/80/90%.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveTurn, type LiveView } from "../src/core/live-turn";
import { ContextMemory } from "../src/core/mailbox-context";
import { clearContextLoad } from "../src/dashboard/context-load";
import { SCRIPT } from "../src/dashboard/html";
import { renderDashboardMain } from "../src/dashboard/main-view";
import { buildSnapshot, type DashboardSnapshot, type SnapshotDeps } from "../src/dashboard/snapshot";
import { STYLE } from "../src/dashboard/style";
import type { OmpState } from "../src/omp/driver";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-25T03:00:00Z");
const ORIGIN = "discord/ch/300000000000000001/t/100000000000000001";
const WINDOW = 100_000;

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-context-load-"));
	clearContextLoad();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A home with one conversation: its session file ends with an assistant message using `tokens` context tokens. */
function seed(state: "dispatched" | "answered", tokens: number): void {
	const dbPath = join(home, "jabbu.db");
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const dir = join(home, "sessions", encodeURIComponent(ORIGIN));
	mkdirSync(dir, { recursive: true });
	const message = (usage: unknown): string =>
		`${JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "m", usage } })}\n`;
	// The last call is cut three ways (input, cache read, cache write); an error reply with no usage follows it.
	writeFileSync(
		join(dir, "s.jsonl"),
		message({ input: 5, cacheRead: 5, cacheWrite: 5, output: 9 }) +
			message({ input: 1000, cacheRead: tokens - 1500, cacheWrite: 500, output: 3 }) +
			message({ input: 0, cacheRead: 0, cacheWrite: 0 }),
	);
	const db = new Database(dbPath, { strict: true });
	db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [ORIGIN, dir, NOW]);
	db.run(
		`INSERT INTO inbound (platform_message_id, origin_key, epoch, text_ref, state, created_at, dispatched_at, last_event_at, thread_ref)
		 VALUES ('m0', ?, 1, '요청', ?, ?, ?, ?, 'ch:1')`,
		[ORIGIN, state, NOW - 60_000, NOW - 60_000, NOW - 30_000],
	);
	db.close();
}

function finish(state: "answered" | "failed_notified" = "answered"): void {
	const db = new Database(join(home, "jabbu.db"), { strict: true });
	db.run("UPDATE inbound SET state = ?", [state]);
	db.close();
}

/** `live` answers with `context` (or a bare view, or null); every other op fails like a missing daemon. */
function deps(live: unknown): SnapshotDeps {
	return {
		homeDir: home,
		repoDir: "/srv/jabbu",
		timezone: "Asia/Seoul",
		config: undefined,
		now: () => NOW,
		usageLimits: true,
		callDaemon: async (_socket, request) => {
			if (live === undefined || opOf(request) !== "live") throw new Error("no daemon");
			return { ok: true, live };
		},
		run: async () => ({ code: 1, stdout: "", timedOut: false }),
		ompVersion: async () => "omp-stub 0.0.0",
		hostOps: () => {
			throw new Error("no hosts");
		},
		collectGates: () => [],
	};
}

const opOf = (request: unknown): unknown =>
	typeof request === "object" && request !== null && "op" in request ? request.op : undefined;
const context = (tokens: number | null, window = WINDOW, percent: number | null = null) => ({
	context: { tokens, window, percent },
});
const view = (extra: object) => ({ seq: 1, inboundId: "m0", text: "", running: [], done: [], ...extra });

const turnsOf = (snapshot: DashboardSnapshot) => {
	if (!snapshot.turns.ok) throw new Error(snapshot.turns.error);
	return snapshot.turns.threads;
};
const barOf = (html: string): string =>
	/<span class="limit-row[^"]*" title="컨텍스트[\s\S]*?<\/b><\/span>/.exec(html)?.[0] ?? "";
const tone = (html: string): string =>
	/class="limit-row( is-warn| is-danger)?"/.exec(barOf(html))?.[1]?.trim() ?? "none";

describe("context bar", () => {
	test("a running turn's live context draws the bar: 79% plain, 80% warn, 90% danger", async () => {
		for (const [percent, expected] of [
			[79, "none"],
			[80, "is-warn"],
			[90, "is-danger"],
		] as const) {
			clearContextLoad();
			rmSync(join(home, "jabbu.db"), { force: true });
			seed("dispatched", 1000);
			const snapshot = await buildSnapshot(deps(view(context((percent * WINDOW) / 100, WINDOW, percent))));
			expect(turnsOf(snapshot)[0]?.context?.percent).toBe(percent);
			const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
			expect(tone(html)).toBe(expected);
			expect(barOf(html)).toContain(`aria-label="컨텍스트 ${percent}%"`);
			expect(barOf(html)).toContain(`style="width:${percent}%"`);
		}
	});

	test("an ended attention turn's bar comes from the last assistant usage and the window a live answer taught", async () => {
		for (const [tokens, expected] of [
			[79_000, "none"],
			[80_000, "is-warn"],
			[90_000, "is-danger"],
		] as const) {
			clearContextLoad();
			rmSync(join(home, "jabbu.db"), { force: true });
			seed("dispatched", tokens);
			await buildSnapshot(deps(view(context(1, WINDOW, 1))));
			finish("failed_notified");
			const snapshot = await buildSnapshot(deps(undefined));
			expect(turnsOf(snapshot)[0]?.context).toEqual({ tokens, percent: (tokens / WINDOW) * 100 });
			expect(tone(renderDashboardMain(snapshot, undefined, NOW, { view: "turns" }))).toBe(expected);
		}
	});

	test("done cards compute context load in the snapshot but hide the bar in SSR and client renders", async () => {
		seed("dispatched", 90_000);
		await buildSnapshot(deps(view(context(1, WINDOW, 1))));
		finish("answered");
		const snapshot = await buildSnapshot(deps(undefined));
		expect(turnsOf(snapshot)[0]?.column).toBe("done");
		expect(turnsOf(snapshot)[0]?.context).toEqual({ tokens: 90_000, percent: 90 });
		const server = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		expect(barOf(server)).toBe("");
		const client = new Function("document", "setInterval", `${SCRIPT}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(barOf(client(snapshot, undefined, NOW, { view: "turns" }))).toBe("");
	});

	test("card-meta overrides .limit-row's 4-column grid so the context bar stays inside the card", () => {
		expect(STYLE).toContain(".card-meta .limit-row { display: inline-flex;");
		expect(STYLE).toMatch(/\.card-meta \.limit-row \.meter\s*\{[^}]*width:\s*48px/);
	});

	test("no bar without a value: unknown window, tokens omp does not know yet, no live view", async () => {
		seed("answered", 90_000);
		const noWindow = await buildSnapshot(deps(undefined));
		expect(turnsOf(noWindow)[0]?.context).toBeUndefined();
		expect(barOf(renderDashboardMain(noWindow, undefined, NOW, { view: "turns" }))).toBe("");

		rmSync(join(home, "jabbu.db"), { force: true });
		seed("dispatched", 90_000);
		const unknownTokens = await buildSnapshot(deps(view(context(null, WINDOW, null))));
		expect(turnsOf(unknownTokens)[0]?.context).toBeUndefined();
		// Tokens unknown right now but the window known: the session file's last usage still fills the bar.
		expect(turnsOf(await buildSnapshot(deps(null)))[0]?.context?.percent).toBe(90);
		clearContextLoad();
		expect(turnsOf(await buildSnapshot(deps(null)))[0]?.context).toBeUndefined();
	});

	test("the daemon is asked only for the dashboard's snapshot, never for a `!brief` (no usageLimits flag)", async () => {
		seed("dispatched", 1000);
		const asked: unknown[] = [];
		const base = deps(view(context(50_000, WINDOW, 50)));
		const snapshot = await buildSnapshot({
			...base,
			usageLimits: false,
			callDaemon: async (socket, request, timeout) => {
				asked.push(request);
				return base.callDaemon(socket, request, timeout);
			},
		});
		expect(asked.some((request) => opOf(request) === "live")).toBe(false);
		expect(turnsOf(snapshot)[0]?.context).toBeUndefined();
	});

	test("past 200k tokens the share carries `200k+`", async () => {
		seed("dispatched", 1000);
		const snapshot = await buildSnapshot(deps(view(context(250_000, 1_000_000, 25))));
		const html = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		expect(barOf(html)).toContain("25% · 200k+</b>");
		expect(tone(html)).toBe("none");
		const small = await buildSnapshot(deps(view(context(200_000, 1_000_000, 20))));
		expect(barOf(renderDashboardMain(small, undefined, NOW, { view: "turns" }))).toContain("20%</b>");
	});

	test("the page script draws the same bar without an exception", async () => {
		seed("dispatched", 1000);
		const snapshot = await buildSnapshot(deps(view(context(260_000, 1_000_000, 91))));
		const server = renderDashboardMain(snapshot, undefined, NOW, { view: "turns" });
		const client = new Function("document", "setInterval", `${SCRIPT}\nreturn renderDashboardMain;`)(
			{ getElementById: () => ({}) },
			() => 0,
		) as typeof renderDashboardMain;
		expect(() => client(snapshot, undefined, NOW, { view: "turns" })).not.toThrow();
		expect(barOf(server)).toContain("200k+");
		expect(client(snapshot, undefined, NOW, { view: "turns" })).toBe(server);
	});
});

describe("mailbox live context", () => {
	const state = (over: Partial<OmpState>): OmpState =>
		({ sessionId: "s", idle: true, settled: true, queuedMessageCount: 0, messageCount: 0, ...over }) as OmpState;
	const live = (): LiveView | null => {
		const turn = new LiveTurn({ now: () => NOW } as never, "m0");
		turn.feed({ type: "message_update", message: { content: [{ type: "text", text: "hi" }] } } as never);
		return turn.view();
	};

	test("the context a state() call answered rides on the live view; no call is made for it", async () => {
		const memory = new ContextMemory();
		let calls = 0;
		const driver = {
			state: async () => {
				calls += 1;
				return state({ context: { tokens: 42_000, window: WINDOW, percent: 42 } });
			},
		};
		memory.watch(driver as never);
		expect(memory.attach(live())?.context).toBeUndefined();
		await driver.state();
		expect(calls).toBe(1);
		expect(memory.attach(live())?.context).toEqual({ tokens: 42_000, window: WINDOW, percent: 42 });
		expect(calls).toBe(1);
		expect(memory.attach(null)).toBeNull();
	});

	test("an answer without context keeps the last one; a new child forgets it", async () => {
		const memory = new ContextMemory();
		const answers = [state({ context: { tokens: 1, window: WINDOW, percent: 1 } }), state({})];
		const driver = { state: async () => answers.shift() as OmpState };
		memory.watch(driver as never);
		await driver.state();
		await driver.state();
		expect(memory.attach(live())?.context?.tokens).toBe(1);
		memory.watch({ state: async () => state({}) } as never);
		expect(memory.attach(live())?.context).toBeUndefined();
	});

	test("an older state() answer resolving after a newer one does not overwrite it", async () => {
		const memory = new ContextMemory();
		const resolvers: Array<(answer: OmpState) => void> = [];
		const answers = [0, 1].map(
			() =>
				new Promise<OmpState>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const driver = { state: async () => answers.shift() as Promise<OmpState> };
		memory.watch(driver as never);
		const first = driver.state();
		const second = driver.state();
		resolvers[1]?.(state({ context: { tokens: 2, window: WINDOW, percent: 2 } }));
		await second;
		expect(memory.attach(live())?.context?.tokens).toBe(2);
		resolvers[0]?.(state({ context: { tokens: 1, window: WINDOW, percent: 1 } }));
		await first;
		expect(memory.attach(live())?.context?.tokens).toBe(2);
	});

	test("an in-flight answer of a replaced driver does not resurrect its context", async () => {
		const memory = new ContextMemory();
		let resolveOld: (answer: OmpState) => void = () => undefined;
		const old = new Promise<OmpState>((resolve) => {
			resolveOld = resolve;
		});
		const driver = { state: async () => old };
		memory.watch(driver as never);
		const pending = driver.state();
		memory.watch({ state: async () => state({}) } as never);
		expect(memory.attach(live())?.context).toBeUndefined();
		resolveOld(state({ context: { tokens: 9, window: WINDOW, percent: 9 } }));
		await pending;
		expect(memory.attach(live())?.context).toBeUndefined();
	});
});
