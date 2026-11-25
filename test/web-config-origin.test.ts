import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, primaryOwnerUserId, WEB_OWNER_USER_ID } from "../src/config";
import { chatOriginKey, GRAMMAR, parseChatOrigin, platformOfConversationId } from "../src/core/origin-key";
import { Daemon } from "../src/daemon/daemon";
import { callDaemon } from "../src/daemon/ipc";
import { channelBindings } from "../src/daemon/run";
import { WEB_LANE_REFUSED } from "../src/daemon/thread-target";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import { readWebMessages } from "../src/store/web-messages";
import { daemonTestOptions } from "./helpers/disk";

let home = "";
const cleanups: Array<() => Promise<void> | void> = [];

function createWebHome(webConfig: unknown): {
	dir: string;
	ompExecutable: string;
	workspaceDir: string;
	configPath: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-web-cfg-"));
	chmodSync(dir, 0o700);
	const ompExecutable = join(dir, "fake-omp");
	writeFileSync(ompExecutable, '#!/bin/sh\necho "omp/0.0.0-stub"\n', { mode: 0o755 });
	const workspaceDir = join(dir, "workspace");
	mkdirSync(workspaceDir, { mode: 0o700 });
	const configPath = join(dir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			schemaVersion: 1,
			channels: webConfig === undefined ? {} : { web: webConfig },
			ompExecutable,
			workspaceDir: "workspace",
			timezone: "Asia/Seoul",
		}),
		{ mode: 0o600 },
	);
	home = dir;
	return { dir, ompExecutable, workspaceDir, configPath };
}

beforeEach(() => {
	home = "";
});

afterEach(async () => {
	while (cleanups.length > 0) {
		const close = cleanups.pop();
		await close?.();
	}
	if (home !== "") rmSync(home, { recursive: true, force: true });
});

describe("AC-1: web channel optionality and standalone daemon boot", () => {
	test("when channels.web is omitted, dashboard keeps GET behavior and returns 404 on /api/web/* and ?view=chat", async () => {
		const server = startDashboardServer({
			port: 0,
			hostname: "127.0.0.1",
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
		cleanups.push(() => {
			server.stop(true);
		});
		const base = `http://127.0.0.1:${server.port}`;

		const homeRes = await fetch(`${base}/`);
		expect(homeRes.status).toBe(200);
		expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);

		for (const [method, path] of [
			["GET", "/api/web/conversations"],
			["GET", "/api/web/messages?c=w_abcd1234"],
			["GET", "/api/web/stream"],
			["POST", "/api/web/new"],
			["POST", "/api/web/send"],
			["POST", "/api/web/action"],
			["POST", "/api/web/upload"],
			["GET", "/?view=chat"],
		] as const) {
			const res = await fetch(`${base}${path}`, { method });
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "web_disabled" });
		}
	});

	test("channels.web alone loads config without discord secrets, binds web, and boots Daemon cleanly", async () => {
		const created = createWebHome({
			enabled: true,
			ownerEmails: ["Owner@Example.COM"],
			accessTeamDomain: "Team.CloudflareAccess.com",
			accessAud: "aud-tag-1",
		});
		const config = loadConfig(created.dir);
		expect(config.channels.discord).toBeUndefined();
		expect(config.channels.web).toEqual({
			enabled: true,
			ownerEmails: ["owner@example.com"],
			accessTeamDomain: "team.cloudflareaccess.com",
			accessAud: "aud-tag-1",
		});
		expect(primaryOwnerUserId(config.channels)).toBe(WEB_OWNER_USER_ID);

		const logs: string[] = [];
		const clock = { now: () => Date.now() };
		const log = createLogger({ sink: (line) => logs.push(line), clock, redact });
		const channels = channelBindings(config, {}, log);
		expect(channels.map((binding) => binding.port.platform)).toEqual(["web"]);

		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			...daemonTestOptions(),
			config,
			channels,
			log,
			clock,
			ompVersion: "omp-test 0",
			bootId: "boot-web-only",
			gateSweepMs: 0,
			taskSweepMs: 0,
			sweepMs: 3_600_000,
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		cleanups.push(() => daemon.stop());
		await daemon.start();

		const ready = logs.find((line) => line.includes("event=daemon_ready"));
		expect(ready).toContain("discord=off");
		expect(ready).toContain("web=on");
		expect(logs.some((line) => line.includes("secret_missing"))).toBe(false);
	});

	test("missing or incomplete channels.web without discord raises ConfigError", () => {
		const emptyHome = createWebHome(undefined);
		expect(() => loadConfig(emptyHome.dir)).toThrow(ConfigError);
		rmSync(emptyHome.dir, { recursive: true, force: true });

		const disabledHome = createWebHome({ enabled: false });
		expect(() => loadConfig(disabledHome.dir)).toThrow(ConfigError);
		rmSync(disabledHome.dir, { recursive: true, force: true });

		const noEmailHome = createWebHome({
			enabled: true,
			ownerEmails: [],
			accessTeamDomain: "team.cloudflareaccess.com",
			accessAud: "aud-1",
		});
		expect(() => loadConfig(noEmailHome.dir)).toThrow(ConfigError);
	});
});

