import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LiveView } from "../core/live-turn";
import { DEFAULT_APP_DATA_PREFIX } from "../omp/agy-account-pool";
import { readAgyPointer } from "../omp/agy-quota";
import { isRecord } from "../omp/type-guards";
import { maskPersonal, redact } from "../redact";
import { readJsonlRecords } from "./jsonl";
import type { PeerInstall } from "./peers";

/**
 * Peer routing (`<peer>:<origin>`) and `agy` transcript fallback (`agy-conversation.json` -> `transcript.jsonl`)
 * for the dashboard's 대화 tab and live stream. Read-only, every string masked before truncation.
 */

const PAGE = 20;
const OUTPUT_CHARS = 4000;
const SUMMARY_CHARS = 120;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,}$/;
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
const APP_DATA_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const SUMMARY_KEYS = ["toolSummary", "Path", "CommandLine", "query", "Description", "Action", "i"] as const;

export interface ThreadConversationOptions {
	peers?: readonly Pick<PeerInstall, "name" | "home">[];
	geminiDir?: string;
	appDataPrefix?: string;
}

type AgyToolPart = { kind: "tool"; name: string; summary: string; output: string; error: boolean; running?: true };
type AgyPart = { kind: "text" | "thinking"; text: string } | AgyToolPart;
interface AgyTurn {
	role: "user" | "assistant";
	ts: number;
	parts: AgyPart[];
}
interface AgyDialog {
	firstId: string;
	user?: { at: number; text: string };
	assistantAt?: number;
	parts: AgyPart[];
}

const mask = (text: string): string => maskPersonal(redact(text));
const cut = (text: string, limit: number): string => {
	const masked = mask(text);
	return masked.length > limit ? masked.slice(0, limit) : masked;
};
const isValidPrefix = (value: unknown): value is string =>
	typeof value === "string" && APP_DATA_PREFIX.test(value) && !value.includes("..");

/** Resolves `<peer>:<origin>` to `{ homeDir, originKey }`; returns `undefined` for an unknown peer prefix. */
function resolvePeerOrigin(
	homeDir: string,
	originKey: string,
	peers: readonly Pick<PeerInstall, "name" | "home">[] = [],
): { homeDir: string; originKey: string } | undefined {
	const colon = originKey.indexOf(":");
	if (colon >= 0 && !originKey.slice(0, colon).includes("/")) {
		const peer = peers.find((candidate) => candidate.name === originKey.slice(0, colon));
		if (peer !== undefined) return { homeDir: peer.home, originKey: originKey.slice(colon + 1) };
		if (peers.length > 0) return undefined;
	}
	return { homeDir, originKey };
}

/** Reads `live` view from the own or peer daemon socket; returns `null` for an unknown peer prefix. */
export async function readThreadLive(
	homeDir: string,
	originKey: string,
	ask: (socketPath: string, request: unknown, timeoutMs?: number) => Promise<unknown>,
	peers: readonly Pick<PeerInstall, "name" | "home">[] = [],
): Promise<LiveView | null> {
	const target = resolvePeerOrigin(homeDir, originKey, peers);
	if (target === undefined) return null;
	const answer = await ask(join(target.homeDir, "jabbu.sock"), { op: "live", origin: target.originKey }, 800);
	if (typeof answer !== "object" || answer === null || !("ok" in answer) || answer.ok !== true) {
		throw new Error("daemon live op failed");
	}
	return "live" in answer ? (answer.live as LiveView | null) : null;
}

/** Opens the own or peer `jabbu.db` read-only and returns `{ homeDir, sessionDir, sessionFile }` for `originKey`. */
export function lookupOriginSession(
	homeDir: string,
	originKey: string,
	peers?: readonly Pick<PeerInstall, "name" | "home">[],
):
	| { ok: true; homeDir: string; sessionDir: string; sessionFile: string | null }
	| { ok: false; error: "no_database" | "unknown_origin" } {
	const target = resolvePeerOrigin(homeDir, originKey, peers);
	if (target === undefined) return { ok: false, error: "unknown_origin" };
	const dbPath = join(target.homeDir, "jabbu.db");
	if (!existsSync(dbPath)) return { ok: false, error: "no_database" };
	const db = new Database(dbPath, { readonly: true, strict: true });
	try {
		const origin = db
			.query<{ session_dir: string; session_file: string | null }, [string]>(
				"SELECT session_dir, session_file FROM origins WHERE origin_key = ?",
			)
			.get(target.originKey);
		if (origin === null) return { ok: false, error: "unknown_origin" };
		return { ok: true, homeDir: target.homeDir, sessionDir: origin.session_dir, sessionFile: origin.session_file };
	} finally {
		db.close();
	}
}

function readAppDataPrefix(homeDir: string): { present: boolean; valid: boolean; value?: string } {
	const path = join(homeDir, "config.json");
	if (!existsSync(path)) return { present: false, valid: true };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.agyAccounts) || parsed.agyAccounts.appDataPrefix === undefined) {
			return { present: false, valid: true };
		}
		const prefix = parsed.agyAccounts.appDataPrefix;
		return isValidPrefix(prefix) ? { present: true, valid: true, value: prefix } : { present: true, valid: false };
	} catch {
		return { present: false, valid: true };
	}
}

