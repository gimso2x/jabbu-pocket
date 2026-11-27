import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JabbuConfig } from "../src/config";
import { chatOriginKey } from "../src/core/origin-key";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { ApprovalBroker, type ApprovalStore } from "../src/safety/approval";
import { openStore } from "../src/store/db";
import { WebBinding } from "../src/web/binding";
import { renderCardElementHtml, renderWebMessageHtml } from "../src/web/card-html";
import { WebChannel } from "../src/web/channel";
import { notifyWebOwnerTurn } from "../src/web/notify";
import type { WebDashboardOptions } from "../src/web/routes";
import { WEB_UPLOAD_MAX_BYTES, webUploadRoot } from "../src/web/upload";
import { OWNER, OWNER_DM, WaitingDiscordTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeDiscordTransport } from "./helpers/discord-fake-transport";
import { daemonTestOptions } from "./helpers/disk";

class BrokenDiscordTransport extends FakeDiscordTransport {
	override async start(): Promise<never> {
		throw new Error("discord gateway down");
	}
}

const LOCAL_TOKEN = "w2-test-token";
const STUB_SNAPSHOT: DashboardSnapshot = {
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
};

let dirs: string[] = [];
let cleanups: Array<() => Promise<void> | void> = [];

function createHome(withDiscord = false): {
	dir: string;
	localTokenPath: string;
	botTokenFile: string;
	config: JabbuConfig;
} {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-web-w2-"));
	dirs.push(dir);
	chmodSync(dir, 0o700);
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { mode: 0o700 });
	const localTokenPath = join(stateDir, "web-local.token");
	writeFileSync(localTokenPath, `${LOCAL_TOKEN}\n`, { mode: 0o600 });
	const secretsDir = join(dir, "secrets");
	mkdirSync(secretsDir, { mode: 0o700 });
	const botTokenFile = join(secretsDir, "discord-bot-token");
	writeFileSync(botTokenFile, `${["TEST", "discord", "secret0"].join("-")}\n`, { mode: 0o600 });
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
			...(withDiscord ? { discord: { ownerUserId: OWNER, botTokenFile, applicationId: "600000000000000000" } } : {}),
			web: {
				enabled: true,
				ownerEmails: ["owner@example.com"],
				accessTeamDomain: "team.cloudflareaccess.com",
				accessAud: "aud-w2",
			},
		},
		dashboard: {
			port: 0,
			allowedHosts: ["ompbot.gimso2x.com"],
		},
		ompExecutable,
		workspaceDir,
		timezone: "Asia/Seoul",
	};
	writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
	return { dir, localTokenPath, botTokenFile, config };
}

function startWebServer(
	dir: string,
	localTokenPath: string,
	callDaemonFn: (req: unknown) => Promise<unknown>,
	options?: { snapshot?: () => Promise<DashboardSnapshot> },
): { baseUrl: string } {
	const web: WebDashboardOptions = {
		homeDir: dir,
		auth: {
			ownerEmails: ["owner@example.com"],
			accessTeamDomain: "team.cloudflareaccess.com",
			accessAud: "aud-w2",
			localTokenPath,
			csrfSecret: Buffer.from("0123456789abcdef0123456789abcdef"),
		},
		callDaemon: callDaemonFn,
	};
	const server = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		web,
		snapshot: options?.snapshot ?? (async () => STUB_SNAPSHOT),
	});
	cleanups.push(() => server.stop(true));
	return { baseUrl: `http://127.0.0.1:${server.port}` };
}

