import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSweepHeartbeat } from "../daemon/heartbeat";
import { holderAlive } from "../daemon/lock";
import type { Gate, GateState, GatesOptions } from "../ops/gates";
import { redact } from "../redact";
import type { PeerInstall } from "./peers";

const HEARTBEAT_ALIVE_MS = 5 * 60_000;
const TURN_WINDOW_MS = 24 * 3_600_000;
const ERROR_CHARS = 160;
const ACCOUNT_CHARS = 40;

/** Read-only status summary of one peer install (`dashboard.peerHomes`). */
export interface PeerHealthInfo {
	name: string;
	running: boolean;
	heartbeatAgeMs?: number;
	discord?: "up" | "down";
	draining?: boolean;
	turns24h?: { answered: number; open: number; failed: number };
	openAlerts: number;
	agyAccount?: { current: string; blockedCount: number };
	error?: string;
}

/** One alerted incident read from the primary or a peer install's `jabbu.db`. */
export interface PeerAlertInfo {
	install?: string;
	scope: string;
	signature: string;
	count: number;
	lastAt: string;
	incidentId: number;
	firstAt: string;
	status: string;
	gateState?: GateState | "unknown";
}

function lockAlive(homeDir: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(join(homeDir, "jabbu.lock"), "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null) return false;
		const { pid, bootId } = raw as { pid?: unknown; bootId?: unknown };
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
		return holderAlive(pid, typeof bootId === "string" ? bootId : undefined);
	} catch {
		return false;
	}
}

function expandHomePath(raw: string): string | undefined {
	if (raw.includes("secrets")) return undefined;
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return raw.startsWith("/") ? raw : undefined;
}

function readAgyAccount(homeDir: string, now: number): PeerHealthInfo["agyAccount"] {
	try {
		const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8")) as unknown;
		if (typeof cfg !== "object" || cfg === null) return undefined;
		const stateRaw = (cfg as { agyAccounts?: { statePath?: unknown } }).agyAccounts?.statePath;
		if (typeof stateRaw !== "string" || stateRaw.trim() === "") return undefined;
		const resolved = expandHomePath(stateRaw.trim());
		if (resolved === undefined || !existsSync(resolved)) return undefined;
		const state = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
		if (typeof state !== "object" || state === null) return undefined;
		const { current, blocked } = state as { current?: unknown; blocked?: unknown };
		if (typeof current !== "string" || current.trim() === "") return undefined;
		let blockedCount = 0;
		if (typeof blocked === "object" && blocked !== null && !Array.isArray(blocked)) {
			for (const until of Object.values(blocked)) {
				if (typeof until === "number" && Number.isFinite(until) && until > now) blockedCount += 1;
			}
		}
		return { current: redact(current.trim()).slice(0, ACCOUNT_CHARS), blockedCount };
	} catch {
		return undefined;
	}
}

function safeCount(db: Database, sql: string, ...params: Array<string | number>): number {
	try {
		const row = db.query(sql).get(...params) as { n?: number | null } | null;
		return Number(row?.n ?? 0);
	} catch {
		return 0;
	}
}

