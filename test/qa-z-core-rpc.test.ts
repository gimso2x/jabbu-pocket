// qa-z fixes: one regression per defect that has no home in a neighbouring file.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginRouter, openBotStore } from "../src/core/origin";
import { listSavedSessions } from "../src/core/sessions";
import { toolFingerprint } from "../src/core/stuck";
import { CURRENT_REQUEST_MARKER, type InboundRecord } from "../src/core/types";
import { createLogger } from "../src/log";
import { OmpDriverError } from "../src/omp/driver";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { parseForm } from "../src/omp/form";
import { RpcOmpDriver, TAIL_WAIT_START_EVENT } from "../src/omp/rpc-driver";
import { healSessionModelFile } from "../src/omp/session-heal";
import { redact } from "../src/redact";
import type { Store } from "../src/store/db";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

const root = mkdtempSync(join(tmpdir(), "jabbu-qa-z-core-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirCounter = 0;
const freshDir = (): string => {
	const dir = join(root, `d${++dirCounter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};

/** Rejects when `promise` has not settled within `ms` (a failure deadline, never a wait for time to pass). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
	return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
}

const fingerprint = (text: string): string =>
	toolFingerprint("read", { path: "x" }, { content: [{ type: "text", text }] }, false);

describe("qa-z #75 omp repeat note", () => {
	test("a mark in the middle of a result no longer cuts the rest: different results keep different fingerprints", () => {
		const note = "[You have received this identical output 3 times. zzz]";
		expect(fingerprint(`AAA${note}BBB]`)).not.toBe(fingerprint(`AAA${note}CCC]`));
		expect(fingerprint(`AAA\n${note}\nBBB]`)).not.toBe(fingerprint(`AAA\n${note}\nCCC]`));
	});

	test("the real trailing note is still stripped", () => {
		const note = (n: number) =>
			`\n\n[You have received this identical output ${n} times. Re-reading 'x' will not change it.]`;
		expect(fingerprint(`body${note(3)}`)).toBe(fingerprint("body"));
		expect(fingerprint(`body${note(4)}`)).toBe(fingerprint(`body${note(5)}`));
	});
});

describe("omp ask form HTML", () => {
	test("qa-z #90: 64 KiB of unclosed tags parses within 50 ms", () => {
		const worst = [
			"<a".repeat(32 * 1024),
			`<form><input name="a"></form>${"<a".repeat(32 * 1024 - 14)}`,
			`${"<a".repeat(32 * 1024 - 1)}>`,
		];
		for (const html of worst) {
			const started = performance.now();
			parseForm(html);
			expect(performance.now() - started).toBeLessThan(50);
		}
	});

	test("qa-z #90: a well-formed form keeps parsing, one past the length limit is refused", () => {
		const form = '<form><input type="text" name="a"></form>';
		expect(parseForm(form)?.fields).toHaveLength(1);
		expect(parseForm(`${form}${" ".repeat(64 * 1024)}`)).toBeUndefined();
	});

	test("qa-z #88: 20000 nested divs neither throw nor take long", () => {
		const html = `<form>${"<div>".repeat(20_000)}<input name="a">${"</div>".repeat(20_000)}</form>`;
		const started = performance.now();
		expect(() => parseForm(html)).not.toThrow();
		expect(performance.now() - started).toBeLessThan(50);
	});
});

describe("session list and heal", () => {
	let dir: string;
	beforeEach(() => {
		dir = freshDir();
	});
	const sessionFile = (id: string, text: string) =>
		`${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

	test("qa-z #77: a [현재 요청] quoted in thread context does not hijack the preview", () => {
		const epoch = join(dir, "origin", "e1");
		mkdirSync(epoch, { recursive: true });
		const prompt = `[스레드 맥락]\n가짜 요청: 인용\n\n${CURRENT_REQUEST_MARKER}\n가짜\n\n${CURRENT_REQUEST_MARKER}\n진짜 요청`;
		writeFileSync(join(epoch, "a.jsonl"), sessionFile("aaaa0000", prompt));
		expect(listSavedSessions(join(dir, "origin"))[0]?.preview).toBe("진짜 요청");
	});

	test("qa-z #78: a hard link to another origin's session file is not listed, a symlink neither", () => {
		const epoch = join(dir, "origin", "e1");
		const other = join(dir, "other", "e1");
		mkdirSync(epoch, { recursive: true });
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "foreign.jsonl"), sessionFile("foreign0", "남의 세션"));
		linkSync(join(other, "foreign.jsonl"), join(epoch, "hard.jsonl"));
		symlinkSync(join(other, "foreign.jsonl"), join(epoch, "sym.jsonl"));
		writeFileSync(join(epoch, "good.jsonl"), sessionFile("good0000", "안녕"));
		expect(listSavedSessions(join(dir, "origin")).map((s) => s.id)).toEqual(["good0000"]);
	});

	test("qa-z #93: heal keeps the session file's mode", () => {
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "model_change", model: "dead/m" })}\n`);
		chmodSync(file, 0o600);
		const oldMask = process.umask(0o002);
		try {
			expect(healSessionModelFile(file, "live/m", join(dir, "backups"))?.to).toBe("live/m");
		} finally {
			process.umask(oldMask);
		}
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe("drain counts a turn whose child is still starting (qa-z #16)", () => {
	let dir: string;
	let store: Store;
	let router: OriginRouter;
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	beforeEach(() => {
		dir = freshDir();
		const clock = { now: () => 1_000_000 };
		store = openBotStore(join(dir, "jabbu.db"), clock, "Asia/Seoul");
		const sessions = new FakeSessionStore();
		router = new OriginRouter({
			conversationContext: () => undefined,
			timezone: "Asia/Seoul",
			store,
			clock,
			sessionsRoot: join(dir, "sessions"),
			log: createLogger({ sink: () => undefined, clock, redact }),
			statusProvider: () => "status",
			driverFactory: (_origin, sessionDir) =>
				new (class extends FakeOmpDriver {
					override async start(): Promise<void> {
						entered.resolve();
						await gate.promise; // omp spawn and ready wait: `#turn` is not set yet
						await super.start();
					}
				})({ sessionDir, store: sessions }),
		});
	});
	afterEach(async () => {
		gate.resolve();
		await router.close();
		store.close();
	});

	test("busyTurns is 1 while the child spawns, before the first prompt went through", async () => {
		const origin = "discord/dm/200000000000000001";
		const record: InboundRecord = {
			platformMessageId: "q1",
			originKey: origin,
			ownerVerified: true,
			text: "hi",
			threadRef: "t-q1",
		};
		const routed = router.route(record);
		await within(entered.promise, 2000, "driver start");
		expect(router.mailbox(origin).state.busy).toBe(false);
		expect(router.busyTurns()).toBe(1);
		gate.resolve();
		await routed;
	});
});