async function authAndCsrf(baseUrl: string): Promise<Record<string, string>> {
	const auth = { authorization: `Bearer ${LOCAL_TOKEN}` };
	const res = await fetch(`${baseUrl}/api/web/conversations`, { headers: auth });
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
	cleanups = [];
});

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("AC-6: /api/web/upload size cap, secret-path refusal, and IPC path-only forwarding", () => {
	test("valid upload writes 0600 file under media/inbound/web and web_send IPC carries path only", async () => {
		const home = createHome();
		const forwarded: unknown[] = [];
		const { baseUrl } = startWebServer(home.dir, home.localTokenPath, async (req) => {
			forwarded.push(req);
			return { ok: true, id: 1, conversation: "w_abcd1234", originKey: "web/dm/w_abcd1234" };
		});
		const postHeaders = await authAndCsrf(baseUrl);

		// Valid multipart upload
		const form = new FormData();
		const payloadText = "hello attachment payload";
		form.append("file", new File([payloadText], "report.txt", { type: "text/plain" }));
		const upRes = await fetch(`${baseUrl}/api/web/upload`, {
			method: "POST",
			headers: postHeaders,
			body: form,
		});
		expect(upRes.status).toBe(200);
		const upJson = (await upRes.json()) as {
			ok: true;
			path: string;
			files: Array<{ path: string; name: string; bytes: number }>;
		};
		expect(upJson.ok).toBe(true);
		expect(upJson.path.startsWith(webUploadRoot(home.dir))).toBe(true);
		expect(lstatSync(upJson.path).mode & 0o777).toBe(0o600);
		expect(readFileSync(upJson.path, "utf8")).toBe(payloadText);

		// Raw binary valid PNG upload
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
		const pngRes = await fetch(`${baseUrl}/api/web/upload`, {
			method: "POST",
			headers: { ...postHeaders, "content-type": "image/png", "x-filename": "shot.png" },
			body: pngBytes,
		});
		expect(pngRes.status).toBe(200);

		// Fake image magic rejected
		const badPng = await fetch(`${baseUrl}/api/web/upload`, {
			method: "POST",
			headers: { ...postHeaders, "content-type": "image/png", "x-filename": "fake.png" },
			body: new TextEncoder().encode("<html>not png</html>"),
		});
		expect(badPng.status).toBe(400);
		expect(await badPng.json()).toEqual({ error: "not_an_image" });

		// Send forwards path only (not raw payload)
		const sendRes = await fetch(`${baseUrl}/api/web/send`, {
			method: "POST",
			headers: { ...postHeaders, "content-type": "application/json" },
			body: JSON.stringify({ conversation: "w_abcd1234", text: "파일 확인", files: [upJson.path] }),
		});
		expect(sendRes.status).toBe(200);
		expect(forwarded).toEqual([
			{ op: "web_send", conversation: "w_abcd1234", thread: undefined, text: "파일 확인", files: [upJson.path] },
		]);
		expect(JSON.stringify(forwarded)).not.toContain(payloadText);
	});

	test("uploads over 25MB return 413 (header & streamed) with no residual files", async () => {
		const home = createHome();
		const { baseUrl } = startWebServer(home.dir, home.localTokenPath, async () => ({ ok: true }));
		const postHeaders = await authAndCsrf(baseUrl);

		// Oversized raw upload (25 MiB + 1)
		const overBytes = new Uint8Array(WEB_UPLOAD_MAX_BYTES + 1);
		const overRes = await fetch(`${baseUrl}/api/web/upload`, {
			method: "POST",
			headers: { ...postHeaders, "content-type": "application/octet-stream", "x-filename": "huge.bin" },
			body: overBytes,
		});
		expect(overRes.status).toBe(413);
		expect(await overRes.json()).toEqual({ error: "file_too_large" });

		// Streamed chunked multipart file slightly over 25 MiB
		const bigForm = new FormData();
		bigForm.append("file", new File([overBytes], "huge-form.bin", { type: "application/octet-stream" }));
		const bigFormRes = await fetch(`${baseUrl}/api/web/upload`, {
			method: "POST",
			headers: postHeaders,
			body: bigForm,
		});
		expect(bigFormRes.status).toBe(413);
		expect(await bigFormRes.json()).toEqual({ error: "file_too_large" });
		expect(readdirSync(webUploadRoot(home.dir))).toEqual([]);
	});

	test("upload and web_send IPC refuse secret directories, traversal, and symlinks", async () => {
		const home = createHome();
		const { baseUrl } = startWebServer(home.dir, home.localTokenPath, async () => ({ ok: true }));
		const postHeaders = await authAndCsrf(baseUrl);

		for (const badName of ["../secrets/token.txt", ".ssh/id_rsa", "/etc/passwd"]) {
			const res = await fetch(`${baseUrl}/api/web/upload`, {
				method: "POST",
				headers: { ...postHeaders, "content-type": "text/plain", "x-filename": badName },
				body: "bad",
			});
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: "forbidden_path" });
		}

		const dirForm = new FormData();
		dirForm.append("dir", join(home.dir, "secrets"));
		dirForm.append("file", new File(["x"], "ok.txt", { type: "text/plain" }));
		const dirRes = await fetch(`${baseUrl}/api/web/upload`, { method: "POST", headers: postHeaders, body: dirForm });
		expect(dirRes.status).toBe(403);

		// Boot daemon to test direct web_send IPC file path checks
		const clock = { now: () => Date.now() };
		const log = createLogger({ sink: () => undefined, clock, redact });
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			...daemonTestOptions(),
			config: home.config,
			channels: [new WebBinding()],
			log,
			clock,
			ompVersion: "omp-test 0",
			bootId: "boot-w2-sec",
			gateSweepMs: 0,
			taskSweepMs: 0,
			sweepMs: 3_600_000,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		cleanups.push(() => daemon.stop());
		await daemon.start();

		const { conversation } = (await callDaemon(daemon.socketPath, { op: "web_new", title: "sec" })) as {
			conversation: string;
		};
		mkdirSync(webUploadRoot(home.dir), { recursive: true, mode: 0o700 });
		const linkPath = join(webUploadRoot(home.dir), "leak-link.txt");
		symlinkSync(home.botTokenFile, linkPath);

		for (const badFile of [home.botTokenFile, linkPath, "../secrets/discord-bot-token", "/etc/hosts"]) {
			const ipcRes = (await callDaemon(daemon.socketPath, {
				op: "web_send",
				conversation,
				text: "read this",
				files: [badFile],
			})) as { ok: boolean; error?: string };
			expect(ipcRes).toEqual({ ok: false, error: "forbidden_file_path" });
		}
	});
});

