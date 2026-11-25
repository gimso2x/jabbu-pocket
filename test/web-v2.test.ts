import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import { chatOriginKey, GRAMMAR } from "../src/core/origin-key";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import {
	parentMessageIdOfThread,
	readWebConversations,
	readWebMessages,
	readWebThreads,
	threadIdForMessage,
	type WebMessageRow,
} from "../src/store/web-messages";
import { WebBinding } from "../src/web/binding";
import { resolveWebBots } from "../src/web/bots";
import { notifyWebOwnerTurn } from "../src/web/notify";
import { type WebDashboardOptions, webDashboardOptionsFor } from "../src/web/routes";
import { webUploadRoot } from "../src/web/upload";
import { OWNER, OWNER_DM, WaitingDiscordTransport } from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const LOCAL_TOKEN = "v2-test-token";
const STUB_SNAPSHOT: DashboardSnapshot = {
	generatedAt: "2026-11-25T22:30:00+09:00",
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
};

const VALID_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
	0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
	0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let dirs: string[] = [];
let stops: Array<() => Promise<void> | void> = [];

function createBotHome(
	prefix: string,
	displayName: string,
	opts: {
		webEnabled?: boolean;
		withDiscord?: boolean;
		peerHomes?: Array<{ name: string; home: string }>;
		corruptConfig?: boolean;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "jabbu-web-v2-"));
	dirs.push(root);
	const dir = join(root, prefix);
	mkdirSync(dir, { mode: 0o700 });
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { mode: 0o700 });
	const localTokenPath = join(stateDir, "web-local.token");
	writeFileSync(localTokenPath, `${LOCAL_TOKEN}\n`, { mode: 0o600 });
	const secretsDir = join(dir, "secrets");
	mkdirSync(secretsDir, { mode: 0o700 });
	const botTokenFile = join(secretsDir, "discord-bot-token");
	writeFileSync(botTokenFile, `${["TEST", "discord", "v2"].join("-")}\n`, { mode: 0o600 });
	const ompExecutable = join(dir, "fake-omp");
	writeFileSync(ompExecutable, '#!/bin/sh\necho "omp/0.0.0-stub"\n', { mode: 0o755 });
	const workspaceDir = join(dir, "workspace");
	mkdirSync(workspaceDir, { mode: 0o700 });
	const configPath = join(dir, "config.json");
	const config: JabbuConfig = {
		schemaVersion: 1,
		homeDir: dir,
		configPath,
		channels: {
			...(opts.withDiscord === false
				? {}
				: {
						discord: {
							ownerUserId: OWNER,
							botTokenFile,
							applicationId: "600000000000000000",
							displayName,
						},
					}),
			...(opts.webEnabled === false
				? {}
				: {
						web: {
							enabled: true,
							ownerEmails: ["owner@example.com"],
							accessTeamDomain: "team.cloudflareaccess.com",
							accessAud: "aud-v2",
						},
					}),
		},
		dashboard: {
			port: 7331,
			allowedHosts: ["ompbot.gimso2x.com"],
			...(opts.peerHomes === undefined ? {} : { peerHomes: opts.peerHomes }),
		},
		ompExecutable,
		workspaceDir,
		timezone: "Asia/Seoul",
	};
	if (opts.corruptConfig) {
		writeFileSync(configPath, "{broken-json", { mode: 0o600 });
	} else {
		const rawJson: Record<string, unknown> = {
			schemaVersion: 1,
			ompExecutable,
			workspaceDir,
			timezone: "Asia/Seoul",
			channels: config.channels,
			dashboard: config.dashboard,
		};
		writeFileSync(configPath, JSON.stringify(rawJson), { mode: 0o600 });
	}
	chmodSync(dir, 0o700);
	return { dir, localTokenPath, botTokenFile, config };
}