/** Resolves `<geminiDir>/<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` from `agy-conversation.json`. */
export function agyTranscriptFile(
	sessionDir: string,
	homeDir: string,
	options?: Pick<ThreadConversationOptions, "geminiDir" | "appDataPrefix">,
): string | undefined {
	const pointer = readAgyPointer(join(sessionDir, "agy-conversation.json"));
	if (pointer === undefined || !CONVERSATION_ID.test(pointer.conversationId)) return undefined;
	let appDataDir = "antigravity-cli";
	if (pointer.account !== undefined) {
		if (!ACCOUNT_NAME.test(pointer.account)) return undefined;
		let prefix: string;
		if (options?.appDataPrefix !== undefined) {
			if (!isValidPrefix(options.appDataPrefix)) return undefined;
			prefix = options.appDataPrefix;
		} else {
			const configured = readAppDataPrefix(homeDir);
			if (configured.present && !configured.valid) return undefined;
			prefix = configured.value ?? DEFAULT_APP_DATA_PREFIX;
		}
		appDataDir = `${prefix}${pointer.account}`;
	}
	const geminiDir = options?.geminiDir ?? join(process.env.HOME ?? homedir(), ".gemini");
	const file = join(
		geminiDir,
		appDataDir,
		"brain",
		pointer.conversationId,
		".system_generated",
		"logs",
		"transcript.jsonl",
	);
	return existsSync(file) ? file : undefined;
}

function extractUserRequest(raw: string): string {
	const openTag = "<USER_REQUEST>";
	const closeTag = "</USER_REQUEST>";
	const start = raw.indexOf(openTag);
	const end = start >= 0 ? raw.lastIndexOf(closeTag) : -1;
	return start >= 0 && end > start ? raw.slice(start + openTag.length, end).trim() : raw.trim();
}

function unquoteArg(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "string") return parsed;
		} catch {
			// keep raw string
		}
	}
	return value;
}

function toolSummaryOf(args: unknown): string {
	if (!isRecord(args)) return "";
	for (const key of SUMMARY_KEYS) {
		const value = unquoteArg(args[key]);
		if (value !== undefined && value.trim() !== "") return value.trim();
	}
	return Object.keys(args).length > 0 ? JSON.stringify(args).replace(/\s+/g, " ") : "";
}

/** Reads an `agy` `transcript.jsonl` into masked dialog turns matching `readSessionConversation`. */
export function readAgyConversation(file: string, before?: string): { ok: true; turns: AgyTurn[]; cursor?: string } {
	const entries = readJsonlRecords(file);
	const dialogs: AgyDialog[] = [];
	let pendingTools: AgyToolPart[] = [];
	entries.forEach((entry, index) => {
		const at = Date.parse(typeof entry.created_at === "string" ? entry.created_at : "");
		if (Number.isNaN(at)) return;
		const id = typeof entry.step_index === "number" ? `s${entry.step_index}` : `#${index}`;
		if (entry.type === "USER_INPUT") {
			pendingTools = [];
			dialogs.push({
				firstId: id,
				user: { at, text: typeof entry.content === "string" ? extractUserRequest(entry.content) : "" },
				parts: [],
			});
			return;
		}
		if (entry.type === "PLANNER_RESPONSE") {
			pendingTools = [];
			if (dialogs.length === 0) dialogs.push({ firstId: id, parts: [] });
			const dialog = dialogs[dialogs.length - 1];
			if (dialog === undefined) return;
			dialog.assistantAt ??= at;
			if (typeof entry.thinking === "string" && entry.thinking.trim() !== "") {
				dialog.parts.push({ kind: "thinking", text: mask(entry.thinking) });
			}
			if (typeof entry.content === "string" && entry.content.trim() !== "") {
				dialog.parts.push({ kind: "text", text: mask(entry.content) });
			} else if (entry.status === "ERROR" && typeof entry.error === "string" && entry.error.trim() !== "") {
				dialog.parts.push({ kind: "text", text: mask(entry.error) });
			}
			if (Array.isArray(entry.tool_calls)) {
				for (const call of entry.tool_calls) {
					if (!isRecord(call)) continue;
					const tool: AgyToolPart = {
						kind: "tool",
						name: typeof call.name === "string" ? mask(call.name) : "tool",
						summary: cut(toolSummaryOf(call.args), SUMMARY_CHARS),
						output: "",
						error: false,
						running: true,
					};
					dialog.parts.push(tool);
					pendingTools.push(tool);
				}
			}
			return;
		}
		if (entry.type === "GENERIC") {
			const tool = pendingTools.shift();
			if (tool === undefined) return;
			const raw =
				typeof entry.content === "string" && entry.content !== ""
					? entry.content
					: typeof entry.error === "string"
						? entry.error
						: "";
			tool.output = cut(raw, OUTPUT_CHARS);
			const status = typeof entry.status === "string" ? entry.status : "";
			if (status === "RUNNING") {
				tool.running = true;
				tool.error = false;
			} else {
				delete tool.running;
				tool.error = status === "ERROR";
			}
		}
	});
	const end = before === undefined ? dialogs.length : dialogs.findIndex((dialog) => dialog.firstId === before);
	const stop = Math.max(0, end);
	const startAt = Math.max(0, stop - PAGE);
	const page = dialogs.slice(startAt, stop);
	const turns: AgyTurn[] = [];
	for (const dialog of page) {
		if (dialog.user !== undefined) {
			turns.push({
				role: "user",
				ts: dialog.user.at,
				parts: dialog.user.text === "" ? [] : [{ kind: "text", text: mask(dialog.user.text) }],
			});
		}
		if (dialog.assistantAt !== undefined && dialog.parts.length > 0) {
			turns.push({ role: "assistant", ts: dialog.assistantAt, parts: dialog.parts });
		}
	}
	const cursor = startAt > 0 ? page[0]?.firstId : undefined;
	return { ok: true, turns, ...(cursor === undefined ? {} : { cursor }) };
}