describe("Spec §5 & AC-10: json-render HTML cards/charts and ?view=chat SSR + isolated assets", () => {
	test("renderWebMessageHtml renders Fields, Table, bar/line/area/pie SVG charts, escapes XSS, and keeps copy buttons", () => {
		const spec1 = {
			root: "root",
			elements: {
				root: {
					type: "Card",
					props: { title: "주간 리포트 <script>alert(1)</script>", subtitle: "요약", tone: "info" },
					children: ["f", "t", "cBar", "cLine", "lnk"],
				},
				f: { type: "Fields", props: {}, children: ["f1", "f2"] },
				f1: { type: "Field", props: { label: "성공", value: "42" }, children: [] },
				f2: { type: "Field", props: { label: "실패", value: "1" }, children: [] },
				t: {
					type: "Table",
					props: {
						headers: ["도구", "횟수"],
						rows: [
							["bash", "10"],
							["read", "7"],
						],
					},
					children: [],
				},
				cBar: {
					type: "Chart",
					props: {
						title: "일별 호출(막대)",
						chart: {
							type: "bar",
							categories: ["월", "화"],
							series: [{ name: "호출", values: [5, 9] }],
						},
					},
					children: [],
				},
				cLine: {
					type: "Chart",
					props: {
						title: "지연 추이(선)",
						chart: {
							type: "line",
							categories: ["1h", "2h"],
							series: [{ name: "p95", values: [120, 85] }],
						},
					},
					children: [],
				},
				lnk: { type: "Text", props: { content: "[문서](https://example.com/docs)" }, children: [] },
			},
		};
		const spec2 = {
			root: "root2",
			elements: {
				root2: {
					type: "Card",
					props: { title: "비용 및 모델 비중", tone: "ok" },
					children: ["cArea", "cPie"],
				},
				cArea: {
					type: "Chart",
					props: {
						title: "누적 비용(영역)",
						chart: {
							type: "area",
							categories: ["D1", "D2"],
							series: [{ name: "USD", values: [1.5, 2.8] }],
						},
					},
					children: [],
				},
				cPie: {
					type: "Chart",
					props: {
						title: "모델 비중(원)",
						chart: {
							type: "pie",
							segments: [
								{ label: "sonnet", value: 70 },
								{ label: "flash", value: 30 },
							],
						},
					},
					children: [],
				},
			},
		};
		const md = [
			"결론 요약입니다.",
			"",
			"```card",
			JSON.stringify(spec1),
			"```",
			"",
			"```card",
			JSON.stringify(spec2),
			"```",
			"",
			"```card",
			"{not-valid-json",
			"```",
			"",
			"```copy",
			"bun run check",
			"```",
		].join("\n");

		const html = renderWebMessageHtml({ role: "assistant", text: md, cardJson: null, filesJson: null });
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("wc-tone-info");
		expect(html).toContain("<table>");
		expect(html).toContain("<rect ");
		expect(html).toContain("<polyline ");
		expect(html).toContain("<polygon ");
		expect(html).toContain("<path ");
		expect(html).toContain('data-copy="bun run check"');
		expect(html).toContain("{not-valid-json");
		expect(html).toContain("https://example.com/docs");

		const tableHtml = renderCardElementHtml({
			type: "card",
			children: [
				{
					type: "table",
					headers: ["A", "B", "C"],
					rows: [["1", "2", "3"]],
					align: ["center", "right;background:red" as "left", "right"],
				},
			],
		});
		expect(tableHtml).toContain('style="text-align:center"');
		expect(tableHtml).toContain('style="text-align:left"');
		expect(tableHtml).toContain('style="text-align:right"');
		expect(tableHtml).not.toContain("background:red");

		const malformedCard = renderWebMessageHtml({
			role: "assistant",
			text: "fallback",
			cardJson: JSON.stringify({
				kind: "approval",
				title: "승인",
				fields: [null, { label: 123, value: "bad" }, { label: "유효", value: "값" }],
			}),
			filesJson: null,
		});
		expect(malformedCard).toContain("<dt>유효</dt><dd>값</dd>");
		expect(malformedCard).not.toContain("123");
	});

	test("?view=chat is served without building a snapshot; a plain page builds one", async () => {
		const home = createHome();
		const store = openStore({
			path: join(home.dir, "jabbu.db"),
			timezone: "Asia/Seoul",
			clock: { now: () => 1_000 },
			redact,
		});
		store.web.insert({
			conversation: "w_nochat01",
			role: "system",
			text: "화면 점검",
			cardJson: JSON.stringify({ kind: "conversation", title: "화면 점검" }),
		});
		store.close();
		let snapshotCalls = 0;
		const { baseUrl } = startWebServer(home.dir, home.localTokenPath, async () => ({ ok: true }), {
			snapshot: async () => {
				snapshotCalls += 1;
				return STUB_SNAPSHOT;
			},
		});
		const authHeaders = { authorization: `Bearer ${LOCAL_TOKEN}` };
		const chatRes = await fetch(`${baseUrl}/?view=chat&c=w_nochat01`, { headers: authHeaders });
		expect(chatRes.status).toBe(200);
		expect(snapshotCalls).toBe(0);
		const plainRes = await fetch(`${baseUrl}/`, { headers: authHeaders });
		expect(plainRes.status).toBe(200);
		expect(snapshotCalls).toBe(1);
	});

	test("?view=chat serves isolated chat assets, SSR messages, CSRF meta, and conversation inProgress status", async () => {
		const home = createHome();
		const store = openStore({
			path: join(home.dir, "jabbu.db"),
			timezone: "Asia/Seoul",
			clock: { now: () => 1_000 },
			redact,
		});
		const conv = "w_viewtest01";
		store.web.insert({
			conversation: conv,
			role: "system",
			text: "화면 점검",
			cardJson: JSON.stringify({ kind: "conversation", title: "화면 점검" }),
		});
		const statusRow = store.web.insert({
			conversation: conv,
			role: "status",
			text: "⏳ 작업 중 · 1s",
			cardJson: JSON.stringify({ kind: "status", deleted: false }),
		});
		store.web.insert({
			conversation: conv,
			role: "assistant",
			text: "완료",
		});
		store.close();

		const { baseUrl } = startWebServer(home.dir, home.localTokenPath, async () => ({ ok: true }));
		const authHeaders = { authorization: `Bearer ${LOCAL_TOKEN}` };

		const convRes = await fetch(`${baseUrl}/api/web/conversations`, { headers: authHeaders });
		const convData = (await convRes.json()) as { conversations: Array<{ inProgress: boolean }> };
		expect(convData.conversations[0]?.inProgress).toBe(true);

		const pageRes = await fetch(`${baseUrl}/?view=chat&c=${conv}`, { headers: authHeaders });
		expect(pageRes.status).toBe(200);
		expect(pageRes.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
		const html = await pageRes.text();
		expect(html).toContain('<meta name="jabbu-csrf"');
		expect(html).toContain("화면 점검");
		const cssMatch = /href="(chat-[0-9a-f]{12}\.css)"/.exec(html);
		const jsMatch = /src="(chat-[0-9a-f]{12}\.js)"/.exec(html);
		expect(cssMatch?.[1]).toBeDefined();
		expect(jsMatch?.[1]).toBeDefined();
		expect(html).not.toContain("app-");

		const cssRes = await fetch(`${baseUrl}/${cssMatch?.[1]}`);
		expect(cssRes.status).toBe(200);
		expect(await cssRes.text()).toContain("min-height: 44px");
		const jsRes = await fetch(`${baseUrl}/${jsMatch?.[1]}`);
		expect(jsRes.status).toBe(200);
		expect(await jsRes.text()).toContain("api/web/upload");

		expect((await fetch(`${baseUrl}/chat-000000000000.css`)).status).toBe(404);

		// Soft-delete status -> inProgress flips to false
		const store2 = openStore({
			path: join(home.dir, "jabbu.db"),
			timezone: "Asia/Seoul",
			clock: { now: () => 2_000 },
			redact,
		});
		store2.web.edit(statusRow.id, { text: "", cardJson: JSON.stringify({ kind: "status", deleted: true }) });
		store2.close();
		const convAfter = (await (await fetch(`${baseUrl}/api/web/conversations`, { headers: authHeaders })).json()) as {
			conversations: Array<{ inProgress: boolean }>;
		};
		expect(convAfter.conversations[0]?.inProgress).toBe(false);
	});
});

describe("Spec §6: Discord DM notification when web conversation awaits owner approval or choice", () => {
	test("web approval card sends a one-line Discord DM with link, and missing/down Discord never blocks web", async () => {
		const home = createHome(true);
		const transport = new WaitingDiscordTransport();
		const logs: string[] = [];
		const logWaiters = new Set<() => void>();
		const clock = { now: () => 1_700_000_000_000 };
		const log = createLogger({
			sink: (line) => {
				logs.push(line);
				for (const wake of [...logWaiters]) wake();
			},
			clock,
			redact,
		});
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			...daemonTestOptions(),
			config: home.config,
			channels: [new DiscordBinding(new DiscordChannel(transport, { ownerUserId: OWNER })), new WebBinding()],
			log,
			clock,
			ompVersion: "omp-test 0",
			bootId: "boot-w2-notify",
			gateSweepMs: 0,
			taskSweepMs: 0,
			sweepMs: 3_600_000,
			stopDrainMs: 250,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true }),
		});
		cleanups.push(() => daemon.stop());
		await daemon.start();
		// Seed owner's Discord DM origin so `store.ownerDmOrigin("discord")` resolves.
		daemon.store.ensureOrigin(`discord/dm/${OWNER_DM}`, `discord-dm-${OWNER_DM}`);

		const { conversation } = (await callDaemon(daemon.socketPath, { op: "web_new", title: "알림 테스트" })) as {
			conversation: string;
		};
		const originKey = chatOriginKey({ platform: "web", kind: "dm", conversationId: conversation });
		await callDaemon(daemon.socketPath, { op: "web_send", conversation, text: "배포 확인" });

		const tool = daemon.hostToolsFor(originKey).find((t) => t.name === "jabbu_request_approval");
		if (!tool) throw new Error("jabbu_request_approval missing");
		const pendingApproval = tool.execute({ summary: "prod deploy" }, { signal: new AbortController().signal });
		await transport.waitForPosts((text) => text.includes("웹 대화 승인 대기"));

		const dmPosts = transport.posts((text) => text.includes("웹 대화 승인 대기"));
		expect(dmPosts).toHaveLength(1);
		expect(dmPosts[0]?.channelId).toBe(OWNER_DM);
		expect(dmPosts[0]?.content).toContain("prod deploy");
		expect(dmPosts[0]?.content).toContain(`https://ompbot.gimso2x.com/?view=chat&c=${conversation}`);

		// Choice card notification via broker + notifyWebOwnerTurn callback
		const store = openStore({
			path: join(home.dir, "choice-notify.db"),
			timezone: "Asia/Seoul",
			clock,
			redact,
		});
		cleanups.push(() => store.close());
		store.ensureOrigin(`discord/dm/${OWNER_DM}`, "dm-sess");
		const webChannel = new WebChannel();
		webChannel.attach(store.web);
		const discordChannel = new DiscordChannel(transport, { ownerUserId: OWNER });
		const fakeCtx = {
			options: { config: home.config },
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
		const broker = new ApprovalBroker({
			channels: registryOf(webChannel, discordChannel),
			ownerUserId: OWNER,
			platformOwners: { discord: OWNER, web: "web:owner" },
			log,
			store: store as unknown as ApprovalStore,
			clock,
			timezone: "Asia/Seoul",
			onOwnerTurn: (info) => notifyWebOwnerTurn(fakeCtx, info),
		});
		const choiceHandle = await broker.choose(
			{ originKey, channel: conversation },
			{ text: "❓ 진행 방식을 고르세요", buttons: ["바로 배포", "취소"], fallback: "취소" },
		);
		await transport.waitForPosts((text) => text.includes("웹 대화 질문 대기"));
		const choiceDm = transport.posts((text) => text.includes("웹 대화 질문 대기"));
		expect(choiceDm[0]?.content).toContain(`https://ompbot.gimso2x.com/?view=chat&c=${conversation}`);
		await choiceHandle.close("선택됨", "완료");

		// Cleanly reject held approval before shutdown
		const approvalRow = daemon.store.web.listMessages(conversation).find((m) => m.role === "approval");
		const denyBtn = JSON.parse(approvalRow?.buttonsJson ?? "[]").find((b: { actionId: string }) =>
			b.actionId.includes(":deny:"),
		);
		await callDaemon(daemon.socketPath, {
			op: "web_action",
			actionId: denyBtn.actionId,
			messageId: String(approvalRow?.id),
		});
		await pendingApproval;

		// Broken Discord still skips cleanly without failing web turn
		const webOnlyHome = createHome(true);
		const brokenDaemon = new Daemon({
			...daemonTestOptions(),
			config: webOnlyHome.config,
			channels: [
				new DiscordBinding(new DiscordChannel(new BrokenDiscordTransport(), { ownerUserId: OWNER })),
				new WebBinding(),
			],
			log,
			clock,
			ompVersion: "omp-test 0",
			bootId: "boot-w2-broken",
			gateSweepMs: 0,
			taskSweepMs: 0,
			sweepMs: 3_600_000,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		cleanups.push(() => brokenDaemon.stop());
		await brokenDaemon.start();
		const brokenConv = (await callDaemon(brokenDaemon.socketPath, { op: "web_new", title: "단절" })) as {
			conversation: string;
		};
		const brokenOrigin = chatOriginKey({ platform: "web", kind: "dm", conversationId: brokenConv.conversation });
		const brokenTool = brokenDaemon.hostToolsFor(brokenOrigin).find((t) => t.name === "jabbu_request_approval");
		if (!brokenTool) throw new Error("jabbu_request_approval missing");
		const brokenPending = brokenTool.execute({ summary: "offline ok" }, { signal: new AbortController().signal });
		const untilApproval = () =>
			new Promise<void>((resolve) => {
				const check = () => {
					if (!logs.some((l) => l.includes("web_notify_skipped") && l.includes(brokenConv.conversation))) return;
					logWaiters.delete(check);
					resolve();
				};
				logWaiters.add(check);
				check();
			});
		await untilApproval();
		const row2 = brokenDaemon.store.web.listMessages(brokenConv.conversation).find((m) => m.role === "approval");
		const deny2 = JSON.parse(row2?.buttonsJson ?? "[]")[0];
		await callDaemon(brokenDaemon.socketPath, {
			op: "web_action",
			actionId: deny2.actionId,
			messageId: String(row2?.id),
		});
		await brokenPending;
	});
});