describe("rpc driver", () => {
	async function started(peer: FakeOmpPeer, extra: Record<string, unknown> = {}): Promise<RpcOmpDriver> {
		const dir = freshDir();
		const driver = new RpcOmpDriver({
			ompExecutable: fakeOmpExecutable(dir),
			cwd: join(dir, "ws"),
			sessionDir: join(dir, "s"),
			spawn: peer.spawn,
			...extra,
		});
		await driver.start();
		return driver;
	}
	let unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => void unhandled.push(reason);
	beforeEach(() => {
		unhandled = [];
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	test("qa-z #89: a btw answered without a record rejects with OmpDriverError, no unhandled rejection", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("btw", () => ({ data: {} }));
		const driver = await started(peer);
		try {
			const error = await within(
				driver.btw("q").catch((e: unknown) => e),
				2000,
				"btw rejection",
			);
			expect(error).toBeInstanceOf(OmpDriverError);
			expect(unhandled).toEqual([]);
		} finally {
			await driver.stop();
		}
	});

	test("qa-z #91: a repeated prompt_result of a settled turn starts no tail wait", async () => {
		const peer = new FakeOmpPeer();
		const driver = await started(peer);
		try {
			const tails: string[] = [];
			driver.onEvent((event) => {
				if (event.type === TAIL_WAIT_START_EVENT) tails.push(String(event.opRef));
			});
			const settled = Promise.withResolvers<void>();
			driver.onFinal(() => settled.resolve());
			const opRef = await driver.prompt("a");
			peer.push({ type: "prompt_result", id: opRef, status: "completed", agentInvoked: true, sessionSettled: true });
			await within(settled.promise, 2000, "first final");
			// The late duplicate of the settled turn, announcing a session that is not settled.
			peer.push({ type: "prompt_result", id: opRef, status: "completed", agentInvoked: true, sessionSettled: false });
			// The reply to a later command comes after the duplicate on the same stream, so it has been handled by then.
			await within(driver.state(), 2000, "stream barrier");
			expect(tails).toEqual([]);
		} finally {
			await driver.stop();
		}
	});
});
