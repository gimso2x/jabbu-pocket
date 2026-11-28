import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelBinding } from "../src/channel/adapter";
import { type JabbuConfig, WEB_OWNER_USER_ID } from "../src/config";
import { chatOriginKey } from "../src/core/origin-key";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { gcSessions, LEDGER_RETENTION_DAYS } from "../src/ops/gc";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import { SCHEMA_VERSION } from "../src/store/schema-version";
import { readWebMessages, type WebMessageRow } from "../src/store/web-messages";
import { WebBinding } from "../src/web/binding";
import { WebChannel } from "../src/web/channel";
import type { WebDashboardOptions } from "../src/web/routes";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { daemonTestOptions } from "./helpers/disk";

class ManualScheduler {
	readonly #callbacks = new Map<number, { fn: () => void; ms: number }>();
	#next = 1;

	schedule = (fn: () => void, ms: number): (() => void) => {
		const id = this.#next++;
		this.#callbacks.set(id, { fn, ms });
		return () => {
			this.#callbacks.delete(id);
		};
	};

	tickDue(maxCount = 20): number {
		let ran = 0;
		while (this.#callbacks.size > 0 && ran < maxCount) {
			const batch = [...this.#callbacks.entries()];
			for (const [id, entry] of batch) {
				this.#callbacks.delete(id);
				ran++;
				entry.fn();
			}
			if (batch.every(([, entry]) => entry.ms > 0)) break;
		}
		return ran;
	}
}

class SseReader {
	readonly frames: Array<{ event?: string; data: string }> = [];
	readonly #waiters = new Set<() => void>();
	readonly #abort = new AbortController();
	readonly #done: Promise<void>;

	constructor(url: string, headers: Record<string, string>) {
		this.#done = this.#pump(url, headers);
	}

	async #pump(url: string, headers: Record<string, string>): Promise<void> {
		let res: Response;
		try {
			res = await fetch(url, { headers, signal: this.#abort.signal });
		} catch {
			return;
		}
		const reader = res.body?.getReader();
		if (!reader) return;
		const decoder = new TextDecoder();
		let buf = "";
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buf += decoder.decode(chunk.value, { stream: true });
				let split = buf.indexOf("\n\n");
				while (split !== -1) {
					const block = buf.slice(0, split);
					buf = buf.slice(split + 2);
					this.#parseBlock(block);
					split = buf.indexOf("\n\n");
				}
			}
		} catch {
			// closed via abort
		}
	}

	#parseBlock(block: string): void {
		let event: string | undefined;
		const dataLines: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith(":")) {
				this.frames.push({ data: line });
				this.#notify();
				continue;
			}
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
		}
		if (dataLines.length > 0) {
			this.frames.push({ event, data: dataLines.join("\n") });
			this.#notify();
		}
	}

	#notify(): void {
		for (const wake of [...this.#waiters]) wake();
	}

	waitForFrame(
		predicate: (frame: { event?: string; data: string }) => boolean,
	): Promise<{ event?: string; data: string }> {
		const { promise, resolve } = Promise.withResolvers<{ event?: string; data: string }>();
		const check = () => {
			const hit = this.frames.find(predicate);
			if (!hit) return;
			this.#waiters.delete(check);
			resolve(hit);
		};
		this.#waiters.add(check);
		check();
		return promise;
	}

	async close(): Promise<void> {
		this.#abort.abort();
		await this.#done;
	}
}

class BrokenDiscordTransport extends FakeDiscordTransport {
	override async start(): Promise<never> {
		throw new Error("discord gateway down");
	}
}

const LOCAL_TOKEN = "web-channel-test-token";
let dirs: string[] = [];
let stops: Array<() => Promise<void> | void> = [];

