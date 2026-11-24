import { afterAll } from "bun:test";
import { appendFileSync, chmodSync, type Dirent, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_DIR_PREFIX = "ompbot-test-";
const SCRATCH_DIR_PATTERN = /^ompbot-test-(\d+)-/;

export type CleanupOptions = {
	uid?: number;
	isAlive?: (pid: number) => boolean;
	warn?: (message: string) => void;
};

/** Returns true if a process with the given PID is alive (or exists under another owner). */
export function isPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ESRCH") return false;
		// EPERM means the process still exists; treat unknown errors conservatively as alive.
		return true;
	}
}

function chmodTreeWritable(dirPath: string): void {
	try {
		chmodSync(dirPath, 0o700);
	} catch {
		// best effort
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const childPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			chmodTreeWritable(childPath);
		} else {
			try {
				chmodSync(childPath, 0o600);
			} catch {
				// best effort
			}
		}
	}
}

/** Removes a scratch directory, relaxing restrictive permissions once before retrying. */
export function removeScratchDir(dirPath: string, warn: (message: string) => void = console.warn): boolean {
	try {
		rmSync(dirPath, { recursive: true, force: true });
		return true;
	} catch {
		chmodTreeWritable(dirPath);
		try {
			rmSync(dirPath, { recursive: true, force: true });
			return true;
		} catch (retryError) {
			const message = retryError instanceof Error ? retryError.message : String(retryError);
			warn(`[test-preload] failed to remove ${dirPath}: ${message}`);
			return false;
		}
	}
}

/** Removes dead-PID `ompbot-test-<pid>-*` directories owned by the current user directly under `baseDir`. */
export function cleanupStaleScratchDirs(baseDir: string, options: CleanupOptions = {}): string[] {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const myUid = options.uid ?? process.getuid?.();
	const checkAlive = options.isAlive ?? isPidAlive;
	const removed: string[] = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(baseDir, { withFileTypes: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(`[test-preload] failed to read ${baseDir}: ${message}`);
		return removed;
	}

	for (const entry of entries) {
		const match = SCRATCH_DIR_PATTERN.exec(entry.name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0) continue;

		const fullPath = join(baseDir, entry.name);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(fullPath);
		} catch {
			// Skip vanished entries (e.g. concurrent worker cleanup).
			continue;
		}
		if (!stat.isDirectory()) continue;
		if (myUid !== undefined && stat.uid !== myUid) continue;
		if (checkAlive(pid)) continue;

		if (removeScratchDir(fullPath, warn)) {
			removed.push(fullPath);
		}
	}

	return removed;
}

// `bun test`(단일 프로세스)에서는 preload가 1회 실행되고 전역 afterAll이 모든 테스트 파일 종료 뒤 1회 실행된다.
// `bun test --parallel=3` 실측(Bun 1.4.5): Bun이 독립된 PID를 가진 워커 프로세스 3개를 띄우고,
// 각 워커는 담당 테스트 파일마다 preload를 실행한 뒤 해당 파일이 끝날 때 afterAll을 실행한다.
// afterAll에서 TMPDIR을 원래 값으로 먼저 되돌리고 scratch 디렉터리를 삭제하므로,
// 같은 워커의 다음 테스트 파일 preload도 원래 tmpdir()을 읽어 각자의 PID 기반 디렉터리를 만든다.
const originalTmpdir = tmpdir();
const hadOriginalEnvTmpdir = Object.hasOwn(process.env, "TMPDIR");
const originalEnvTmpdir = process.env.TMPDIR;

cleanupStaleScratchDirs(originalTmpdir);

const scratchDir = mkdtempSync(join(originalTmpdir, `${SCRATCH_DIR_PREFIX}${process.pid}-`));
process.env.TMPDIR = scratchDir;

/** One external-network attempt the guard saw (path: the fetch URL, or the WebSocket URL). */
export interface NetworkAttempt {
	kind: "fetch" | "websocket";
	url: string;
	at: string;
}

/** Every attempt the process-wide guard below recorded; `test/test-infra.test.ts` asserts it stays empty. */
export const networkAttempts: NetworkAttempt[] = [];

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0(?:\.0){3}|\[::1\]|::1)$/;