function bootTestDaemon(config: JabbuConfig, respond: (prompt: string) => string) {
	const logs: string[] = [];
	const waiters = new Set<() => void>();
	const clock = { now: () => Date.now() };
	const log = createLogger({
		sink: (line) => {
			logs.push(line);
			for (const wake of [...waiters]) wake();
		},
		clock,
		redact,
	});
	const sessions = new FakeSessionStore();
	const daemon = new Daemon({
		...daemonTestOptions(),
		config,
		channels: [new WebBinding()],
		log,
		clock,
		ompVersion: "omp-test 0",
		bootId: `boot-${Math.random().toString(36).slice(2, 8)}`,
		gateSweepMs: 0,
		taskSweepMs: 0,
		sweepMs: 3_600_000,
		stopDrainMs: 250,
		driverFactory: (_origin, sessionDir) =>
			new FakeOmpDriver({
				sessionDir,
				store: sessions,
				respond,
			}),
	});
	const untilLogCount = (pattern: string, count: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const check = () => {
			if (logs.filter((line) => line.includes(pattern)).length < count) return;
			waiters.delete(check);
			resolve();
		};
		waiters.add(check);
		check();
		return promise;
	};
	return { daemon, logs, untilLog: (pattern: string) => untilLogCount(pattern, 1), untilLogCount };
}

async function initCsrf(baseUrl: string, botId?: string): Promise<Record<string, string>> {
	const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
	const q = botId ? `?bot=${encodeURIComponent(botId)}` : "";
	const res = await fetch(`${baseUrl}/api/web/conversations${q}`, { headers: auth });
	expect(res.status).toBe(200);
	const csrf = res.headers.get("x-jabbu-csrf") ?? "";
	return {
		...auth,
		"sec-fetch-site": "same-origin",
		cookie: `jabbu_csrf=${csrf}`,
		"x-jabbu-csrf": csrf,
	};
}

beforeEach(() => {
	dirs = [];
	stops = [];
});

