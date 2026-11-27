import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toneColorInt } from "../src/channel/card";
import { DENIED_TEXT } from "../src/channel/text";
import { ConfigError, loadConfig } from "../src/config";
import { Daemon } from "../src/daemon/daemon";
import { OPS_PANEL_CURSOR } from "../src/daemon/daemon-ops-panel";
import { LIVE_FIELDS, planReload } from "../src/daemon/reload";
import { clearUsageLimitsCache } from "../src/dashboard/usage-limits";
import { DiscordChannel } from "../src/discord/channel";
import { DiscordRest } from "../src/discord/rest";
import { DiscordCallError, type DiscordInteraction } from "../src/discord/transport";
import type { ProcessRunner } from "../src/dispatch/omp";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import type { HostLoadReader } from "../src/ops/host-resources";
import { hostPressure } from "../src/ops/host-resources";
import { LoadHysteresisTracker, loadPolicyFromConfig, sampleLoadMetrics } from "../src/ops/load-hysteresis";
import {
	OPS_ACTION_LIMITS,
	OPS_ACTION_MUTE,
	OPS_ACTION_REFRESH,
	type OpsPanelRenderInput,
	parseOpsPanelActionId,
	renderOpsPanel,
} from "../src/ops/ops-panel";
import { quotaGatePath, writeQuotaLift } from "../src/ops/quota-gate";
import { redact } from "../src/redact";
import {
	CHANNEL,
	discordBinding,
	GUILD,
	makeHome,
	OWNER,
	type TestHome,
	WaitingDiscordTransport,
} from "./helpers/bot-home";
import { daemonTestOptions } from "./helpers/disk";

const OPS_CHANNEL = "300000000000000099";
const LOG_CHANNEL = "300000000000000088";
const APP = "600000000000000000";
const STRANGER = "100000000000000002";
const BASE_NOW = Date.parse("2026-11-27T01:00:00Z");

let home: TestHome;
let daemon: Daemon | undefined;
let now = BASE_NOW;
let seq = 0n;

beforeEach(() => {
	home = makeHome("jabbu-ops-panel-");
	daemon = undefined;
	now = BASE_NOW;
	seq = 0n;
	clearUsageLimitsCache();
});

afterEach(async () => {
	await daemon?.stop();
	home.remove();
});

function writeHomeConfig(patch: Record<string, unknown>): void {
	const current = JSON.parse(readFileSync(home.config.configPath, "utf8")) as Record<string, unknown>;
	writeFileSync(home.config.configPath, JSON.stringify({ ...current, ...patch }), { mode: 0o600 });
}

function makeHostLoad(initial: { load15?: number; cpus?: number; memAvailPct?: number; cgroupFreePct?: number }): {
	state: { load15: number; cpus: number; memAvailPct: number; cgroupFreePct: number | null };
	reader: HostLoadReader;
} {
	const state = {
		load15: initial.load15 ?? 0.4,
		cpus: initial.cpus ?? 4,
		memAvailPct: initial.memAvailPct ?? 50,
		cgroupFreePct: initial.cgroupFreePct ?? 50,
	};
	const reader: HostLoadReader = {
		loadavg: () => [state.load15, state.load15, state.load15],
		cpuCount: () => state.cpus,
		meminfo: () => {
			const total = 1000;
			const avail = Math.round((total * state.memAvailPct) / 100);
			return `MemTotal: ${total} kB\nMemAvailable: ${avail} kB\n`;
		},
		cgroup: () =>
			state.cgroupFreePct === null
				? undefined
				: {
						version: 2,
						high: {
							path: "/sys/fs/cgroup/app.slice",
							currentBytes: 0,
							limitBytes: 1000,
							reclaimableBytes: 0,
							chargedFreePct: state.cgroupFreePct,
							freePct: state.cgroupFreePct,
						},
						hard: null,
						incomplete: false,
					},
	};
	return { state, reader };
}

function clickButton(customId: string, messageId: string, userId = OWNER): DiscordInteraction {
	seq += 1n;
	return {
		id: String(810_000_000_000_000_000n + seq),
		application_id: APP,
		type: 3,
		token: `tok-${seq}`,
		channel_id: OPS_CHANNEL,
		guild_id: GUILD,
		member: { user: { id: userId } },
		data: { custom_id: customId, component_type: 2 },
		message: { id: messageId, channel_id: OPS_CHANNEL },
	};
}