function createTestEnv(
	options: {
		holdTurns?: boolean;
		clock?: { now(): number };
		extraChannels?: ChannelBinding[];
		withDiscordConfig?: boolean;
		respond?: (prompt: string) => string;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-web-ch-"));
	dirs.push(dir);
	chmodSync(dir, 0o700);
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { mode: 0o700 });
	const localTokenPath = join(stateDir, "web-local.token");
	writeFileSync(localTokenPath, `${LOCAL_TOKEN}\n`, { mode: 0o600 });
	const ompExecutable = join(dir, "fake-omp");
	writeFileSync(ompExecutable, '#!/bin/sh\necho "omp/0.0.0-stub"\n', { mode: 0o755 });
	const workspaceDir = join(dir, "workspace");
	mkdirSync(workspaceDir, { mode: 0o700 });
	const secretsDir = join(dir, "secrets");
	mkdirSync(secretsDir, { mode: 0o700 });
	const botTokenFile = join(secretsDir, "discord-bot-token");
	writeFileSync(botTokenFile, `${["TEST", "discord", "0"].join("-")}\n`, { mode: 0o600 });
	const configPath = join(dir, "config.json");

	const config: JabbuConfig = {
		schemaVersion: 1,
		homeDir: dir,
		configPath,
		channels: {
			...(options.withDiscordConfig === true
				? { discord: { ownerUserId: "100000000000000001", botTokenFile, applicationId: "600000000000000000" } }
				: {}),
			web: {
				enabled: true,
				ownerEmails: ["owner@example.com"],
				accessTeamDomain: "team.cloudflareaccess.com",
				accessAud: "aud-web-1",
			},
		},
		ompExecutable,
		workspaceDir,
		timezone: "Asia/Seoul",
	};
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

	const logs: string[] = [];
	const logWaiters = new Set<() => void>();
	const clock = options.clock ?? { now: () => Date.now() };
	const log = createLogger({
		sink: (line) => {
			logs.push(line);
			for (const wake of [...logWaiters]) wake();
		},
		clock,
		redact,
	});
	const drivers: FakeOmpDriver[] = [];
	const sessions = new FakeSessionStore();
	const daemon = new Daemon({
		...daemonTestOptions(),
		config,
		channels: [...(options.extraChannels ?? []), new WebBinding()],
		log,
		clock,
		ompVersion: "omp-test 0",
		bootId: "boot-web-ch",
		gateSweepMs: 0,
		taskSweepMs: 0,
		sweepMs: 3_600_000,
		stopDrainMs: 250,
		driverFactory: (_origin, sessionDir) => {
			const driver = new FakeOmpDriver({
				sessionDir,
				store: sessions,
				holdTurns: options.holdTurns,
				respond: options.respond ?? ((prompt) => `ECHO ${prompt}`),
			});
			drivers.push(driver);
			return driver;
		},
	});
	const scheduler = new ManualScheduler();
	const web: WebDashboardOptions = {
		homeDir: dir,
		auth: {
			ownerEmails: ["owner@example.com"],
			accessTeamDomain: "team.cloudflareaccess.com",
			accessAud: "aud-web-1",
			localTokenPath,
			csrfSecret: Buffer.from("fedcba9876543210fedcba9876543210"),
		},
		callDaemon: (req) => callDaemon(daemon.socketPath, req, 5_000),
		streamSchedule: scheduler.schedule,
	};
	const server = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		web,
		snapshot: async (): Promise<DashboardSnapshot> => ({
			generatedAt: "2026-11-25T12:00:00+09:00",
			timezone: "Asia/Seoul",
			daemon: { ok: false, error: "daemon_down" },
			turns: { ok: false, error: "no_db" },
			tasks: { ok: false, error: "no_db" },
			lanes: { ok: false, error: "no_db" },
			herdr: { ok: false, error: "off" },
			approvals: { ok: false, error: "no_db" },
			monitors: { ok: false, error: "no_db" },
			alerts: { ok: false, error: "no_db" },
			gates: { ok: false, error: "no_db" },
			backup: { ok: false, error: "no_db" },
			jobs: { ok: false, error: "no_db" },
		}),
	});
	stops.push(() => server.stop(true));
	stops.push(() => daemon.stop());

	const baseUrl = `http://127.0.0.1:${server.port}`;
	const authHeaders = { authorization: `Bearer ${LOCAL_TOKEN}` };

	const untilLog = (pattern: RegExp | string): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const matches = (line: string) => (typeof pattern === "string" ? line.includes(pattern) : pattern.test(line));
		const check = () => {
			if (!logs.some(matches)) return;
			logWaiters.delete(check);
			resolve();
		};
		logWaiters.add(check);
		check();
		return promise;
	};

	const initCsrf = async (): Promise<Record<string, string>> => {
		const res = await fetch(`${baseUrl}/api/web/conversations`, { headers: authHeaders });
		expect(res.status).toBe(200);
		const csrf = res.headers.get("x-jabbu-csrf") ?? "";
		return {
			...authHeaders,
			"sec-fetch-site": "same-origin",
			cookie: `jabbu_csrf=${csrf}`,
			"x-jabbu-csrf": csrf,
			"content-type": "application/json",
		};
	};

	return { dir, daemon, baseUrl, authHeaders, scheduler, drivers, logs, untilLog, initCsrf };
}

