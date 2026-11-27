// First-run onboarding: the state machine and its owner-words check (store + tool), the daemon's read-only guard and
// prompt line on a real daemon ledger, the owner notes append, the CLI reset and the Cataly marker gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onboardingCommand } from "../src/cli/onboarding";
import type { JabbuConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import {
	ONBOARDING_CURSOR,
	ONBOARDING_TOOL_DENIED,
	OnboardingError,
	type OnboardingState,
	readState,
} from "../src/onboarding/state";
import { buildOnboardingTool, FINISH_TEXT_MAX_CHARS } from "../src/onboarding/tools";
import { redact } from "../src/redact";
import type { HostToolDef } from "../src/safety/host-tools";
import { spawnSystemPrompt } from "../src/safety/prompt";
import { OWNER_NOTES_MAX_BYTES } from "../src/safety/prompt-files";
import { openStore, type Store } from "../src/store/db";
import { makeHome, OWNER, OWNER_DM, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const ORIGIN = `discord/dm/${OWNER_DM}`;
const quietLog = (sink: (line: string) => void = () => {}) => createLogger({ sink, clock: { now: () => 0 }, redact });
const noSignal = { signal: new AbortController().signal };

describe("state machine", () => {
	let dir: string;
	let store: Store;
	let now: number;
	let seq: number;
	let notes: string;
	let logged: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jabbu-onboarding-"));
		notes = join(dir, "owner.md");
		now = 1_000;
		seq = 0;
		logged = [];
		store = openStore({
			path: join(dir, "jabbu.db"),
			clock: { now: () => now },
			timezone: "Asia/Seoul",
			redact: (text) => text,
		});
		store.ensureOrigin(ORIGIN, join(dir, "s"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const tool = (): HostToolDef =>
		buildOnboardingTool({
			originKey: ORIGIN,
			store,
			notesPath: notes,
			timezone: "Asia/Seoul",
			now: () => now,
			log: quietLog((line) => logged.push(line)),
		});
	const call = (params: Record<string, unknown>) => tool().execute(params, noSignal);
	/** The owner (or a peer bot) writes `text` in the conversation, with the clock moving on around it. */
	const says = (text: string, peerUserId?: string) => {
		now += 10;
		store.recordInbound({
			originKey: ORIGIN,
			platformMessageId: `m${++seq}`,
			textRef: text,
			...(peerUserId === undefined ? {} : { peerUserId }),
		});
		now += 10;
	};
	const stateOf = (): OnboardingState => {
		const read = readState(store);
		if (!read.ok) throw new Error("unreadable");
		return read.state;
	};
	const raw = () => store.getCursor(ONBOARDING_CURSOR);
	/** The call is refused with an onboarding error and the cursor is as it was. */
	const refused = async (params: Record<string, unknown>, before = raw()) => {
		await expect(call(params)).rejects.toBeInstanceOf(OnboardingError);
		expect(raw()).toBe(before);
	};

	test("AC-1: first run → start → consent yes → tool → finish → done; the summary lands in the notes", async () => {
		await call({ op: "start" });
		expect(stateOf().phase).toBe("running");
		says("네, 읽어도 좋아요");
		await call({ op: "consent", reply: "yes", message: "읽어도 좋아요" });
		says("캘린더는 괜찮아요");
		await call({ op: "tool", name: "calendar", reply: "allowed", reads: "일정 제목", message: "캘린더는 괜찮아요" });
		expect(stateOf().tools.calendar).toMatchObject({ answer: "allowed", reads: "일정 제목" });
		await call({ op: "finish", text: "PM, 주 3회 회의" });
		expect(stateOf()).toMatchObject({ phase: "done", summary: "PM, 주 3회 회의" });
		expect(stateOf().forced).toBeUndefined();
		expect(readFileSync(notes, "utf8")).toMatch(/^## 온보딩 요약 \(\d{4}-\d{2}-\d{2}\)\nPM, 주 3회 회의\n$/);
		expect(JSON.parse(await call({ op: "view" }))).not.toHaveProperty("summary");
	});

	test("AC-1: consent no → done; start without reopen and finish are refused", async () => {
		await call({ op: "start" });
		says("아니요 괜찮아요");
		await call({ op: "consent", reply: "no", message: "아니요" });
		expect(stateOf()).toMatchObject({ phase: "done", consent: { answer: "no" } });
		await refused({ op: "start" });
		await refused({ op: "finish", text: "x" });
		expect(() => readFileSync(notes, "utf8")).toThrow();
	});

	test("AC-1: consent, tool and finish outside running change nothing; tool and finish need the yes", async () => {
		const fresh = raw();
		for (const params of [
			{ op: "consent", reply: "yes", message: "예" },
			{ op: "tool", name: "t", reply: "allowed", reads: "r", message: "예" },
			{ op: "finish", text: "x" },
		]) {
			says("예");
			await refused(params, fresh);
		}
		await call({ op: "start" });
		says("예");
		await refused({ op: "tool", name: "t", reply: "allowed", reads: "r", message: "예" });
		await refused({ op: "finish", text: "x" });
		expect(stateOf().phase).toBe("running");
	});

	test("AC-1: a running start reports it; a bad tool name or reply is refused", async () => {
		await call({ op: "start" });
		expect(await call({ op: "start" })).toContain("이미 진행 중");
		says("예");
		await call({ op: "consent", reply: "yes", message: "예" });
		says("예");
		await refused({ op: "tool", name: "../x", reply: "allowed", reads: "r", message: "예" });
		await refused({ op: "tool", name: "ok", reply: "maybe", reads: "r", message: "예" });
	});

	test("AC-2: done/no and existing-notes bots need reopen and the owner's words; reopen clears the consent", async () => {
		writeFileSync(notes, "기존 관찰\n");
		await refused({ op: "start" });
		await refused({ op: "start", reopen: true });
		await refused({ op: "start", reopen: true, message: "온보딩 해줘" }); // never said
		says("온보딩 해줘");
		await call({ op: "start", reopen: true, message: "온보딩 해줘" });
		expect(stateOf()).toMatchObject({ phase: "running", reopenedBy: "온보딩 해줘" });
		says("네");
		await call({ op: "consent", reply: "no", message: "네" });
		await refused({ op: "start" });
		says("다시 온보딩 하자");
		await call({ op: "start", reopen: true, message: "다시 온보딩" });
		expect(stateOf().phase).toBe("running");
		expect(stateOf().consent).toBeUndefined();
	});

	test("AC-3: a made-up message, a peer bot's row and an ask auto-pick do not carry a consent", async () => {
		await call({ op: "start" });
		const running = raw();
		says("그건 나중에");
		await refused({ op: "consent", reply: "yes", message: "읽어도 됩니다" }, running);
		await refused({ op: "consent", reply: "yes", message: "   " }, running);
		says("읽어도 됩니다", "200000000000000009");
		await refused({ op: "consent", reply: "yes", message: "읽어도 됩니다" }, running);
		// an ask card's deadline pick is recorded by the approval broker, never as an inbound row
		await refused({ op: "consent", reply: "yes", message: "동의 (자동 선택)" }, running);
		says("읽어도 됩니다");
		await call({ op: "consent", reply: "yes", message: "읽어도 됩니다" });
		const consented = raw();
		await refused({ op: "tool", name: "mail", reply: "allowed", reads: "제목", message: "메일 읽어" }, consented);
	});

	test("AC-3: a message from before start does not carry a consent", async () => {
		says("읽어도 좋아요");
		await call({ op: "start" });
		await refused({ op: "consent", reply: "yes", message: "읽어도 좋아요" });
	});

	test("AC-4: an unreadable cursor is running and is never overwritten", async () => {
		store.setCursor(ONBOARDING_CURSOR, "{not json");
		expect(readState(store).ok).toBe(false);
		for (const params of [
			{ op: "start" },
			{ op: "consent", reply: "yes", message: "예" },
			{ op: "tool", name: "t", reply: "allowed", reads: "r", message: "예" },
			{ op: "finish", text: "x" },
		]) {
			says("예");
			await refused(params, "{not json");
		}
		expect(logged.some((line) => line.includes("onboarding_state_unreadable"))).toBe(true);
		expect(JSON.parse(await call({ op: "view" }))).toMatchObject({ phase: "running", unreadable: true });
	});

	const toFinish = async () => {
		await call({ op: "start" });
		says("예");
		await call({ op: "consent", reply: "yes", message: "예" });
	};

	test("AC-7: finish refuses over-long text, an over-cap file and a symlink; running and the file stay", async () => {
		await toFinish();
		const running = raw();
		await refused({ op: "finish", text: "가".repeat(FINISH_TEXT_MAX_CHARS + 1) }, running);
		writeFileSync(notes, "x".repeat(OWNER_NOTES_MAX_BYTES - 10));
		await refused({ op: "finish", text: "요약이 십 바이트보다 길다" }, running);
		expect(readFileSync(notes, "utf8")).toBe("x".repeat(OWNER_NOTES_MAX_BYTES - 10));
		rmSync(notes);
		const target = join(dir, "elsewhere.md");
		writeFileSync(target, "다른 파일\n");
		symlinkSync(target, notes);
		await refused({ op: "finish", text: "요약" }, running);
		expect(readFileSync(target, "utf8")).toBe("다른 파일\n");
		expect(stateOf().phase).toBe("running");
	});

	test("AC-7: finish appends after existing notes; a missing file is created 0600", async () => {
		await toFinish();
		writeFileSync(notes, "기존 관찰\n");
		await call({ op: "finish", text: "요약" });
		expect(readFileSync(notes, "utf8")).toMatch(/^기존 관찰\n\n## 온보딩 요약 \(\d{4}-\d{2}-\d{2}\)\n요약\n$/);
		rmSync(notes);
		says("다시 해줘");
		await call({ op: "start", reopen: true, message: "다시 해줘" });
		says("예");
		await call({ op: "consent", reply: "yes", message: "예" });
		await call({ op: "finish", text: "둘째" });
		expect(readFileSync(notes, "utf8")).toContain("## 온보딩 요약 (");
		expect(statSync(notes).mode & 0o777).toBe(0o600);
	});

	test("AC-8: --reset forces a first run (phase new, forced) even with notes; finish drops forced", async () => {
		writeFileSync(notes, "기존 관찰\n");
		store.setCursor(ONBOARDING_CURSOR, JSON.stringify({ phase: "done", tools: {} }));
		expect(onboardingCommand(["--reset"], dir)).toBe(0);
		expect(JSON.parse(await call({ op: "view" }))).toMatchObject({ phase: "new", forced: true });
		await call({ op: "start" }); // a first run again, though the notes have content
		says("예");
		await call({ op: "consent", reply: "yes", message: "예" });
		await call({ op: "finish", text: "다시" });
		expect(stateOf().forced).toBeUndefined();
		expect(stateOf().phase).toBe("done");
	});

	test("AC-8: --reset repairs an unreadable cursor; extra arguments are a usage error", () => {
		store.setCursor(ONBOARDING_CURSOR, "{not json");
		expect(onboardingCommand([], dir)).toBe(0);
		expect(readState(store).ok).toBe(false);
		expect(onboardingCommand(["--reset"], dir)).toBe(0);
		expect(readState(store)).toMatchObject({ ok: true, state: { phase: "new", forced: true } });
		expect(onboardingCommand(["extra"], dir)).toBe(2);
	});
});

describe("daemon: prompt line, tools and the read-only guard", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;
	let lines: string[];
	const sessions = new FakeSessionStore();

	const notesFile = () => join(home.dir, "workspace", "owner.md");

	async function boot(config: JabbuConfig): Promise<Daemon> {
		const clock = { now: () => Date.now() };
		const started = new Daemon({
			...daemonTestOptions(),
			config,
			channels: [
				new DiscordBinding(new DiscordChannel(new WaitingDiscordTransport(), { ownerUserId: OWNER }), {
					peerPartWaitMs: 0,
				}),
			],
			clock,
			log: createLogger({ sink: (line) => lines.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot-onboarding",
			stopDrainMs: 0,
			gateSweepMs: 0,
			taskSweepMs: 0,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		daemon = started;
		await started.start();
		return started;
	}

	beforeEach(() => {
		home = makeHome("jabbu-onboarding-daemon-");
		lines = [];
		daemon = undefined;
		mkdirSync(join(home.dir, "workspace"), { recursive: true });
	});
	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	const toolOf = (made: Daemon, name: string, origin = ORIGIN): HostToolDef => {
		const found = made.hostToolsFor(origin).find((t) => t.name === name);
		if (found === undefined) throw new Error(`no tool ${name}`);
		return found;
	};
	const run = (t: HostToolDef, params: Record<string, unknown> = {}) => t.execute(params, noSignal);
	const setState = (made: Daemon, state: unknown) =>
		made.store.setCursor(ONBOARDING_CURSOR, typeof state === "string" ? state : JSON.stringify(state));
	const posts = (made: Daemon) => made.store.listLaneBoardPosts("general", 0, 10);

	test("AC-5: notes with content and no force: no line, no denial; missing or blank notes: first-run line", async () => {
		const made = await boot(home.config);
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toContain("첫 실행");
		writeFileSync(notesFile(), "  \n\n");
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toContain("첫 실행");
		writeFileSync(notesFile(), "오너는 개발자\n");
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toBeUndefined();
		await run(toolOf(made, "jabbu_board_post"), { text: "그대로 동작" });
		expect(posts(made)).toHaveLength(1);
	});

	test("AC-5: the first-run line reaches the prompt as the dynamic line tagged onboarding", async () => {
		const made = await boot(home.config);
		const sessionDir = join(home.dir, "sessions", "e9");
		mkdirSync(sessionDir, { recursive: true });
		const logged: string[] = [];
		const text = spawnSystemPrompt({
			secretsDir: join(home.dir, "secrets"),
			originKey: ORIGIN,
			sessionDir,
			surface: made.floorsSurfaceFor(ORIGIN),
			now: Date.now(),
			log: quietLog((line) => logged.push(line)),
		});
		expect(text).toContain("첫 실행: 오너에게 먼저 인사하고");
		expect(logged.find((line) => line.includes("omp_spawn_prompt"))).toMatch(/floors_dynamic="?[^"\s]*onboarding/);
	});

	test("AC-5: the line follows the stored state (running, declined, done, forced)", async () => {
		const made = await boot(home.config);
		writeFileSync(notesFile(), "관찰\n");
		setState(made, { phase: "running", tools: {} });
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toContain("동의 답 전");
		setState(made, { phase: "running", tools: {}, consent: { answer: "yes", message: "m", at: 1 } });
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toContain("읽기 전용");
		setState(made, { phase: "done", tools: {}, consent: { answer: "no", message: "m", at: 1 } });
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toContain("거절됨");
		setState(made, { phase: "done", tools: {}, consent: { answer: "yes", message: "m", at: 1 } });
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toBeUndefined();
		setState(made, { phase: "new", forced: true, tools: {} });
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toContain("첫 실행");
	});

	test("AC-4: while running the posting and work tools are denied unrun; done runs them again", async () => {
		const made = await boot(home.config);
		const names = made.hostToolsFor(ORIGIN).map((t) => t.name);
		const guarded = [
			"jabbu_dispatch",
			"jabbu_work_start",
			"jabbu_board_post",
			"jabbu_monitor_add",
			"jabbu_monitor_remove",
			"discord_send_file",
		].filter((name) => names.includes(name));
		for (const must of ["jabbu_dispatch", "jabbu_board_post", "jabbu_monitor_add", "discord_send_file"]) {
			expect(guarded).toContain(must);
		}
		setState(made, { phase: "running", tools: {} });
		for (const name of guarded) {
			await expect(run(toolOf(made, name), { text: "x" })).rejects.toThrow(ONBOARDING_TOOL_DENIED);
		}
		expect(posts(made)).toHaveLength(0);
		expect(lines.some((line) => line.includes("host_tool_denied_onboarding"))).toBe(true);
		// an unreadable cursor counts as running and stays as it is
		setState(made, "{not json");
		await expect(run(toolOf(made, "jabbu_board_post"), { text: "x" })).rejects.toThrow(ONBOARDING_TOOL_DENIED);
		for (const params of [{ op: "start" }, { op: "finish", text: "x" }]) {
			await expect(run(toolOf(made, "jabbu_onboarding"), params)).rejects.toBeInstanceOf(OnboardingError);
		}
		expect(made.store.getCursor(ONBOARDING_CURSOR)).toBe("{not json");
		expect(lines.some((line) => line.includes("onboarding_state_unreadable"))).toBe(true);
		setState(made, { phase: "done", tools: {} });
		await run(toolOf(made, "jabbu_board_post"), { text: "다시 동작" });
		expect(posts(made)).toHaveLength(1);
	});

	test("AC-4: the guard reads the state at every call of an already built tool", async () => {
		const made = await boot(home.config);
		const post = toolOf(made, "jabbu_board_post");
		await run(post, { text: "하나" });
		setState(made, { phase: "running", tools: {} });
		await expect(run(post, { text: "둘" })).rejects.toThrow(ONBOARDING_TOOL_DENIED);
		expect(posts(made)).toHaveLength(1);
	});

	test("AC-1/AC-3 on the daemon ledger: first run → consent → finish writes the notes", async () => {
		const made = await boot(home.config);
		made.store.ensureOrigin(ORIGIN, join(home.dir, "sessions", "e1"));
		const onboarding = toolOf(made, "jabbu_onboarding");
		await run(onboarding, { op: "start" });
		await expect(run(onboarding, { op: "consent", reply: "yes", message: "읽어도 됩니다" })).rejects.toBeInstanceOf(
			OnboardingError,
		);
		// the owner's reply must be stamped after start's millisecond (a spin on the clock, not a sleep)
		for (const t = Date.now(); Date.now() === t; ) {}
		made.store.recordInbound({ originKey: ORIGIN, platformMessageId: "m1", textRef: "읽어도 됩니다" });
		await run(onboarding, { op: "consent", reply: "yes", message: "읽어도 됩니다" });
		await run(onboarding, { op: "finish", text: "개발자" });
		expect(readFileSync(notesFile(), "utf8")).toContain("개발자");
		expect(made.floorsSurfaceFor(ORIGIN).onboarding).toBeUndefined();
	});

	test("AC-6: lane, monitor and [TASK] origins and agy bots get no onboarding line or tool", async () => {
		const made = await boot(home.config);
		for (const origin of ["jabbu/work/some-lane", "monitor/some-monitor", "jabbu/task/T-20260101-01"]) {
			expect(made.floorsSurfaceFor(origin).onboarding).toBeUndefined();
			expect(made.hostToolsFor(origin).map((t) => t.name)).not.toContain("jabbu_onboarding");
		}
		expect(made.hostToolsFor(ORIGIN).map((t) => t.name)).toContain("jabbu_onboarding");
		await made.stop();
		daemon = undefined;
		const agy = await boot({ ...home.config, agent: "agy" });
		expect(agy.floorsSurfaceFor(ORIGIN).onboarding).toBeUndefined();
		expect(agy.hostToolsFor(ORIGIN).map((t) => t.name)).not.toContain("jabbu_onboarding");
	});
});

describe("AC-9: no Cataly port marker in the repository", () => {
	test("no tracked file carries the port marker", async () => {
		const marker = ["Ported from", ["vntrevx", "Cataly"].join("/")].join(" ");
		const proc = Bun.spawn(["git", "grep", "-l", "-F", marker], { cwd: join(import.meta.dir, ".."), stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out.trim()).toBe("");
	});
});
