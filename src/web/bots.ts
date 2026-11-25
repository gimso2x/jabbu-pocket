import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type JabbuConfig, loadConfig } from "../config";
import { readWebConversations } from "../store/web-messages";

export interface WebBotTarget {
	id: string;
	name: string;
	homeDir: string;
	/** One IPC request to this bot's daemon; `timeoutMs` defaults to {@link WEB_IPC_TIMEOUT_MS}. */
	callDaemon: (request: unknown, timeoutMs?: number) => Promise<unknown>;
	accent?: string | undefined;
}

/** How long a web op waits for its daemon before the router answers 503 (the [TASK] ops wait longer, see routes.ts). */
export const WEB_IPC_TIMEOUT_MS = 5_000;

export interface WebBotSummary {
	id: string;
	name: string;
	accent: string;
	conversationCount: number;
	openApprovals: number;
	inProgress: boolean;
}

const BOT_ACCENTS: Record<string, string> = {
	songbak: "#58A6FF",
	seopak: "#3FB97A",
	ttungi: "#C084FC",
};
const ACCENT_PALETTE = ["#58A6FF", "#3FB97A", "#C084FC", "#F0A93A", "#36C5F0"];

/** Normalizes a bot home directory name into a short URL-safe bot slug (e.g. `.jabbu-seopak` -> `seopak`). */
export function slugOfBotHome(homeDir: string, fallback = "bot"): string {
	const raw = basename(resolve(homeDir))
		.replace(/^\.jabbu-?/i, "")
		.replace(/^\./, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return raw === "" ? fallback : raw;
}

/** Stable accent color per bot slug with a fixed palette fallback. */
export function accentForBot(id: string, index = 0): string {
	return BOT_ACCENTS[id] ?? ACCENT_PALETTE[index % ACCENT_PALETTE.length] ?? "#58A6FF";
}

function peerNameFromConfig(home: string, fallbackName: string): { enabled: boolean; name: string } {
	if (!existsSync(join(home, "config.json"))) return { enabled: false, name: fallbackName };
	try {
		const cfg = loadConfig(home, { checkTokens: false });
		return {
			enabled: cfg.channels.web?.enabled === true,
			name: cfg.channels.discord?.displayName ?? fallbackName,
		};
	} catch {
		return { enabled: false, name: fallbackName };
	}
}

/** Collects the primary home bot plus any `dashboard.peerHomes` bots with `channels.web.enabled`. */
export function resolveWebBots(
	homeDir: string,
	config: JabbuConfig | undefined,
	callDaemon: (path: string, request: unknown, timeoutMs?: number) => Promise<unknown>,
): WebBotTarget[] {
	const primaryId = slugOfBotHome(homeDir, "main");
	const primaryHome = resolve(homeDir);
	const targets: WebBotTarget[] = [
		{
			id: primaryId,
			name: config?.channels.discord?.displayName ?? "송박",
			homeDir,
			callDaemon: (request, timeoutMs = WEB_IPC_TIMEOUT_MS) =>
				callDaemon(join(homeDir, "jabbu.sock"), request, timeoutMs),
			accent: accentForBot(primaryId, 0),
		},
	];
	const seenIds = new Set<string>([primaryId]);
	const seenHomes = new Set<string>([primaryHome]);
	for (const peer of config?.dashboard?.peerHomes ?? []) {
		const resolvedHome = resolve(peer.home);
		if (seenHomes.has(resolvedHome)) continue;
		const info = peerNameFromConfig(peer.home, peer.name);
		if (!info.enabled) continue;
		let id = slugOfBotHome(peer.home, peer.name.toLowerCase());
		if (seenIds.has(id)) id = `${id}-${targets.length + 1}`;
		seenIds.add(id);
		seenHomes.add(resolvedHome);
		targets.push({
			id,
			name: info.name,
			homeDir: peer.home,
			callDaemon: (request, timeoutMs = WEB_IPC_TIMEOUT_MS) =>
				callDaemon(join(peer.home, "jabbu.sock"), request, timeoutMs),
			accent: accentForBot(id, targets.length),
		});
	}
	return targets;
}

/** Reads lightweight conversation/approval/running counts for every configured web bot. */
export function summarizeWebBots(bots: readonly WebBotTarget[]): WebBotSummary[] {
	return bots.map((bot, idx) => {
		const convs = readWebConversations(bot.homeDir);
		let openApprovals = 0;
		let inProgress = false;
		for (const c of convs) {
			openApprovals += c.openApprovals;
			if (c.inProgress) inProgress = true;
		}
		return {
			id: bot.id,
			name: bot.name,
			accent: bot.accent ?? accentForBot(bot.id, idx),
			conversationCount: convs.length,
			openApprovals,
			inProgress,
		};
	});
}

/** Selects the requested bot target, falling back to `bots[0]` when `rawBotId` is omitted or empty. */
export function resolveBotTarget(
	bots: readonly WebBotTarget[],
	rawBotId: string | null | undefined,
): WebBotTarget | undefined {
	if (rawBotId === undefined || rawBotId === null || rawBotId.trim() === "") return bots[0];
	const needle = rawBotId.trim().toLowerCase();
	return bots.find((bot) => bot.id.toLowerCase() === needle);
}