beforeEach(() => {
	dirs = [];
	stops = [];
});

afterEach(async () => {
	while (stops.length > 0) await stops.pop()?.();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("AC-4, AC-5, AC-7, AC-9: web channel end-to-end delivery, approvals, redaction, and resilience", () => {
	test("AC-4: /api/web/new + /api/web/send -> IPC -> Daemon/FakeOmpDriver -> deliveries -> web_messages -> SSE", async () => {
		const env = createTestEnv();
		await env.daemon.start();
		const headers = await env.initCsrf();

		const createdRes = await fetch(`${env.baseUrl}/api/web/new`, {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "첫 웹 대화" }),
		});
		expect(createdRes.status).toBe(200);
		const created = (await createdRes.json()) as { ok: true; conversation: string; id: number; title: string };
		expect(created.conversation).toMatch(/^w_[a-z0-9]{8,32}$/);

		const sse = new SseReader(`${env.baseUrl}/api/web/stream?c=${created.conversation}`, env.authHeaders);
		stops.push(() => sse.close());
		await sse.waitForFrame((frame) => frame.data === ": web");

		const delivered = env.untilLog("event=delivery_sent");
		const sendRes = await fetch(`${env.baseUrl}/api/web/send`, {
			method: "POST",
			headers,
			body: JSON.stringify({ conversation: created.conversation, text: "안녕 서팍" }),
		});
		expect(sendRes.status).toBe(200);
		await delivered;

		env.scheduler.tickDue();
		const frame = await sse.waitForFrame(
			(entry) => entry.event === "messages" && entry.data.includes("ECHO 안녕 서팍"),
		);
		const sseMessages = (JSON.parse(frame.data) as { messages: WebMessageRow[] }).messages;
		expect(sseMessages.some((m) => m.role === "owner" && m.text === "안녕 서팍")).toBe(true);
		expect(sseMessages.some((m) => m.role === "assistant" && m.text.includes("ECHO 안녕 서팍"))).toBe(true);

		const listRes = await fetch(`${env.baseUrl}/api/web/messages?c=${created.conversation}`, {
			headers: env.authHeaders,
		});
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { messages: WebMessageRow[] };
		expect(listBody.messages.filter((m) => m.role !== "status").map((m) => [m.role, m.text.split("\n")[0]])).toEqual([
			["system", "첫 웹 대화"],
			["owner", "안녕 서팍"],
			["assistant", "ECHO 안녕 서팍"],
		]);

		const convRes = await fetch(`${env.baseUrl}/api/web/conversations`, { headers: env.authHeaders });
		const convBody = (await convRes.json()) as { conversations: Array<{ conversation: string; title: string }> };
		expect(convBody.conversations[0]).toMatchObject({ conversation: created.conversation, title: "첫 웹 대화" });
	});

	test("AC-5: StatusTracker and ApprovalBroker post/edit web_messages and /api/web/action settles cards + SSE", async () => {
		let nowMs = 1_700_000_000_000;
		const env = createTestEnv({ holdTurns: true, clock: { now: () => nowMs } });
		await env.daemon.start();
		const headers = await env.initCsrf();

		const { conversation } = (await (
			await fetch(`${env.baseUrl}/api/web/new`, {
				method: "POST",
				headers,
				body: JSON.stringify({ title: "승인 테스트" }),
			})
		).json()) as { conversation: string };
		const originKey = chatOriginKey({ platform: "web", kind: "dm", conversationId: conversation });

		const sse = new SseReader(`${env.baseUrl}/api/web/stream?c=${conversation}`, env.authHeaders);
		stops.push(() => sse.close());
		await sse.waitForFrame((frame) => frame.data === ": web");

		const turnStarted = env.untilLog("event=turn_start");
		await fetch(`${env.baseUrl}/api/web/send`, {
			method: "POST",
			headers,
			body: JSON.stringify({ conversation, text: "진행해" }),
		});
		await turnStarted;

		// StatusTracker emits a running status row after elapsed time on sweep()
		nowMs += 30_000;
		await env.daemon.sweep();
		const statusRow = readWebMessages(env.dir, conversation).find((m) => m.role === "status");
		expect(statusRow).toBeDefined();
		expect(JSON.parse(statusRow?.cardJson ?? "{}")).toMatchObject({ kind: "status", deleted: false });

		// Trigger ApprovalBroker via host tool
		const tool = env.daemon.hostToolsFor(originKey).find((t) => t.name === "jabbu_request_approval");
		if (!tool) throw new Error("jabbu_request_approval missing");
		const asked = env.untilLog("event=approval_requested");
		const toolPromise = tool.execute({ summary: "deploy staging" }, { signal: new AbortController().signal });
		await asked;

		const approvalRow = readWebMessages(env.dir, conversation).find((m) => m.role === "approval");
		if (!approvalRow) throw new Error("approval row missing in web_messages");
		const buttons = JSON.parse(approvalRow.buttonsJson ?? "[]") as Array<{ actionId: string; label: string }>;
		expect(buttons.length).toBeGreaterThanOrEqual(2);
		const approveButton = buttons.find((b) => b.actionId.includes(":approve:")) ?? buttons[0];
		expect(approveButton).toBeDefined();

		const convBefore = (await (
			await fetch(`${env.baseUrl}/api/web/conversations`, { headers: env.authHeaders })
		).json()) as { conversations: Array<{ openApprovals: number }> };
		expect(convBefore.conversations[0]?.openApprovals).toBe(1);

		env.scheduler.tickDue();
		await sse.waitForFrame((entry) => entry.event === "messages" && entry.data.includes("deploy staging"));

		// Owner clicks approve via HTTP -> IPC -> onAction -> ApprovalBroker edits web_messages + advances editedAt
		const actionRes = await fetch(`${env.baseUrl}/api/web/action`, {
			method: "POST",
			headers,
			body: JSON.stringify({ actionId: approveButton?.actionId, messageId: String(approvalRow.id) }),
		});
		expect(actionRes.status).toBe(200);
		await toolPromise;

		const settled = readWebMessages(env.dir, conversation).find((m) => m.id === approvalRow.id);
		expect(settled?.buttonsJson).toBeNull();
		expect(settled?.editedAt).not.toBeNull();

		env.scheduler.tickDue();
		const editedFrame = await sse.waitForFrame((entry) => {
			if (entry.event !== "messages") return false;
			const msgs = (JSON.parse(entry.data) as { messages: WebMessageRow[] }).messages;
			return msgs.some((m) => m.id === approvalRow.id && m.editedAt === settled?.editedAt && m.buttonsJson === null);
		});
		const editedMsg = (JSON.parse(editedFrame.data) as { messages: WebMessageRow[] }).messages.find(
			(m) => m.id === approvalRow.id,
		);
		expect(editedMsg?.editedAt).toBe(settled?.editedAt);
		expect(editedMsg?.buttonsJson).toBeNull();

		const convAfter = (await (
			await fetch(`${env.baseUrl}/api/web/conversations`, { headers: env.authHeaders })
		).json()) as { conversations: Array<{ openApprovals: number }> };
		expect(convAfter.conversations[0]?.openApprovals).toBe(0);

		// Finish turn -> status row soft-deleted
		const delivered = env.untilLog("event=delivery_sent");
		env.drivers[0]?.release();
		await delivered;
		await env.daemon.sweep();
		const statusDone = readWebMessages(env.dir, conversation).find((m) => m.id === statusRow?.id);
		expect(statusDone?.editedAt).not.toBeNull();
		expect(JSON.parse(statusDone?.cardJson ?? "{}")).toMatchObject({ kind: "status", deleted: true });
	});

	test("AC-7: secrets in deliveries and direct ChannelPort post/edit/uploadFile are redacted before storage", async () => {
		const secret = ["xoxb", "1234567890", "supersecret"].join("-");
		const env = createTestEnv({
			respond: () => `응답 비밀키=${secret}`,
		});
		await env.daemon.start();
		const headers = await env.initCsrf();

		const { conversation } = (await (
			await fetch(`${env.baseUrl}/api/web/new`, {
				method: "POST",
				headers,
				body: JSON.stringify({ title: `제목 ${secret}` }),
			})
		).json()) as { conversation: string };

		const delivered = env.untilLog("event=delivery_sent");
		await fetch(`${env.baseUrl}/api/web/send`, {
			method: "POST",
			headers,
			body: JSON.stringify({ conversation, text: `질문 ${secret}` }),
		});
		await delivered;

		// Also exercise WebChannel direct post, edit (card <-> buttons clearing), and uploadFile directly on Store
		const channel = new WebChannel();
		channel.attach(env.daemon.store.web);
		const directRef = await channel.post(
			{ conversationId: conversation },
			{
				text: `카드 ${secret}`,
				title: `타이틀 ${secret}`,
				body: `본문 ${secret}`,
				fields: [{ label: "토큰", value: secret }],
				buttons: [{ actionId: `act:${secret}`, label: `눌러 ${secret}`, style: "primary" }],
				buttonsNote: `안내 ${secret}`,
			},
		);
		await channel.edit(directRef, { text: `수정 카드 ${secret}`, title: "카드만", buttonsNote: "버튼 제거됨" });
		const clearedRow = env.daemon.store.web.get(Number(directRef.messageId));
		expect(clearedRow?.buttonsJson).toBeNull();

		await channel.uploadFile(
			{ conversationId: conversation },
			{ path: "/tmp/safe-report.txt", title: `파일 ${secret}`, comment: `설명 ${secret}` },
		);

		const res = await fetch(`${env.baseUrl}/api/web/messages?c=${conversation}`, { headers: env.authHeaders });
		const text = await res.text();
		expect(text).not.toContain(secret);
		expect(text).toContain("[REDACTED]");

		const convText = await (await fetch(`${env.baseUrl}/api/web/conversations`, { headers: env.authHeaders })).text();
		expect(convText).not.toContain(secret);
		expect(WEB_OWNER_USER_ID).toBe("web:owner");
	});

	test("AC-9: web round-trip succeeds even when Discord transport start fails", async () => {
		const brokenDiscord = new DiscordBinding(
			new DiscordChannel(new BrokenDiscordTransport(), { ownerUserId: "100000000000000001" }),
		);
		const env = createTestEnv({
			extraChannels: [brokenDiscord],
			withDiscordConfig: true,
		});
		await env.daemon.start();

		const ready = env.logs.find((line) => line.includes("event=daemon_ready"));
		expect(ready).toContain("discord=off");
		expect(ready).toContain("web=on");

		const headers = await env.initCsrf();
		const { conversation } = (await (
			await fetch(`${env.baseUrl}/api/web/new`, {
				method: "POST",
				headers,
				body: JSON.stringify({ title: "디스코드 단절 대화" }),
			})
		).json()) as { conversation: string };

		const delivered = env.untilLog("event=delivery_sent");
		await fetch(`${env.baseUrl}/api/web/send`, {
			method: "POST",
			headers,
			body: JSON.stringify({ conversation, text: "디스코드 없이 동작" }),
		});
		await delivered;

		const rows = readWebMessages(env.dir, conversation);
		expect(rows.some((r) => r.role === "assistant" && r.text.includes("ECHO 디스코드 없이 동작"))).toBe(true);
	});
});

