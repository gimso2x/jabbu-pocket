import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveView } from "../src/core/live-turn";
import { agyTranscriptFile, readAgyConversation, readThreadLive } from "../src/dashboard/agy-conversation";
import { startDashboardServer } from "../src/dashboard/server";
import { readThreadConversation } from "../src/dashboard/thread-conversation";
import { openStore } from "../src/store/db";

const NOW = Date.parse("2026-11-26T10:00:00Z");
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jabbu-agy-conv-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedOrigin(home: string, originKey: string, sessionDir: string): void {
	const dbPath = join(home, "jabbu.db");
	mkdirSync(home, { recursive: true });
	openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => NOW }, redact: (text) => text }).close();
	const db = new Database(dbPath, { strict: true });
	db.run("INSERT INTO origins (origin_key, epoch, session_dir, updated_at) VALUES (?, 1, ?, ?)", [
		originKey,
		sessionDir,
		NOW,
	]);
	db.close();
}

function writeTranscript(geminiDir: string, appDataDir: string, conversationId: string, records: unknown[]): string {
	const dir = join(geminiDir, appDataDir, "brain", conversationId, ".system_generated", "logs");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "transcript.jsonl");
	writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
	return file;
}

describe("agy transcript parsing", () => {
	test("parses USER_INPUT, PLANNER_RESPONSE, GENERIC statuses, and ignores SYSTEM_MESSAGE", () => {
		const file = join(root, "transcript.jsonl");
		const entries = [
			{
				step_index: 0,
				type: "USER_INPUT",
				status: "DONE",
				created_at: iso(NOW - 5 * MINUTE),
				content:
					"<USER_REQUEST>\n[이 방의 자리와 용도]\n```\n자리: #서팍\n```\n\n[현재 요청]\n상태 확인해 줘\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignore me\n</ADDITIONAL_METADATA>",
			},
			{
				step_index: 1,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: iso(NOW - 4 * MINUTE),
				thinking: "먼저 로그를 본다",
				tool_calls: [
					{
						name: "run_command",
						args: { CommandLine: '"ls -la"', toolSummary: '"Check files"' },
					},
					{
						name: "read_file",
						args: { Path: '"/srv/app/README.md"' },
					},
				],
			},
			{
				step_index: 2,
				type: "GENERIC",
				status: "DONE",
				created_at: iso(NOW - 4 * MINUTE + 1000),
				content: "total 4",
			},
			{
				step_index: 3,
				type: "GENERIC",
				status: "ERROR",
				created_at: iso(NOW - 4 * MINUTE + 2000),
				content: "file not found",
			},
			{
				step_index: 4,
				type: "SYSTEM_MESSAGE",
				status: "DONE",
				created_at: iso(NOW - 3 * MINUTE),
				content: "Reminder: internal system note",
			},
			{
				step_index: 5,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: iso(NOW - 2 * MINUTE),
				content: "확인 완료",
			},
			{
				step_index: 6,
				type: "USER_INPUT",
				status: "DONE",
				created_at: iso(NOW - MINUTE),
				content: "태그 없는 후속 질문",
			},
			{
				step_index: 7,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: iso(NOW - MINUTE + 500),
				tool_calls: [
					{ name: "search_web", args: { query: '"jabbu status"' } },
					{ name: "bash", args: { Description: "Still running" } },
				],
			},
			{
				step_index: 8,
				type: "GENERIC",
				status: "RUNNING",
				created_at: iso(NOW - MINUTE + 1000),
				content: "Tool is running as a background task",
			},
		];
		writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));

		const result = readAgyConversation(file);
		expect(result.cursor).toBeUndefined();
		expect(result.turns).toHaveLength(4);
		expect(result.turns[0]).toEqual({
			role: "user",
			ts: NOW - 5 * MINUTE,
			parts: [{ kind: "text", text: "[이 방의 자리와 용도]\n```\n자리: #서팍\n```\n\n[현재 요청]\n상태 확인해 줘" }],
		});
		expect(result.turns[1]).toEqual({
			role: "assistant",
			ts: NOW - 4 * MINUTE,
			parts: [
				{ kind: "thinking", text: "먼저 로그를 본다" },
				{ kind: "tool", name: "run_command", summary: "Check files", output: "total 4", error: false },
				{ kind: "tool", name: "read_file", summary: "/srv/app/README.md", output: "file not found", error: true },
				{ kind: "text", text: "확인 완료" },
			],
		});
		expect(result.turns[2]).toEqual({
			role: "user",
			ts: NOW - MINUTE,
			parts: [{ kind: "text", text: "태그 없는 후속 질문" }],
		});
		expect(result.turns[3]).toEqual({
			role: "assistant",
			ts: NOW - MINUTE + 500,
			parts: [
				{
					kind: "tool",
					name: "search_web",
					summary: "jabbu status",
					output: "Tool is running as a background task",
					error: false,
					running: true,
				},
				{ kind: "tool", name: "bash", summary: "Still running", output: "", error: false, running: true },
			],
		});
	});

	test("paginates 25 user turns into last 20 with cursor then first 5 without one", () => {
		const file = join(root, "paged.jsonl");
		let step = 0;
		for (let n = 1; n <= 25; n += 1) {
			appendFileSync(
				file,
				`${JSON.stringify({
					step_index: step++,
					type: "USER_INPUT",
					status: "DONE",
					created_at: iso(NOW - (60 - n) * MINUTE),
					content: `<USER_REQUEST>질문 ${n}</USER_REQUEST>`,
				})}\n`,
			);
			appendFileSync(
				file,
				`${JSON.stringify({
					step_index: step++,
					type: "PLANNER_RESPONSE",
					status: "DONE",
					created_at: iso(NOW - (60 - n) * MINUTE + 1000),
					content: `답 ${n}`,
				})}\n`,
			);
		}
		const first = readAgyConversation(file);
		expect(first.turns.filter((t) => t.role === "user").map((t) => t.parts[0])).toEqual(
			Array.from({ length: 20 }, (_, i) => ({ kind: "text", text: `질문 ${i + 6}` })),
		);
		expect(first.cursor).toBe("s10");

		const rest = readAgyConversation(file, first.cursor);
		expect(rest.cursor).toBeUndefined();
		expect(rest.turns.filter((t) => t.role === "user").map((t) => t.parts[0])).toEqual([
			{ kind: "text", text: "질문 1" },
			{ kind: "text", text: "질문 2" },
			{ kind: "text", text: "질문 3" },
			{ kind: "text", text: "질문 4" },
			{ kind: "text", text: "질문 5" },
		]);
		expect(rest.turns).toHaveLength(10);
	});

	test("masks fake secrets and PII before truncation across all fields", () => {
		const file = join(root, "masked.jsonl");
		const token = "xoxb-TEST-0";
		const email = "owner@example.test";
		const phone = "010-1234-5678";
		const longSummary = `${"A".repeat(115)}${token}`;
		const longOutput = `${"B".repeat(3995)}${token}`;
		const entries = [
			{
				step_index: 0,
				type: "USER_INPUT",
				status: "DONE",
				created_at: iso(NOW - 2 * MINUTE),
				content: `<USER_REQUEST>질문 ${token} ${email} ${phone}</USER_REQUEST>`,
			},
			{
				step_index: 1,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				created_at: iso(NOW - MINUTE),
				thinking: `생각 ${token} ${phone}`,
				content: `답변 ${email}`,
				tool_calls: [{ name: `tool-${token}`, args: { toolSummary: longSummary } }],
			},
			{
				step_index: 2,
				type: "GENERIC",
				status: "DONE",
				created_at: iso(NOW - MINUTE + 1000),
				content: longOutput,
			},
		];
		writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));

		const result = readAgyConversation(file);
		const json = JSON.stringify(result);
		expect(json).not.toContain(token);
		expect(json).not.toContain("xoxb-TEST");
		expect(json).not.toContain(email);
		expect(json).not.toContain(phone);
		expect(json).toContain("[REDACTED]");
		expect(json).toContain("[PII]");
	});
});