/** Whether `url` names a destination outside this machine (a relative URL is not a network destination). */
export function isExternalUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === "file:" || parsed.protocol === "data:" || parsed.protocol === "blob:") return false;
	const host = parsed.hostname.toLowerCase();
	return !(LOOPBACK_HOST.test(host) || host.endsWith(".localhost"));
}

/** What a guard wraps: the real globals, or a test's own placeholders shaped like them. */
export interface GuardTarget {
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	WebSocket: typeof WebSocket;
}

export type GuardMode = "record" | "block";

/** The URL a fetch input names, without trusting its shape beyond the two forms `fetch` takes. */
function fetchUrl(input: unknown): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") return input.url;
	return undefined;
}

/**
 * Replaces `target.fetch` and `target.WebSocket` with guarded versions: an external destination is recorded
 * (and, in `block` mode, thrown on) before the original runs; a fetch with `unix` is a unix socket and always
 * passes. Returns the undo, which puts the originals back.
 */
export function installNetworkGuard(
	target: GuardTarget,
	mode: GuardMode,
	record: (attempt: NetworkAttempt) => void,
): () => void {
	const originalFetch = target.fetch;
	const originalWebSocket = target.WebSocket;
	/** Records the attempt; returns the error `block` mode refuses with (absent: the call goes through). */
	const seen = (kind: NetworkAttempt["kind"], url: string): Error | undefined => {
		record({ kind, url, at: new Date().toISOString() });
		return mode === "block" ? new Error(`[test-net-guard] ${kind} to an external destination: ${url}`) : undefined;
	};
	// `fetch` never throws synchronously, so the refusal is a rejected promise: a caller that only awaits it
	// sees the same shape as a real network failure.
	const guardedFetch: GuardTarget["fetch"] = async (input, init) => {
		const url = fetchUrl(input);
		const unix = typeof init === "object" && init !== null && "unix" in init && typeof init.unix === "string";
		const refusal = !unix && url !== undefined && isExternalUrl(url) ? seen("fetch", url) : undefined;
		if (refusal !== undefined) throw refusal;
		return originalFetch(input, init);
	};
	// A callable stand-in for the class (a constructor function returning the real instance): `new` and
	// `instanceof` both keep working, and every static (CONNECTING, OPEN, ...) is copied onto it.
	function GuardedWebSocket(this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
		const refusal = isExternalUrl(String(url)) ? seen("websocket", String(url)) : undefined;
		if (refusal !== undefined) throw refusal;
		return new originalWebSocket(url, protocols);
	}
	// Statics (CONNECTING, OPEN, ...) come from the class itself; the shared prototype keeps `instanceof` true
	// for the real instances the wrapper returns.
	Object.setPrototypeOf(GuardedWebSocket, originalWebSocket);
	GuardedWebSocket.prototype = originalWebSocket.prototype;
	target.fetch = guardedFetch;
	target.WebSocket = GuardedWebSocket as unknown as typeof WebSocket; // a function proxy, not a class declaration
	return () => {
		target.fetch = originalFetch;
		target.WebSocket = originalWebSocket;
	};
}

// Stage 1 records only (Cataly's 2단계 plan): the count from a full suite run decides when `block` becomes the
// default. `OMPBOT_TEST_NET_GUARD=block` opts in today.
const guardMode: GuardMode = process.env.OMPBOT_TEST_NET_GUARD === "block" ? "block" : "record";
const guardFile = join(scratchDir, "network-attempts.jsonl");
installNetworkGuard(globalThis, guardMode, (attempt) => {
	networkAttempts.push(attempt);
	try {
		appendFileSync(guardFile, `${JSON.stringify(attempt)}\n`);
	} catch {
		// the scratch dir may already be gone at process exit; the in-memory list still has it
	}
});

afterAll(() => {
	if (hadOriginalEnvTmpdir && originalEnvTmpdir !== undefined) {
		process.env.TMPDIR = originalEnvTmpdir;
	} else {
		delete process.env.TMPDIR;
	}
	removeScratchDir(scratchDir);
});