describe("AC-3: web origin grammar and lane refusal", () => {
	test("platformOfConversationId and parseChatOrigin isolate web w_<id> from discord numeric ids", () => {
		const validWeb = ["w_abcd1234", `w_${"a".repeat(32)}`, "w_0123456789abcdef"];
		for (const id of validWeb) {
			expect(platformOfConversationId(id)).toBe("web");
			expect(GRAMMAR.web.conversation.test(id)).toBe(true);
			expect(GRAMMAR.discord.conversation.test(id)).toBe(false);
			expect(parseChatOrigin(`web/dm/${id}`)).toEqual({ platform: "web", kind: "dm", conversationId: id });
			expect(parseChatOrigin(`web/dm/${id}/t/w_ef567890`)).toEqual({
				platform: "web",
				kind: "dm",
				conversationId: id,
				threadId: "w_ef567890",
			});
			expect(chatOriginKey({ platform: "web", kind: "dm", conversationId: id })).toBe(`web/dm/${id}`);
			expect(parseChatOrigin(`discord/dm/${id}`)).toBeUndefined();
		}

		expect(platformOfConversationId("100000000000000001")).toBe("discord");
		expect(parseChatOrigin("web/dm/100000000000000001")).toBeUndefined();
		expect(parseChatOrigin("web/dm/w_abcd1234/t/12345678")).toBeUndefined();

		for (const bad of ["w_short", "w_UPPER123", `w_${"a".repeat(33)}`, "x_abcd1234", "w_bad-char"]) {
			expect(platformOfConversationId(bad)).toBeUndefined();
			expect(GRAMMAR.web.conversation.test(bad)).toBe(false);
			expect(parseChatOrigin(`web/dm/${bad}`)).toBeUndefined();
		}
	});

	test("작업: lane trigger is refused in web conversations with WEB_LANE_REFUSED and no omp prompt", async () => {
		const created = createWebHome({
			enabled: true,
			ownerEmails: ["owner@example.com"],
			accessTeamDomain: "team.cloudflareaccess.com",
			accessAud: "aud-tag-1",
		});
		const config = loadConfig(created.dir);
		const clock = { now: () => Date.now() };
		const logs: string[] = [];
		const waiters = new Set<() => void>();
		const log = createLogger({
			sink: (line) => {
				logs.push(line);
				for (const wake of [...waiters]) wake();
			},
			clock,
			redact,
		});
		const prompts: string[] = [];
		const sessions = new FakeSessionStore();
		const daemon = new Daemon({
			...daemonTestOptions(),
			config,
			channels: channelBindings(config, {}, log),
			log,
			clock,
			ompVersion: "omp-test 0",
			bootId: "boot-web-lane",
			gateSweepMs: 0,
			taskSweepMs: 0,
			sweepMs: 3_600_000,
			driverFactory: (_origin, sessionDir) =>
				new FakeOmpDriver({
					sessionDir,
					store: sessions,
					respond: (prompt) => {
						prompts.push(prompt);
						return `ECHO ${prompt}`;
					},
				}),
		});
		cleanups.push(() => daemon.stop());
		await daemon.start();

		const createdConv = (await callDaemon(daemon.socketPath, { op: "web_new", title: "레인 거부 테스트" })) as {
			ok: boolean;
			conversation: string;
		};
		expect(createdConv.ok).toBe(true);

		const untilNotice = () =>
			new Promise<void>((resolve) => {
				const check = () => {
					const found = readWebMessages(created.dir, createdConv.conversation).some(
						(msg) => msg.role !== "owner" && msg.text.includes(WEB_LANE_REFUSED),
					);
					if (!found) return;
					waiters.delete(check);
					resolve();
				};
				waiters.add(check);
				check();
			});

		const waitingNotice = untilNotice();
		const sendRes = (await callDaemon(daemon.socketPath, {
			op: "web_send",
			conversation: createdConv.conversation,
			text: "작업: 새 레인 열기 @/tmp/repo",
		})) as { ok: boolean; originKey: string };
		expect(sendRes.ok).toBe(true);
		await waitingNotice;

		const rows = readWebMessages(created.dir, createdConv.conversation);
		expect(rows.some((row) => row.role === "assistant" && row.text.includes(WEB_LANE_REFUSED))).toBe(true);
		expect(prompts).toEqual([]);
		expect(daemon.store.listLanes()).toEqual([]);
	});
});