/** Collects read-only health, 24h turn outcomes, open alert counts, and active AGY quota slot per peer install. */
export function readPeerHealth(peers: readonly PeerInstall[], now: number): PeerHealthInfo[] {
	const since = now - TURN_WINDOW_MS;
	return peers.map((peer) => {
		const beat = readSweepHeartbeat(peer.home);
		const heartbeatAgeMs = beat === undefined ? undefined : Math.max(0, now - beat.ts.getTime());
		const running = lockAlive(peer.home) || (heartbeatAgeMs !== undefined && heartbeatAgeMs <= HEARTBEAT_ALIVE_MS);
		const agyAccount = readAgyAccount(peer.home, now);
		const dbPath = join(peer.home, "jabbu.db");
		let turns24h: PeerHealthInfo["turns24h"];
		let openAlerts = 0;
		let error = peer.configError ? redact(peer.configError).slice(0, ERROR_CHARS) : undefined;
		if (existsSync(dbPath)) {
			let db: Database | undefined;
			try {
				db = new Database(dbPath, { readonly: true, strict: true });
				try {
					const row = db
						.query(
							`SELECT
								COALESCE(SUM(CASE WHEN state = 'answered' THEN 1 ELSE 0 END), 0) AS answered,
								COALESCE(SUM(CASE WHEN state IN ('pending','sending','dispatched','uncertain') THEN 1 ELSE 0 END), 0) AS open,
								COALESCE(SUM(CASE WHEN state = 'failed_notified' THEN 1 ELSE 0 END), 0) AS failed
							 FROM inbound WHERE COALESCE(last_event_at, dispatched_at, created_at) >= ?`,
						)
						.get(since) as { answered: number; open: number; failed: number } | null;
					if (row !== null) {
						turns24h = { answered: Number(row.answered), open: Number(row.open), failed: Number(row.failed) };
					}
				} catch {
					// database predates inbound table
				}
				openAlerts = safeCount(db, "SELECT COUNT(*) AS n FROM alert_incidents WHERE status = 'alerted'");
			} catch (err) {
				const msg = redact(err instanceof Error ? err.message : String(err))
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, ERROR_CHARS);
				error = error === undefined ? msg : `${error}; ${msg}`.slice(0, ERROR_CHARS);
			} finally {
				db?.close();
			}
		} else {
			error = error === undefined ? "jabbu.db가 없음" : error;
		}
		return {
			name: peer.name,
			running,
			...(heartbeatAgeMs === undefined ? {} : { heartbeatAgeMs }),
			...(beat?.discord === undefined ? {} : { discord: beat.discord.state }),
			...(beat?.draining === undefined ? {} : { draining: beat.draining }),
			...(turns24h === undefined ? {} : { turns24h }),
			openAlerts,
			...(agyAccount === undefined ? {} : { agyAccount }),
			...(error === undefined ? {} : { error }),
		};
	});
}

/** Reads `alerted` incidents from a single install's `jabbu.db`, resolving `gate:` states lazily. */
export function readInstallAlerts(
	db: Database,
	iso: (ms: number) => string,
	getGates: () => readonly Gate[] | undefined,
	install?: string,
): PeerAlertInfo[] {
	const rows = db
		.query(
			"SELECT incident_id, scope, signature, status, count, first_at, last_at FROM alert_incidents WHERE status = 'alerted' ORDER BY last_at DESC",
		)
		.all() as Array<{
		incident_id: number;
		scope: string;
		signature: string;
		status: string;
		count: number;
		first_at: number;
		last_at: number;
	}>;
	let gates: readonly Gate[] | undefined;
	let loaded = false;
	return rows.map((r) => {
		let gateState: GateState | "unknown" | undefined;
		if (r.scope.startsWith("gate:")) {
			if (!loaded) {
				loaded = true;
				gates = getGates();
			}
			const name = r.scope.slice(5);
			gateState = gates?.find((g) => g.name === name)?.state ?? "unknown";
		}
		return {
			...(install === undefined ? {} : { install }),
			scope: r.scope,
			signature: redact(r.signature),
			count: r.count,
			lastAt: iso(r.last_at),
			incidentId: r.incident_id,
			firstAt: iso(r.first_at),
			status: r.status,
			...(gateState === undefined ? {} : { gateState }),
		};
	});
}

/** Reads `alerted` incidents from each peer install's `jabbu.db`, resolving `gate:` states against that peer's home. */
export function readPeerAlerts(
	peers: readonly PeerInstall[],
	now: number,
	iso: (ms: number) => string,
	collect: (options: GatesOptions) => Gate[],
): PeerAlertInfo[] {
	const out: PeerAlertInfo[] = [];
	for (const peer of peers) {
		const dbPath = join(peer.home, "jabbu.db");
		if (!existsSync(dbPath)) continue;
		let db: Database | undefined;
		try {
			db = new Database(dbPath, { readonly: true, strict: true });
			out.push(
				...readInstallAlerts(
					db,
					iso,
					() => {
						try {
							return collect({ homeDir: peer.home, now });
						} catch {
							return [];
						}
					},
					peer.name,
				),
			);
		} catch {
			// missing table or unreadable peer db: never fail the primary alerts section
		} finally {
			db?.close();
		}
	}
	return out;
}