async function startOpsDaemon(options: {
	transport: WaitingDiscordTransport;
	hostLoad: HostLoadReader;
	configPatch?: Record<string, unknown>;
	usageLimitsRun?: ProcessRunner;
	logs?: string[];
	gateSweepMs?: number;
}): Promise<Daemon> {
	writeHomeConfig({
		opsPanel: { channelId: OPS_CHANNEL },
		...(options.configPatch ?? {}),
	});
	const loaded = loadConfig(home.dir, { checkTokens: false });
	const sessions = new FakeSessionStore();
	const logs = options.logs ?? [];
	const clock = { now: () => now };
	const d = new Daemon({
		...daemonTestOptions(),
		config: loaded,
		channels: [discordBinding(options.transport)],
		driverFactory: (_o, dir) => new FakeOmpDriver({ store: sessions, sessionDir: dir }),
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "0.0.0-test",
		bootId: "test-boot",
		clock,
		hostLoad: options.hostLoad,
		sweepMs: 3_600_000,
		gateSweepMs: options.gateSweepMs ?? 0,
		taskSweepMs: 0,
		pendingRetryMs: 0,
		...(options.usageLimitsRun === undefined ? {} : { usageLimitsRun: options.usageLimitsRun }),
	});
	await d.start();
	return d;
}