afterEach(async () => {
	while (stops.length > 0) await stops.pop()?.();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("web channel v2: multi-bot routing, threads, file serve, and 3-pane Hide UI", () => {
	test("resolveWebBots skips peers without web enabled or invalid config and collects active bots", () => {
		const songbak = createBotHome(".jabbu-songbak", "송박");
		const seopak = createBotHome(".jabbu-seopak", "서팍", { webEnabled: true });
		const offPeer = createBotHome(".jabbu-off", "꺼짐", { webEnabled: false });
		const brokenPeer = createBotHome(".jabbu-broken", "깨짐", { corruptConfig: true });

		songbak.config.dashboard = {
			port: 0,
			peerHomes: [
				{ name: "서팍", home: seopak.dir },
				{ name: "꺼짐", home: offPeer.dir },
				{ name: "깨짐", home: brokenPeer.dir },
				{ name: "없음", home: join(songbak.dir, "missing") },
			],
		};
		const bots = resolveWebBots(songbak.dir, songbak.config, async () => ({ ok: true }));
		expect(bots.map((b) => [b.id, b.name])).toEqual([
			["songbak", "송박"],
			["seopak", "서팍"],
		]);

		const opts = webDashboardOptionsFor(
			songbak.dir,
			songbak.config.channels.web,
			async () => ({ ok: true }),
			songbak.config,
		);
		expect(opts?.bots?.map((b) => b.id)).toEqual(["songbak", "seopak"]);
	});

	test("multi-bot conversations/uploads/messages stay isolated per ?bot=<id> and reject unknown bots", async () => {
		const seopak = createBotHome(".jabbu-seopak", "서팍");
		const songbak = createBotHome(".jabbu-songbak", "송박", {
			peerHomes: [{ name: "서팍", home: seopak.dir }],
		});
		const dMain = bootTestDaemon(songbak.config, (p) => `SONGBOK:${p}`);
		const dSeo = bootTestDaemon(seopak.config, (p) => `SEOPAK:${p}`);
		stops.push(() => dMain.daemon.stop());
		stops.push(() => dSeo.daemon.stop());
		await dMain.daemon.start();
		await dSeo.daemon.start();

		const web = webDashboardOptionsFor(songbak.dir, songbak.config.channels.web, callDaemon, songbak.config);
		if (!web) throw new Error("web options expected");
		web.auth.csrfSecret = Buffer.from("11112222333344445555666677778888");
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
			web,
			snapshot: async () => STUB_SNAPSHOT,
		});
		stops.push(() => server.stop(true));
		const baseUrl = `http://127.0.0.1:${server.port}`;
		const postHdr = await initCsrf(baseUrl);
		const jsonHdr = { ...postHdr, "content-type": "application/json" };

		// Create & send in seopak
		const seoNew = (await (
			await fetch(`${baseUrl}/api/web/new`, {
				method: "POST",
				headers: jsonHdr,
				body: JSON.stringify({ bot: "seopak", title: "서팍 검토방" }),
			})
		).json()) as { conversation: string };

		const form = new FormData();
		form.append("file", new File([VALID_PNG], "shot.png", { type: "image/png" }));
		const upRes = await fetch(`${baseUrl}/api/web/upload?bot=seopak`, { method: "POST", headers: postHdr, body: form });
		expect(upRes.status).toBe(200);
		const upJson = (await upRes.json()) as { path: string };
		expect(upJson.path.startsWith(webUploadRoot(seopak.dir))).toBe(true);
		expect(existsSync(upJson.path)).toBe(true);

		const seoDelivered = dSeo.untilLog("event=delivery_sent");
		const sendSeo = await fetch(`${baseUrl}/api/web/send`, {
			method: "POST",
			headers: jsonHdr,
			body: JSON.stringify({
				bot: "seopak",
				conversation: seoNew.conversation,
				text: "검토 부탁",
				files: [upJson.path],
			}),
		});
		expect(sendSeo.status).toBe(200);
		await seoDelivered;

		// Seopak messages live only in seopak store, songbak stays empty
		expect(readWebConversations(songbak.dir)).toHaveLength(0);
		expect(readWebConversations(seopak.dir)).toHaveLength(1);

		const listSeo = (await (
			await fetch(`${baseUrl}/api/web/conversations?bot=seopak`, {
				headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
			})
		).json()) as {
			bot: string;
			bots: Array<{ id: string; conversationCount: number }>;
			conversations: Array<{ conversation: string; title: string }>;
		};
		expect(listSeo.bot).toBe("seopak");
		expect(listSeo.bots).toMatchObject([
			{ id: "songbak", conversationCount: 0 },
			{ id: "seopak", conversationCount: 1 },
		]);
		expect(listSeo.conversations[0]?.title).toBe("서팍 검토방");

		// Invalid bot ID refused with 400
		const badGet = await fetch(`${baseUrl}/api/web/conversations?bot=unknown`, {
			headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
		});
		expect(badGet.status).toBe(400);
		expect(await badGet.json()).toEqual({ error: "invalid_bot" });

		// File serve: PNG inline for authenticated request, 401 when unauthenticated
		const seoMsgs = (await (
			await fetch(`${baseUrl}/api/web/messages?bot=seopak&c=${seoNew.conversation}`, {
				headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
			})
		).json()) as { messages: Array<WebMessageRow & { html: string }> };
		const ownerImgMsg = seoMsgs.messages.find((m) => m.role === "owner");
		expect(ownerImgMsg?.html).toContain('class="wc-img-thumb"');
		expect(ownerImgMsg?.html).toContain(`api/web/file?bot=seopak&amp;msg=${ownerImgMsg?.id}&amp;i=0`);

		const unauthFile = await fetch(`${baseUrl}/api/web/file?bot=seopak&msg=${ownerImgMsg?.id}&i=0`);
		expect(unauthFile.status).toBe(401);

		const okFile = await fetch(`${baseUrl}/api/web/file?bot=seopak&msg=${ownerImgMsg?.id}&i=0`, {
			headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
		});
		expect(okFile.status).toBe(200);
		expect(okFile.headers.get("content-type")).toBe("image/png");
		expect(okFile.headers.get("content-disposition")).toContain("inline;");
		expect(new Uint8Array(await okFile.arrayBuffer())).toEqual(VALID_PNG);
	});

	test("threads isolate messages, preserve root title, count approvals, and refuse unsafe file paths", async () => {
		const songbak = createBotHome(".jabbu-songbak", "송박");
		const dMain = bootTestDaemon(songbak.config, (p) => `REPLY:${p}`);
		stops.push(() => dMain.daemon.stop());
		await dMain.daemon.start();

		const web: WebDashboardOptions = {
			homeDir: songbak.dir,
			botName: "송박",
			auth: {
				ownerEmails: ["owner@example.com"],
				accessTeamDomain: "team.cloudflareaccess.com",
				accessAud: "aud-v2",
				localTokenPath: songbak.localTokenPath,
				csrfSecret: Buffer.from("99998888777766665555444433332222"),
			},
			callDaemon: (req) => callDaemon(dMain.daemon.socketPath, req, 5_000),
		};
		const server = startDashboardServer({ port: 0, hostname: "127.0.0.1", web, snapshot: async () => STUB_SNAPSHOT });
		stops.push(() => server.stop(true));
		const baseUrl = `http://127.0.0.1:${server.port}`;
		const postHdr = await initCsrf(baseUrl);
		const jsonHdr = { ...postHdr, "content-type": "application/json" };

		const created = (await (
			await fetch(`${baseUrl}/api/web/new`, {
				method: "POST",
				headers: jsonHdr,
				body: JSON.stringify({ title: "메인 방" }),
			})
		).json()) as { conversation: string };
		const conv = created.conversation;

		const rootDone = dMain.untilLog("event=delivery_sent");
		await fetch(`${baseUrl}/api/web/send`, {
			method: "POST",
			headers: jsonHdr,
			body: JSON.stringify({ conversation: conv, text: "루트 질문" }),
		});
		await rootDone;

		const rootRows = readWebMessages(songbak.dir, conv);
		const rootAssistant = rootRows.find((r) => r.role === "assistant");
		if (!rootAssistant) throw new Error("root assistant row missing");
		const threadId = threadIdForMessage(rootAssistant.id);
		expect(GRAMMAR.web.thread.test(threadId)).toBe(true);
		expect(parentMessageIdOfThread(threadId)).toBe(rootAssistant.id);

		// Post inside thread
		const prevDeliveries = dMain.logs.filter((l) => l.includes("event=delivery_sent")).length;
		const threadDone = dMain.untilLogCount("event=delivery_sent", prevDeliveries + 1);
		const threadSendRes = await fetch(`${baseUrl}/api/web/send`, {
			method: "POST",
			headers: jsonHdr,
			body: JSON.stringify({ conversation: conv, thread: threadId, text: "스레드 후속 질문" }),
		});
		expect(threadSendRes.status).toBe(200);
		await threadDone;

		// Root list stays clean, thread messages stay separate, conversation title unchanged
		const convSummary = readWebConversations(songbak.dir).find((c) => c.conversation === conv);
		expect(convSummary?.title).toBe("메인 방");
		expect(convSummary?.threadCount).toBe(1);

		const threadSummaries = readWebThreads(songbak.dir, conv);
		expect(threadSummaries).toHaveLength(1);
		expect(threadSummaries[0]).toMatchObject({ thread: threadId, parentMessageId: rootAssistant.id, replyCount: 2 });

		const rootMsgApi = (await (
			await fetch(`${baseUrl}/api/web/messages?c=${conv}`, { headers: { authorization: `Bearer ${LOCAL_TOKEN}` } })
		).json()) as { messages: WebMessageRow[]; threads: Array<{ thread: string }> };
		expect(rootMsgApi.messages.some((m) => m.thread !== null)).toBe(false);
		expect(rootMsgApi.threads[0]?.thread).toBe(threadId);

		const threadMsgApi = (await (
			await fetch(`${baseUrl}/api/web/messages?c=${conv}&t=${threadId}`, {
				headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
			})
		).json()) as { messages: WebMessageRow[] };
		expect(threadMsgApi.messages.some((m) => m.role === "owner" && m.text === "스레드 후속 질문")).toBe(true);
		expect(threadMsgApi.messages.some((m) => m.role === "assistant" && m.text.includes("REPLY:스레드 후속 질문"))).toBe(
			true,
		);

		// Upload non-image txt and verify attachment disposition, plus unsafe path refusal in /api/web/file
		const txtForm = new FormData();
		txtForm.append("file", new File(["plain log"], "notes.txt", { type: "text/plain" }));
		const txtUp = (await (
			await fetch(`${baseUrl}/api/web/upload`, { method: "POST", headers: postHdr, body: txtForm })
		).json()) as { path: string };
		const txtRow = dMain.daemon.store.web.insert({
			conversation: conv,
			role: "owner",
			text: "문서",
			filesJson: JSON.stringify([{ path: txtUp.path, name: "notes.txt" }]),
		});
		const txtDownload = await fetch(`${baseUrl}/api/web/file?msg=${txtRow.id}&i=0`, {
			headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
		});
		expect(txtDownload.status).toBe(200);
		expect(txtDownload.headers.get("content-type")).toBe("application/octet-stream");
		expect(txtDownload.headers.get("content-disposition")).toContain("attachment;");

		mkdirSync(webUploadRoot(songbak.dir), { recursive: true, mode: 0o700 });
		const symPath = join(webUploadRoot(songbak.dir), "sym-leak.txt");
		symlinkSync(songbak.botTokenFile, symPath);
		for (const unsafePath of [songbak.botTokenFile, symPath, "/etc/hosts"]) {
			const badRow = dMain.daemon.store.web.insert({
				conversation: conv,
				role: "assistant",
				text: "위험",
				filesJson: JSON.stringify([{ path: unsafePath, name: "bad.txt" }]),
			});
			const blocked = await fetch(`${baseUrl}/api/web/file?msg=${badRow.id}&i=0`, {
				headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
			});
			expect(blocked.status).toBe(403);
			expect(await blocked.json()).toEqual({ error: "forbidden_file_path" });
		}

		// ?view=chat 3-pane SSR with open thread renders Hide groups, 3-pane layout, parent quote, and no "app-"
		const pageRes = await fetch(`${baseUrl}/?view=chat&c=${conv}&t=${threadId}`, {
			headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
		});
		expect(pageRes.status).toBe(200);
		const html = await pageRes.text();
		expect(html).toContain('class="wc-body has-thread"');
		expect(html).toContain("#송박");
		expect(html).toContain("최근 대화");
		expect(html).toContain("REPLY:루트 질문");
		expect(html).toContain("REPLY:스레드 후속 질문");
		expect(html).toContain('id="wc-pal-modal"');
		expect(html).not.toContain("app-");
	});

	test("notifyWebOwnerTurn includes thread (&t=) and bot (&bot=) deep links in Discord DM", async () => {
		const seopak = createBotHome(".jabbu-seopak", "서팍");
		const transport = new WaitingDiscordTransport();
		const store = openStore({
			path: join(seopak.dir, "jabbu.db"),
			timezone: "Asia/Seoul",
			clock: { now: () => 1_700_000_000_000 },
			redact,
		});
		stops.push(() => store.close());
		store.ensureOrigin(`discord/dm/${OWNER_DM}`, "dm-sess");
		const discordChannel = new DiscordChannel(transport, { ownerUserId: OWNER });
		const log = createLogger({ sink: () => undefined, clock: { now: () => 1_700_000_000_000 }, redact });
		const fakeCtx = {
			options: { config: seopak.config },
			log,
			store,
			adapters: new Map([
				[
					"discord",
					{
						connectionState: () => ({ state: "up" as const, since: 1 }),
						postNotice: async (ch: string, text: string) => {
							await discordChannel.post({ conversationId: ch }, { text });
							return true;
						},
					},
				],
			]),
		} as unknown as Parameters<typeof notifyWebOwnerTurn>[0];

		const conv = "w_threadlink1";
		const thread = "w_m0000012";
		notifyWebOwnerTurn(fakeCtx, {
			kind: "approval",
			channel: conv,
			messageId: "15",
			summary: "스레드 승인",
			originKey: chatOriginKey({ platform: "web", kind: "dm", conversationId: conv, threadId: thread }),
		});
		await transport.waitForPosts((text) => text.includes("스레드 승인"));
		const dm = transport.posts((text) => text.includes("스레드 승인"))[0];
		expect(dm?.content).toContain(`https://ompbot.gimso2x.com/?view=chat&c=${conv}&t=${thread}&bot=seopak`);
	});
});