describe("AC-8: schema migrations (10, 11 -> current) and web_messages GC", () => {
	test("openStore adds delivery_key and its unique index to a web_messages table created before it", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-web-mig-dkey-"));
		dirs.push(dir);
		const dbPath = join(dir, "jabbu.db");
		openStore({ path: dbPath, timezone: "Asia/Seoul", clock: { now: () => 1_000 }, redact }).close();

		// The live ledgers of 2026-11-28: web_messages exists, but without delivery_key (apply 20261128-130003).
		const raw = new Database(dbPath);
		raw.exec("DROP INDEX web_messages_delivery_key; ALTER TABLE web_messages DROP COLUMN delivery_key;");
		raw
			.query("INSERT INTO web_messages (conversation, role, text, created_at) VALUES ('w_old', 'owner', 'old', 1)")
			.run();
		raw.close();

		const migrated = openStore({ path: dbPath, timezone: "Asia/Seoul", clock: { now: () => 2_000 }, redact });
		migrated.close();

		const verify = new Database(dbPath, { readonly: true });
		const columns = (verify.query("PRAGMA table_info(web_messages)").all() as Array<{ name: string }>).map(
			(c) => c.name,
		);
		const index = verify
			.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'web_messages_delivery_key'")
			.get() as { sql: string } | null;
		const rows = (verify.query("SELECT count(*) AS n FROM web_messages").get() as { n: number }).n;
		verify.close();
		expect(columns).toContain("delivery_key");
		expect(index?.sql).toContain("UNIQUE");
		expect(rows).toBe(1);
	});

	test("openStore migrates v10 and v11 databases to SCHEMA_VERSION with web_messages and its indexes", () => {
		for (const fromVersion of [10, 11] as const) {
			const dir = mkdtempSync(join(tmpdir(), `jabbu-web-mig-${fromVersion}-`));
			dirs.push(dir);
			const dbPath = join(dir, "jabbu.db");

			// Seed an active database, then roll it back to pre-web_messages schema at `fromVersion`.
			const seed = openStore({ path: dbPath, timezone: "Asia/Seoul", clock: { now: () => 1_000 }, redact });
			seed.close();

			const raw = new Database(dbPath);
			raw.exec("DROP TABLE web_messages;");
			if (fromVersion === 10) {
				raw.exec(`
					DROP TABLE inbound;
					CREATE TABLE inbound (
						inbound_id INTEGER PRIMARY KEY AUTOINCREMENT,
						origin_key TEXT NOT NULL,
						platform_message_id TEXT NOT NULL UNIQUE,
						text_ref TEXT NOT NULL,
						thread_ref TEXT NOT NULL,
						peer_user_id TEXT,
						state TEXT NOT NULL CHECK (state IN ('pending','dispatched','answered','failed_notified','discarded','uncertain')),
						op_ref TEXT,
						entry_cursor TEXT,
						created_at INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						dispatched_at INTEGER,
						uncertain_reason TEXT,
						uncertain_at INTEGER,
						injected INTEGER NOT NULL DEFAULT 0
					);
				`);
			}
			raw.exec(`PRAGMA user_version = ${fromVersion};`);
			raw.close();

			const migrated = openStore({ path: dbPath, timezone: "Asia/Seoul", clock: { now: () => 2_000 }, redact });
			const inserted = migrated.web.insert({ conversation: "w_migrated01", role: "owner", text: "마이그레이션" });
			expect(inserted.id).toBe(1);
			migrated.close();

			const verify = new Database(dbPath, { readonly: true });
			const version = (verify.query("PRAGMA user_version").get() as { user_version: number }).user_version;
			expect(version).toBe(SCHEMA_VERSION);
			const indexes = (
				verify
					.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'web_messages'")
					.all() as Array<{ name: string }>
			)
				.map((r) => r.name)
				.sort();
			expect(indexes).toEqual([
				"web_messages_conv_id",
				"web_messages_conv_thread_id",
				"web_messages_created",
				"web_messages_delivery_key",
			]);
			verify.close();
		}
	});

	test("gcSessions prunes web_messages older than 90 days while retaining rows linked to pending approvals", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-web-gc-"));
		dirs.push(dir);
		const now = 1_700_000_000_000;
		const dayMs = 24 * 60 * 60_000;
		const oldMs = now - (LEDGER_RETENTION_DAYS + 1) * dayMs;
		const freshMs = now - (LEDGER_RETENTION_DAYS - 1) * dayMs;
		let currentMs = oldMs;
		const store = openStore({
			path: join(dir, "jabbu.db"),
			timezone: "Asia/Seoul",
			clock: { now: () => currentMs },
			redact,
		});

		const conv = "w_gc123456";
		const oldNormal = store.web.insert({ conversation: conv, role: "assistant", text: "91d normal" });
		const oldPending = store.web.insert({ conversation: conv, role: "approval", text: "91d pending approval" });
		const oldSettled = store.web.insert({ conversation: conv, role: "approval", text: "91d approved card" });
		currentMs = freshMs;
		const freshRow = store.web.insert({ conversation: conv, role: "assistant", text: "89d fresh" });

		store.createApproval({
			approvalId: `${conv}:${oldPending.id}`,
			channel: conv,
			messageTs: String(oldPending.id),
			summary: "keep pending",
			createdAt: oldMs,
			expiresAt: oldMs + 60_000,
		});
		store.createApproval({
			approvalId: `${conv}:${oldSettled.id}`,
			channel: conv,
			messageTs: String(oldSettled.id),
			summary: "settled",
			createdAt: oldMs,
			expiresAt: oldMs + 60_000,
		});
		store.decideApproval(`${conv}:${oldSettled.id}`, "approved", oldMs + 1_000);
		store.close();

		const dry = gcSessions({ homeDir: dir, retentionDays: 30, dryRun: true, now });
		expect(dry.ledgerRemoved.webMessages).toBe(2);
		expect(readWebMessages(dir, conv)).toHaveLength(4);

		const real = gcSessions({ homeDir: dir, retentionDays: 30, now });
		expect(real.ledgerRemoved.webMessages).toBe(2);
		expect(readWebMessages(dir, conv).map((row) => row.id)).toEqual([oldPending.id, freshRow.id]);
		expect(oldNormal.id).not.toBe(oldPending.id);
	});
});