describe("LoadHysteresisTracker", () => {
	const policy = loadPolicyFromConfig({
		channelId: OPS_CHANNEL,
		sustainMinutes: 5,
		hysteresisPct: 10,
		loadPct: 200,
		memUsedPct: 90,
		cgroupUsedPct: 90,
	});

	test("ignores sub-5m spikes, fires after 5m, holds inside 10pt band, and resolves at <= clearAt", () => {
		const tracker = new LoadHysteresisTracker();
		// 4m spike then drop below 90 -> resets without firing
		expect(tracker.evaluate({ load: 20, mem: 92, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 0).transition).toBe(
			"none",
		);
		expect(tracker.evaluate({ load: 20, mem: 93, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 240_000).transition).toBe(
			"none",
		);
		const reset = tracker.evaluate({ load: 20, mem: 89, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 300_000);
		expect(reset.transition).toBe("none");
		expect(reset.snapshot.metrics.mem.phase).toBe("ok");

		// Sustained >= 5m fires
		expect(tracker.evaluate({ load: 20, mem: 91, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 400_000).transition).toBe(
			"none",
		);
		const fired = tracker.evaluate({ load: 20, mem: 95, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 700_000);
		expect(fired.transition).toBe("fire");
		expect(fired.snapshot.active).toBe(true);
		expect(fired.snapshot.metrics.mem.phase).toBe("firing");
		expect(fired.snapshot.metrics.mem.clearAt).toBe(80);

		// 85% and 81% stay inside 10pt hysteresis band (no flap)
		expect(
			tracker.evaluate({ load: 20, mem: 85, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 760_000).snapshot.active,
		).toBe(true);
		expect(
			tracker.evaluate({ load: 20, mem: 81, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 820_000).snapshot.active,
		).toBe(true);

		// Restored tracker preserves episode and resolves at 80% with peak 95
		const restored = new LoadHysteresisTracker(tracker.snapshot());
		const resolved = restored.evaluate({ load: 20, mem: 80, cgroup: 30, load15: 0.8, cpus: 4 }, policy, 880_000);
		expect(resolved.transition).toBe("resolve");
		expect(resolved.snapshot.active).toBe(false);
		expect(resolved.resolvedPeaks).toEqual({ mem: 95 });
		expect(resolved.resolvedStartedAt).toBe(700_000);
	});

	test("stays active across multiple metrics until every firing metric clears, and keeps state on null samples", () => {
		const tracker = new LoadHysteresisTracker();
		tracker.evaluate({ load: 220, mem: 94, cgroup: 40, load15: 8.8, cpus: 4 }, policy, 0);
		const fired = tracker.evaluate({ load: 230, mem: 96, cgroup: 40, load15: 9.2, cpus: 4 }, policy, 300_000);
		expect(fired.transition).toBe("fire");

		// Null mem sample must not drop firing
		const onNull = tracker.evaluate({ load: 150, mem: null, cgroup: 40, load15: 6.0, cpus: 4 }, policy, 360_000);
		expect(onNull.transition).toBe("none");
		expect(onNull.snapshot.active).toBe(true);
		expect(onNull.snapshot.metrics.load.phase).toBe("ok");
		expect(onNull.snapshot.metrics.mem.phase).toBe("firing");

		// Mem recovers -> episode resolves with peaks from both metrics
		const resolved = tracker.evaluate({ load: 100, mem: 79, cgroup: 40, load15: 4.0, cpus: 4 }, policy, 420_000);
		expect(resolved.transition).toBe("resolve");
		expect(resolved.resolvedPeaks).toEqual({ load: 230, mem: 96 });
	});

	test("sampleLoadMetrics computes load%, mem%, and worst cgroup%", () => {
		const sample = sampleLoadMetrics({
			load15: 6,
			cpus: 4,
			memAvailableRatio: 0.25,
			cgroupHighFreeRatio: 0.2,
			cgroupHardFreeRatio: 0.08,
			cgroupVersion: 2,
			cgroupIncomplete: false,
			open: true,
		});
		expect(sample).toEqual({ load: 150, mem: 75, cgroup: 92, load15: 6, cpus: 4 });
	});
});

describe("opsPanel config and live reload", () => {
	test("validates opsPanel fields, rejects logChannelId overlap, and classifies as LIVE_FIELD", () => {
		expect(LIVE_FIELDS as readonly string[]).toContain("opsPanel");
		expect(parseOpsPanelActionId(OPS_ACTION_REFRESH)).toBe("refresh");
		expect(parseOpsPanelActionId(OPS_ACTION_LIMITS)).toBe("limits");
		expect(parseOpsPanelActionId(OPS_ACTION_MUTE)).toBe("mute");
		expect(parseOpsPanelActionId("other")).toBeUndefined();

		writeHomeConfig({
			opsPanel: {
				channelId: OPS_CHANNEL,
				minRefreshSec: 90,
				sustainMinutes: 3,
				hysteresisPct: 12,
				muteMinutes: 30,
				loadPct: 180,
				memUsedPct: 85,
				cgroupUsedPct: 88,
			},
		});
		const cfg = loadConfig(home.dir, { checkTokens: false });
		expect(cfg.opsPanel).toEqual({
			channelId: OPS_CHANNEL,
			minRefreshSec: 90,
			sustainMinutes: 3,
			hysteresisPct: 12,
			muteMinutes: 30,
			loadPct: 180,
			memUsedPct: 85,
			cgroupUsedPct: 88,
		});

		const plan = planReload({ ...home.config }, cfg);
		expect(plan.changed).toEqual(["opsPanel"]);
		expect(plan.restartRequired).toEqual([]);

		// Reject minRefreshSec < 60
		writeHomeConfig({ opsPanel: { channelId: OPS_CHANNEL, minRefreshSec: 59 } });
		expect(() => loadConfig(home.dir, { checkTokens: false })).toThrow(ConfigError);

		// Reject logChannelId overlap
		const baseDiscord = (JSON.parse(readFileSync(home.config.configPath, "utf8")) as { channels: { discord: object } })
			.channels.discord;
		writeHomeConfig({
			channels: { discord: { ...baseDiscord, logChannelId: LOG_CHANNEL } },
			opsPanel: { channelId: LOG_CHANNEL },
		});
		expect(() => loadConfig(home.dir, { checkTokens: false })).toThrow(/opsPanel\.channelId/);

		// Reject unknown key
		writeHomeConfig({
			channels: { discord: baseDiscord },
			opsPanel: { channelId: OPS_CHANNEL, bogus: 1 },
		});
		expect(() => loadConfig(home.dir, { checkTokens: false })).toThrow(/opsPanel\.bogus/);
	});
});

describe("Discord pinMessage and embed tone", () => {
	test("DiscordRest.pinMessage sends PUT /channels/<id>/pins/<msgId> and DiscordChannel maps tone + pin", async () => {
		const requests: Array<{ method: string; path: string }> = [];
		const rest = new DiscordRest({
			token: "TEST-token",
			fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				requests.push({ method: init?.method ?? "GET", path: url.pathname });
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});
		await rest.pinMessage({ channelId: OPS_CHANNEL, messageId: "9001" });
		expect(requests).toEqual([{ method: "PUT", path: `/api/v10/channels/${OPS_CHANNEL}/pins/9001` }]);

		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		const ch = new DiscordChannel(transport, { ownerUserId: OWNER });
		const ref = await ch.post({ conversationId: OPS_CHANNEL }, { text: "ok", title: "Panel", tone: "danger" });
		await ch.pin(ref);
		const created = transport.calls.find((c) => c.method === "createMessage");
		expect(created && created.method === "createMessage" ? created.embeds?.[0] : undefined).toMatchObject({
			title: "Panel",
			color: toneColorInt("danger"),
		});
		expect(transport.calls.filter((c) => c.method === "pinMessage")).toEqual([
			{ method: "pinMessage", channelId: OPS_CHANNEL, messageId: ref.messageId },
		]);
	});
});

describe("Daemon #ops panel and hysteresis alerts", () => {
	test("pins once, enforces 1m edit cap, recovers from 404/403, and handles refresh/limits/mute buttons", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		const load = makeHostLoad({ load15: 0.4, cpus: 4, memAvailPct: 50, cgroupFreePct: 50 });
		writeQuotaLift(home.dir, { provider: "anthropic", untilMs: BASE_NOW + 1_800_000, now: BASE_NOW });

		const usageLimitsRun: ProcessRunner = async (argv) => {
			if (argv.includes("anthropic")) {
				return {
					code: 0,
					signal: null,
					timedOut: false,
					stdout: JSON.stringify({
						reports: [
							{
								provider: "anthropic",
								limits: [
									{
										label: "5h",
										window: { id: "5h", label: "5h", resetsAt: BASE_NOW + 3_600_000 },
										amount: { usedFraction: 0.4 },
									},
								],
							},
						],
					}),
					stderr: "",
				};
			}
			return {
				code: 1,
				signal: null,
				timedOut: false,
				stdout: "",
				stderr: "auth failed sk-TEST-secret-0000111122223333",
			};
		};

		daemon = await startOpsDaemon({
			transport,
			hostLoad: load.reader,
			usageLimitsRun,
			configPatch: {
				quotaGate: { holdPct: 95 },
				dashboard: {
					port: 7331,
					usageLimits: {
						omp: [
							["fake-omp", "usage", "--json", "-r", "-p", "anthropic"],
							["fake-omp", "usage", "--json", "-r", "-p", "zai"],
						],
					},
				},
			},
		});

		// First sweep creates and pins 1 panel with 3 buttons
		await daemon.sweep();
		await daemon.opsPanelIdle();
		const created = transport.calls.filter((c) => c.method === "createMessage" && c.channelId === OPS_CHANNEL);
		expect(created).toHaveLength(1);
		const firstPanel = created[0];
		if (firstPanel?.method !== "createMessage") throw new Error("expected panel createMessage");
		const panelId = firstPanel.id;
		expect(transport.calls.filter((c) => c.method === "pinMessage")).toEqual([
			{ method: "pinMessage", channelId: OPS_CHANNEL, messageId: panelId },
		]);
		const components = firstPanel.components as Array<{ components: Array<{ custom_id: string }> }>;
		expect(components[0]?.components.map((b) => b.custom_id)).toEqual([
			OPS_ACTION_REFRESH,
			OPS_ACTION_LIMITS,
			OPS_ACTION_MUTE,
		]);

		// 15s, 30s, 45s sweeps respect 1-minute cap even when load changes
		load.state.load15 = 1.6;
		for (const dt of [15_000, 30_000, 45_000]) {
			now = BASE_NOW + dt;
			await daemon.sweep();
			await daemon.opsPanelIdle();
		}
		expect(transport.count("editMessage")).toBe(0);

		// 60s sweep edits existing message in place (no new pin)
		now = BASE_NOW + 60_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(transport.count("editMessage")).toBe(1);
		expect(transport.count("createMessage")).toBe(1);
		expect(transport.count("pinMessage")).toBe(1);

		// Refresh button forces edit before 60s; stranger click gets ephemeral denial and no edit
		now = BASE_NOW + 70_000;
		await transport.emitInteraction(clickButton(OPS_ACTION_REFRESH, panelId, STRANGER));
		expect(transport.count("editMessage")).toBe(1);
		const strangerResp = transport.calls.filter((c) => c.method === "respondInteraction").at(-1);
		expect(
			strangerResp && strangerResp.method === "respondInteraction" ? strangerResp.response.data : undefined,
		).toEqual({
			content: DENIED_TEXT,
			flags: 64,
		});

		await transport.emitInteraction(clickButton(OPS_ACTION_REFRESH, panelId, OWNER));
		expect(transport.count("editMessage")).toBe(2);

		// Full limits button replies ephemerally without public message
		const beforePosts = transport.count("createMessage");
		await transport.emitInteraction(clickButton(OPS_ACTION_LIMITS, panelId, OWNER));
		expect(transport.count("createMessage")).toBe(beforePosts);
		const followups = transport.calls.filter((c) => c.method === "followupInteraction");
		expect(followups).toHaveLength(1);
		const limitFollow = followups[0];
		if (limitFollow?.method !== "followupInteraction") throw new Error("expected followupInteraction");
		expect(limitFollow.flags).toBe(64);
		expect(limitFollow.content).toContain("60% 남음");
		expect(limitFollow.content).toContain("anthropic");
		expect(limitFollow.content).not.toContain("sk-TEST-secret-0000111122223333");

		// 404:10008 on panel edit recreates and re-pins (and tolerates 403 pin error)
		now = BASE_NOW + 135_000;
		load.state.load15 = 0.8;
		transport.failNext.editMessage = [new DiscordCallError("definitive", "Unknown Message", 404, 10008)];
		transport.failNext.pinMessage = [new DiscordCallError("definitive", "Missing Access", 403, 50013)];
		await daemon.sweep();
		await daemon.opsPanelIdle();
		const panelCreatesAfter404 = transport.calls.filter(
			(c) => c.method === "createMessage" && c.channelId === OPS_CHANNEL,
		);
		expect(panelCreatesAfter404).toHaveLength(2);
		const secondPanel = panelCreatesAfter404[1];
		if (secondPanel?.method !== "createMessage") throw new Error("expected recreated panel");
		const newPanelId = secondPanel.id;

		// Mute button toggles label to 음소거 해제 and suppresses 5m sustained alert
		now = BASE_NOW + 140_000;
		await transport.emitInteraction(clickButton(OPS_ACTION_MUTE, newPanelId, OWNER));
		const muteEdit = transport.calls.filter((c) => c.method === "editMessage").at(-1);
		const muteButtons =
			muteEdit && muteEdit.method === "editMessage"
				? (muteEdit.components as Array<{ components: Array<{ label: string }> }>)[0]?.components
				: [];
		expect(muteButtons?.map((b) => b.label)).toContain("음소거 해제");

		load.state.memAvailPct = 5; // 95% used (>= 90% threshold)
		now = BASE_NOW + 200_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		now = BASE_NOW + 500_000; // +5m sustained while muted
		await daemon.sweep();
		await daemon.opsPanelIdle();
		// Still only the 2 panel creates (alert was suppressed)
		expect(transport.calls.filter((c) => c.method === "createMessage" && c.channelId === OPS_CHANNEL)).toHaveLength(2);

		// Unmute restores label
		await transport.emitInteraction(clickButton(OPS_ACTION_MUTE, newPanelId, OWNER));
		const unmuteEdit = transport.calls.filter((c) => c.method === "editMessage").at(-1);
		const unmuteButtons =
			unmuteEdit && unmuteEdit.method === "editMessage"
				? (unmuteEdit.components as Array<{ components: Array<{ label: string }> }>)[0]?.components
				: [];
		expect(unmuteButtons?.map((b) => b.label)).toContain("1시간 음소거");
	});

	test("alerts once after 5m sustain, skips duplicate host_pressure gate alert, and resolves original message after restart", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
		const baseDiscord = (JSON.parse(readFileSync(home.config.configPath, "utf8")) as { channels: { discord: object } })
			.channels.discord;
		const load = makeHostLoad({ load15: 0.4, cpus: 4, memAvailPct: 5, cgroupFreePct: 50 }); // 95% mem used
		daemon = await startOpsDaemon({
			transport,
			hostLoad: load.reader,
			gateSweepMs: 60_000,
			configPatch: {
				channels: { discord: { ...baseDiscord, alertChannelId: CHANNEL } },
			},
		});

		// t=0: panel created, mem phase = pending (no alert yet, no duplicate host_pressure gate alert)
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(transport.posts((t) => t.includes("호스트 부하 경보"))).toHaveLength(0);
		expect(transport.posts((t) => t.includes("host_pressure"))).toHaveLength(0);

		// t=+5m: sustained >= 5m -> posts owner-pinged alert in #ops
		now = BASE_NOW + 5 * 60_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		const alertPosts = transport.posts((t) => t.includes(`<@${OWNER}>`) && t.includes("호스트 부하 경보"));
		expect(alertPosts).toHaveLength(1);
		const alertPost = alertPosts[0];
		if (!alertPost) throw new Error("expected alert post");
		const alertId = alertPost.id;
		expect(alertPost.channelId).toBe(OPS_CHANNEL);
		expect(alertPost.embeds?.[0]).toMatchObject({ color: toneColorInt("danger") });

		// t=+6m: mem drops to 84% used (16% avail) -> still inside 10pt hysteresis band (>80%), no resolve
		load.state.memAvailPct = 16;
		now = BASE_NOW + 6 * 60_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(transport.calls.some((c) => c.method === "editMessage" && c.messageId === alertId)).toBe(false);

		// Restart daemon while alert is still firing; verify state persisted in cursor
		expect(daemon.store.getCursor(OPS_PANEL_CURSOR)).toBeDefined();
		await daemon.stop();
		daemon = await startOpsDaemon({
			transport,
			hostLoad: load.reader,
			gateSweepMs: 60_000,
			configPatch: {
				channels: { discord: { ...baseDiscord, alertChannelId: CHANNEL } },
			},
		});

		// First sweep after restart updates existing panel (no new pin) and keeps alert firing at 84%
		now = BASE_NOW + 7 * 60_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(transport.count("pinMessage")).toBe(1);
		expect(transport.calls.some((c) => c.method === "editMessage" && c.messageId === alertId)).toBe(false);

		// Other gates still fire normally when open (remove backup stamp to verify backup_age fires)
		rmSync(join(home.dir, "backups"), { recursive: true, force: true });
		now = BASE_NOW + 8 * 60_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(transport.posts((t) => t.includes("게이트 backup_age 열림"))).toHaveLength(1);
		expect(transport.posts((t) => t.includes("host_pressure"))).toHaveLength(0);

		// t=+9m: mem drops to 80% used (20% avail, <= 90-10=80 clearAt) -> edits original alert message to resolved
		load.state.memAvailPct = 20;
		now = BASE_NOW + 9 * 60_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		const resolveEdits = transport.calls.filter(
			(c): c is Extract<typeof c, { method: "editMessage" }> => c.method === "editMessage" && c.messageId === alertId,
		);
		expect(resolveEdits).toHaveLength(1);
		const resolveEdit = resolveEdits[0];
		expect(resolveEdit?.content).toContain("resolved");
		expect(resolveEdit?.content).not.toContain(`<@${OWNER}>`);
		expect(resolveEdit?.embeds?.[0]).toMatchObject({
			title: "✅ 호스트 부하 경보 — resolved",
			color: toneColorInt("ok"),
		});
	});

	test("displays warn-only quotaGate mode in #ops panel for both clear and held states", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		const load = makeHostLoad({ load15: 0.4, cpus: 4, memAvailPct: 50, cgroupFreePct: 50 });
		writeFileSync(quotaGatePath(home.dir), JSON.stringify({ updatedAt: BASE_NOW, mode: "warn", held: [] }), {
			mode: 0o600,
		});
		daemon = await startOpsDaemon({
			transport,
			hostLoad: load.reader,
			configPatch: { quotaGate: { holdPct: 95, mode: "warn" } },
		});

		await daemon.sweep();
		await daemon.opsPanelIdle();
		const first = transport.calls.find((c) => c.method === "createMessage" && c.channelId === OPS_CHANNEL);
		if (first?.method !== "createMessage") throw new Error("expected panel createMessage");
		const firstFields = (first.embeds?.[0] as { fields?: Array<{ name: string; value: string }> } | undefined)?.fields;
		expect(firstFields?.find((f) => f.name === "쿼터 게이트")?.value).toBe("경보 전용 · 정상");

		writeFileSync(
			quotaGatePath(home.dir),
			JSON.stringify({
				updatedAt: BASE_NOW + 60_000,
				mode: "warn",
				held: [
					{
						provider: "anthropic",
						causes: [{ provider: "anthropic", label: "5시간", usedPct: 97, releaseAt: BASE_NOW + 3_600_000 }],
					},
				],
			}),
			{ mode: 0o600 },
		);
		now = BASE_NOW + 61_000;
		await daemon.sweep();
		await daemon.opsPanelIdle();
		const edited = transport.calls.filter((c) => c.method === "editMessage").at(-1);
		if (edited?.method !== "editMessage") throw new Error("expected panel editMessage");
		const editedFields = (edited.embeds?.[0] as { fields?: Array<{ name: string; value: string }> } | undefined)
			?.fields;
		const quotaValue = editedFields?.find((f) => f.name === "쿼터 게이트")?.value;
		expect(quotaValue).toContain("경보 전용(차단 안 함)");
		expect(quotaValue).toContain("• anthropic: 5시간 97%");
	});
});

const MIN = 60_000;

function baseRender(extra: Partial<OpsPanelRenderInput> = {}): OpsPanelRenderInput {
	const sample = sampleLoadMetrics(hostPressure(makeHostLoad({}).reader));
	const config = { channelId: OPS_CHANNEL };
	const snapshot = new LoadHysteresisTracker().evaluate(sample, loadPolicyFromConfig(config), BASE_NOW).snapshot;
	return {
		now: BASE_NOW,
		timezone: "Asia/Seoul",
		status: {
			ompVersion: "0.0.0-test",
			timezone: "Asia/Seoul",
			daemonRunning: true,
			origins: [],
			ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
			inbound: { pending: 0, dispatched: 0, confirmed: 0, failed: 0, expired: 0 } as never,
			monitors: { count: 0, next: null },
			openGates: [],
		},
		lanes: { working: 0, paused: 0, pendingLand: 0 },
		load: { sample, snapshot },
		quota: { snapshot: { updatedAt: null, held: [] }, lifts: new Map() },
		config,
		...extra,
	};
}

const fieldOf = (input: OpsPanelRenderInput, name: string): string | undefined =>
	renderOpsPanel(input).message.fields?.find((f) => f.label === name)?.value;

describe("renderOpsPanel monitors, recent incidents and usage fields", () => {
	test("monitors field lists failing names with counts and raises tone; none failing says all normal", () => {
		const failing = [
			{ name: "backup-watch", count: 3, lastAt: BASE_NOW - 5 * MIN },
			{ name: "disk-watch", count: 1, lastAt: BASE_NOW - 2 * 3_600_000 },
		];
		const out = renderOpsPanel(baseRender({ monitors: { total: 4, failing } }));
		const value = out.message.fields?.find((f) => f.label === "🛠️ 모니터")?.value ?? "";
		expect(value).toContain("backup-watch 실패 3회 · 5분 전");
		expect(value).toContain("disk-watch 실패 1회 · 2시간 전");
		expect(out.message.tone).toBe("warn");
		expect(fieldOf(baseRender({ monitors: { total: 4, failing: [] } }), "🛠️ 모니터")).toBe("모두 정상 (4개)");
		expect(renderOpsPanel(baseRender({ monitors: { total: 4, failing: [] } })).message.tone).toBe("ok");
	});

	test("recent field keeps the newest 3, marks alerted/resolved, names gates in Korean; empty says 아직 없음", () => {
		const recent = [
			{ scope: "gate:backup_age", status: "alerted" as const, lastAt: BASE_NOW - MIN },
			{ scope: "provider:limit", status: "resolved" as const, lastAt: BASE_NOW - 2 * MIN },
			{ scope: "monitor:nightly", status: "alerted" as const, lastAt: BASE_NOW - 3 * MIN },
			{ scope: "dispatch:old-1", status: "alerted" as const, lastAt: BASE_NOW - 4 * MIN },
			{ scope: "dispatch:old-2", status: "resolved" as const, lastAt: BASE_NOW - 5 * MIN },
		];
		const lines = (fieldOf(baseRender({ recent }), "📮 최근") ?? "").split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("🔴 백업이 36시간 넘게 없음 · 1분 전");
		expect(lines[1]).toBe("✅ 모델 공급자 사용 한도 · 2분 전");
		expect(lines[2]).toBe("🔴 nightly · 3분 전");
		expect(fieldOf(baseRender({ recent: [] }), "📮 최근")).toBe("아직 없음");
	});

	test("usage field: one line per provider with bar and percent; empty, failed and omitted states", () => {
		const usage = {
			state: "ok" as const,
			rows: [
				{ provider: "Claude", label: "5시간", usedPct: 40, resetsAt: BASE_NOW + 3_600_000 },
				{ provider: "GLM", label: "주간", usedPct: 95 },
			],
		};
		const lines = (fieldOf(baseRender({ usage }), "🔋 사용량") ?? "").split("\n");
		expect(lines).toEqual(["Claude 5시간 ▰▰▰▰▱▱▱▱▱▱ 40% · 11:00", "GLM 주간 ▰▰▰▰▰▰▰▰▰▰ 95%"]);
		expect(fieldOf(baseRender({ usage: { state: "empty" } }), "🔋 사용량")).toBe("보고된 한도 없음");
		expect(fieldOf(baseRender({ usage: { state: "failed", error: "boom" } }), "🔋 사용량")).toBe("조회 실패");
		expect(fieldOf(baseRender(), "🔋 사용량")).toBeUndefined();
	});

	test("fingerprint ignores relative-time drift and 5%-bucket usage jitter, but follows monitor counts", () => {
		const monitors = (count: number) => ({ total: 2, failing: [{ name: "m", count, lastAt: BASE_NOW - MIN }] });
		const usage = (pct: number) => ({
			state: "ok" as const,
			rows: [{ provider: "Claude", label: "5시간", usedPct: pct }],
		});
		const fp = (extra: Partial<OpsPanelRenderInput>) => renderOpsPanel(baseRender(extra)).fingerprint;
		const base = { monitors: monitors(2), usage: usage(41), recent: [] };
		expect(fp({ ...base, now: BASE_NOW + MIN })).toBe(fp({ ...base, now: BASE_NOW + 10 * MIN }));
		expect(fp(base)).toBe(fp({ ...base, usage: usage(42) }));
		expect(fp(base)).not.toBe(fp({ ...base, monitors: monitors(3) }));
	});

	test("without the three inputs the fields and fingerprint are the pre-change five-field panel", () => {
		const out = renderOpsPanel(baseRender());
		expect(out.message.fields?.map((f) => f.label)).toEqual([
			"호스트 부하",
			"세션 · 작업",
			"건강 게이트",
			"쿼터 게이트",
			"갱신 시각",
		]);
		expect(out.fingerprint).not.toContain("monitorsKey");
		expect(out.fingerprint).not.toContain("usageKey");
	});

	test("50 failing monitors with long names and long scopes keep all 8 fields under the embed limits", () => {
		const long = "가".repeat(400);
		const failing = Array.from({ length: 50 }, (_, i) => ({ name: `${long}${i}`, count: i + 1, lastAt: BASE_NOW }));
		const recent = Array.from({ length: 5 }, (_, i) => ({
			scope: `dispatch:${long}${i}`,
			status: "alerted" as const,
			lastAt: BASE_NOW - i,
		}));
		const usage = {
			state: "ok" as const,
			rows: Array.from({ length: 30 }, (_, i) => ({ provider: `p${long}${i}`, label: long, usedPct: i * 3 })),
		};
		const base = baseRender();
		const input = baseRender({
			monitors: { total: 50, failing },
			recent,
			usage,
			status: {
				...base.status,
				openGates: Array.from({ length: 40 }, (_, i) => ({ name: `gate_${long}${i}`, detail: "" })) as never,
			},
		});
		const { message } = renderOpsPanel(input);
		const fields = message.fields ?? [];
		expect(fields).toHaveLength(8);
		for (const f of fields) expect(f.value.length).toBeLessThanOrEqual(1024);
		const total =
			(message.title?.length ?? 0) +
			(message.body?.length ?? 0) +
			fields.reduce((n, f) => n + f.label.length + f.value.length, 0);
		expect(total).toBeLessThanOrEqual(6000);
	});
});

describe("incident rows behind the panel", () => {
	test("resolving an incident moves its last_at to the resolution time and it tops the recent list as resolved", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		daemon = await startOpsDaemon({ transport, hostLoad: makeHostLoad({}).reader });
		const store = daemon.store;
		store.recordAlertIncident("gate:backup_age", "old", BASE_NOW - 10 * MIN);
		store.recordAlertIncident("gate:disk_low", "newer", BASE_NOW - 5 * MIN);
		now = BASE_NOW;
		store.resolveAlertIncidents("gate:backup_age");
		const rows = store.opsIncidents(5).recent;
		expect(rows[0]).toEqual({ scope: "gate:backup_age", status: "resolved", lastAt: BASE_NOW });
		expect(rows[1]).toMatchObject({ scope: "gate:disk_low", status: "alerted" });
		const out = renderOpsPanel(baseRender({ recent: rows }));
		expect(out.message.fields?.find((f) => f.label === "📮 최근")?.value.split("\n")[0]).toBe(
			"✅ 백업이 36시간 넘게 없음 · 방금",
		);
	});
});

describe("Daemon #ops panel monitors, usage collection and pin retry", () => {
	const okRun =
		(calls: { n: number }): ProcessRunner =>
		async () => {
			calls.n += 1;
			return {
				code: 0,
				signal: null,
				timedOut: false,
				stdout: JSON.stringify({
					reports: [
						{
							provider: "anthropic",
							limits: [{ label: "5h", window: { id: "5h", label: "5h" }, amount: { usedFraction: 0.4 } }],
						},
					],
				}),
				stderr: "",
			};
		};
	const usageConfig = {
		dashboard: { port: 7331, usageLimits: { omp: [["fake-omp", "usage", "--json", "-r", "-p", "anthropic"]] } },
	};

	/** Yields to the event loop (bounded) until `done`: a background collection settles without any timer. */
	async function until(done: () => boolean): Promise<void> {
		for (let i = 0; i < 500 && !done(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
		expect(done()).toBe(true);
	}

	function panelId(transport: WaitingDiscordTransport): string {
		const created = transport.calls.find((c) => c.method === "createMessage" && c.channelId === OPS_CHANNEL);
		if (created?.method !== "createMessage") throw new Error("expected panel createMessage");
		return created.id;
	}

	const refresh = (transport: WaitingDiscordTransport): Promise<void> =>
		transport.emitInteraction(clickButton(OPS_ACTION_REFRESH, panelId(transport)));

	function panelFields(transport: WaitingDiscordTransport): Array<{ name: string; value: string }> {
		const last = transport.calls
			.filter((c) => (c.method === "createMessage" || c.method === "editMessage") && c.embeds !== undefined)
			.at(-1);
		if (last === undefined || (last.method !== "createMessage" && last.method !== "editMessage")) {
			throw new Error("expected a panel post");
		}
		return (last.embeds?.[0] as { fields?: Array<{ name: string; value: string }> } | undefined)?.fields ?? [];
	}

	test("posts the failing monitor's name and collects usage once per 15 minutes", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		const calls = { n: 0 };
		daemon = await startOpsDaemon({
			transport,
			hostLoad: makeHostLoad({}).reader,
			usageLimitsRun: okRun(calls),
			configPatch: usageConfig,
		});
		const monitor = daemon.store.monitors.addMonitor({
			name: "nightly-sync",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		daemon.store.monitors.recordMonitorIncident(monitor.id, "boom", BASE_NOW - 3 * MIN);
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(panelFields(transport).find((f) => f.name === "🛠️ 모니터")?.value).toContain("nightly-sync 실패 1회");
		await until(() => calls.n >= 1);

		now = BASE_NOW + 2 * MIN;
		const usageValue = (): string | undefined => panelFields(transport).find((f) => f.name === "🔋 사용량")?.value;
		for (let i = 0; i < 50 && usageValue() === undefined; i++) await refresh(transport);
		expect(usageValue()).toContain("Claude 5h");
		expect(calls.n).toBe(1);
		now = BASE_NOW + 14 * MIN;
		await refresh(transport);
		expect(calls.n).toBe(1);
		now = BASE_NOW + 16 * MIN;
		await refresh(transport);
		await until(() => calls.n >= 2);
		expect(calls.n).toBe(2);
	});

	test("a collector that never finishes does not hold ticks, refresh or mute", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		let started = 0;
		const hang: ProcessRunner = () => {
			started += 1;
			return new Promise(() => {});
		};
		daemon = await startOpsDaemon({
			transport,
			hostLoad: makeHostLoad({}).reader,
			usageLimitsRun: hang,
			configPatch: usageConfig,
		});
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(started).toBe(1);
		now = BASE_NOW + 2 * MIN;
		await refresh(transport);
		await refresh(transport);
		await transport.emitInteraction(clickButton(OPS_ACTION_MUTE, panelId(transport)));
		expect(started).toBe(1);
		expect(transport.count("editMessage")).toBeGreaterThanOrEqual(3);
		expect(panelFields(transport).some((f) => f.name === "🔋 사용량")).toBe(false);
	});

	test("a failed pin is retried after an hour and not again once it succeeds", async () => {
		const transport = new WaitingDiscordTransport();
		transport.setChannel({ id: OPS_CHANNEL, type: 0, guildId: GUILD });
		transport.failNext.pinMessage = [new DiscordCallError("definitive", "Missing Access", 403, 50013)];
		daemon = await startOpsDaemon({ transport, hostLoad: makeHostLoad({}).reader });
		await daemon.sweep();
		await daemon.opsPanelIdle();
		expect(transport.count("pinMessage")).toBe(1);

		now = BASE_NOW + 30 * MIN;
		await refresh(transport);
		expect(transport.count("pinMessage")).toBe(1);
		now = BASE_NOW + 61 * MIN;
		await refresh(transport);
		expect(transport.count("pinMessage")).toBe(2);
		now = BASE_NOW + 130 * MIN;
		await refresh(transport);
		expect(transport.count("pinMessage")).toBe(2);
	});
});