describe("agy transcript path resolution & traversal guards", () => {
	test("resolves default prefix, custom appDataPrefix from config.json, and account-less antigravity-cli", () => {
		const geminiDir = join(root, "gemini");
		const homeDefault = join(root, "home-default");
		const sessDefault = join(homeDefault, "sessions", "s1");
		mkdirSync(sessDefault, { recursive: true });
		writeFileSync(
			join(sessDefault, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-12345678", account: "acct1" }),
		);
		const expectedDefault = writeTranscript(geminiDir, "antigravity-cli-acct-acct1", "conv-12345678", []);
		expect(agyTranscriptFile(sessDefault, homeDefault, { geminiDir })).toBe(expectedDefault);

		const homeCustom = join(root, "home-custom");
		const sessCustom = join(homeCustom, "sessions", "s1");
		mkdirSync(sessCustom, { recursive: true });
		writeFileSync(
			join(homeCustom, "config.json"),
			JSON.stringify({ agyAccounts: { dir: "/tmp/x", appDataPrefix: "custom-acct-" } }),
		);
		writeFileSync(
			join(sessCustom, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-22345678", account: "acct2" }),
		);
		const expectedCustom = writeTranscript(geminiDir, "custom-acct-acct2", "conv-22345678", []);
		expect(agyTranscriptFile(sessCustom, homeCustom, { geminiDir })).toBe(expectedCustom);

		const homeNoAcct = join(root, "home-no-acct");
		const sessNoAcct = join(homeNoAcct, "sessions", "s1");
		mkdirSync(sessNoAcct, { recursive: true });
		writeFileSync(join(sessNoAcct, "agy-conversation.json"), JSON.stringify({ conversationId: "conv-32345678" }));
		const expectedNoAcct = writeTranscript(geminiDir, "antigravity-cli", "conv-32345678", []);
		expect(agyTranscriptFile(sessNoAcct, homeNoAcct, { geminiDir })).toBe(expectedNoAcct);
	});

	test("rejects path traversal in conversationId, account, and appDataPrefix", () => {
		const geminiDir = join(root, "gemini");
		const home = join(root, "home-bad");
		const sess = join(home, "sessions", "s1");
		mkdirSync(sess, { recursive: true });

		writeFileSync(
			join(sess, "agy-conversation.json"),
			JSON.stringify({ conversationId: "../../etc/passwd", account: "ok" }),
		);
		expect(agyTranscriptFile(sess, home, { geminiDir })).toBeUndefined();

		writeFileSync(
			join(sess, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-12345678", account: "../evil" }),
		);
		expect(agyTranscriptFile(sess, home, { geminiDir })).toBeUndefined();

		writeFileSync(
			join(sess, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-12345678", account: "acct1" }),
		);
		writeTranscript(geminiDir, "antigravity-cli-acct-acct1", "conv-12345678", []);
		expect(agyTranscriptFile(sess, home, { geminiDir, appDataPrefix: "../bad-" })).toBeUndefined();

		writeFileSync(join(home, "config.json"), JSON.stringify({ agyAccounts: { appDataPrefix: "bad..prefix" } }));
		expect(agyTranscriptFile(sess, home, { geminiDir })).toBeUndefined();
	});
});

describe("peer routing for conversation and live", () => {
	test("routes peer agy and peer omp conversations, and handles unknown peer or missing db", async () => {
		const mainHome = join(root, "songbak");
		const peerAgy = join(root, "seopak");
		const peerOmp = join(root, "ttungi");
		const missingHome = join(root, "missing");
		const geminiDir = join(root, "gemini");

		const ORIGIN = "discord/ch/100/t/200";
		const agySess = join(peerAgy, "sessions", "o1");
		mkdirSync(agySess, { recursive: true });
		seedOrigin(peerAgy, ORIGIN, agySess);
		writeFileSync(
			join(agySess, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-abcd1234", account: "acc" }),
		);
		writeTranscript(geminiDir, "antigravity-cli-acct-acc", "conv-abcd1234", [
			{
				step_index: 0,
				type: "USER_INPUT",
				status: "DONE",
				created_at: iso(NOW - MINUTE),
				content: "<USER_REQUEST>서팍 질문</USER_REQUEST>",
			},
			{ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso(NOW), content: "서팍 답변" },
		]);

		const ompSess = join(peerOmp, "sessions", "o1");
		mkdirSync(ompSess, { recursive: true });
		seedOrigin(peerOmp, ORIGIN, ompSess);
		writeFileSync(
			join(ompSess, "s.jsonl"),
			[
				{
					type: "message",
					id: "u1",
					timestamp: iso(NOW - MINUTE),
					message: { role: "user", content: [{ type: "text", text: "뚱기 질문" }] },
				},
				{
					type: "message",
					id: "a1",
					timestamp: iso(NOW),
					message: { role: "assistant", content: [{ type: "text", text: "뚱기 답변" }] },
				},
			]
				.map((r) => `${JSON.stringify(r)}\n`)
				.join(""),
		);

		const peers = [
			{ name: "서팍", home: peerAgy },
			{ name: "뚱기", home: peerOmp },
			{ name: "없음", home: missingHome },
		];

		const seopakConv = readThreadConversation(mainHome, `서팍:${ORIGIN}`, undefined, { peers, geminiDir });
		expect(seopakConv.ok).toBe(true);
		if (seopakConv.ok) {
			expect(seopakConv.turns.map((t) => [t.role, t.parts[0]])).toEqual([
				["user", { kind: "text", text: "서팍 질문" }],
				["assistant", { kind: "text", text: "서팍 답변" }],
			]);
		}

		const ttungiConv = readThreadConversation(mainHome, `뚱기:${ORIGIN}`, undefined, { peers, geminiDir });
		expect(ttungiConv.ok).toBe(true);
		if (ttungiConv.ok) {
			expect(ttungiConv.turns.map((t) => [t.role, t.parts[0]])).toEqual([
				["user", { kind: "text", text: "뚱기 질문" }],
				["assistant", { kind: "text", text: "뚱기 답변" }],
			]);
		}

		expect(readThreadConversation(mainHome, `모르는봇:${ORIGIN}`, undefined, { peers, geminiDir })).toEqual({
			ok: false,
			error: "unknown_origin",
		});
		expect(readThreadConversation(mainHome, `없음:${ORIGIN}`, undefined, { peers, geminiDir })).toEqual({
			ok: false,
			error: "no_database",
		});

		const calls: Array<{ sock: string; req: unknown }> = [];
		const sampleLive: LiveView = {
			seq: 5,
			updatedAt: NOW,
			inboundId: "m1",
			text: "진행 중",
			thinking: "",
			toolCalls: [],
			running: [],
			done: [],
		};
		const ask = async (sock: string, req: unknown) => {
			calls.push({ sock, req });
			return { ok: true, live: sampleLive };
		};
		expect(await readThreadLive(mainHome, `서팍:${ORIGIN}`, ask, peers)).toEqual(sampleLive);
		expect(await readThreadLive(mainHome, ORIGIN, ask, peers)).toEqual(sampleLive);
		expect(await readThreadLive(mainHome, `모르는봇:${ORIGIN}`, ask, peers)).toBeNull();
		expect(calls).toEqual([
			{ sock: join(peerAgy, "jabbu.sock"), req: { op: "live", origin: ORIGIN } },
			{ sock: join(mainHome, "jabbu.sock"), req: { op: "live", origin: ORIGIN } },
		]);
		await expect(readThreadLive(mainHome, `서팍:${ORIGIN}`, async () => ({ ok: false }), peers)).rejects.toThrow(
			"daemon live op failed",
		);
	});

	test("HTTP dashboard server serves peer agy conversation and peer live over /api/thread/*", async () => {
		const mainHome = join(root, "songbak");
		const peerAgy = join(root, "seopak");
		const geminiDir = join(root, "gemini");
		const ORIGIN = "discord/ch/100/t/300";
		const agySess = join(peerAgy, "sessions", "o1");
		mkdirSync(agySess, { recursive: true });
		seedOrigin(peerAgy, ORIGIN, agySess);
		writeFileSync(
			join(agySess, "agy-conversation.json"),
			JSON.stringify({ conversationId: "conv-http1234", account: "acc" }),
		);
		writeTranscript(geminiDir, "antigravity-cli-acct-acc", "conv-http1234", [
			{
				step_index: 0,
				type: "USER_INPUT",
				status: "DONE",
				created_at: iso(NOW - MINUTE),
				content: "<USER_REQUEST>웹 확인</USER_REQUEST>",
			},
			{ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso(NOW), content: "웹 응답" },
		]);
		const peers = [{ name: "서팍", home: peerAgy }];
		const liveView: LiveView = {
			seq: 2,
			updatedAt: NOW,
			inboundId: "m2",
			text: "스트리밍",
			thinking: "",
			toolCalls: [],
			running: [],
			done: [],
		};
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			snapshot: async () => {
				throw new Error("unused");
			},
			conversation: (origin, before) => readThreadConversation(mainHome, origin, before, { peers, geminiDir }),
			live: (origin) => readThreadLive(mainHome, origin, async () => ({ ok: true, live: liveView }), peers),
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const convRes = await fetch(`${base}/api/thread/conversation?origin=${encodeURIComponent(`서팍:${ORIGIN}`)}`);
			expect(convRes.status).toBe(200);
			const convBody = (await convRes.json()) as { turns: Array<{ role: string; parts: Array<{ text?: string }> }> };
			expect(convBody.turns.map((t) => [t.role, t.parts[0]?.text])).toEqual([
				["user", "웹 확인"],
				["assistant", "웹 응답"],
			]);

			const liveRes = await fetch(`${base}/api/thread/live?origin=${encodeURIComponent(`서팍:${ORIGIN}`)}`);
			expect(liveRes.status).toBe(200);
			expect(await liveRes.json()).toEqual({ live: liveView });
		} finally {
			server.stop(true);
		}
	});
});
