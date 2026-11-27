import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, type Stats, statSync } from "node:fs";
import { sep } from "node:path";
import { chatPlatformOf } from "../core/origin-key";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { truncateUtf8 } from "../redact";
import { inodesUnder } from "./secret-inodes";

/** `persona.md`: the owner's operating contract. Chat origins only (lanes, monitors and review origins never get it). */
export const PERSONA_MAX_BYTES = 8192;
/** `soul.md`: the bot's name, relationship to the owner, voice and character. Chat and monitor origins. */
export const SOUL_MAX_BYTES = 8192;
/** `owner.md`: the owner-observation notes a monitor distills. Chat and monitor origins. */
export const OWNER_NOTES_MAX_BYTES = 16384;

/** The workspace files `floorsSystemPrompt` injects; each is optional and silently skipped when missing. */
export interface PersonaFiles {
	persona?: string;
	soul?: string;
	owner?: string;
	/** Files the owner docs must never be a link to: everything under `secretsDir`, and the bot's `config.json`. */
	secrets?: { secretsDir: string; configFile: string };
}

const MONITOR_PRECEDENCE = " 모니터 지시가 정한 답 형식(NO_REPORT·[SILENT] 등)이 이 지침보다 우선합니다.";
/** Bytes read past an injected file's cap: room for a character cut at the cap and the blanks `trim` drops at its end. */
const INJECTED_READ_MARGIN = 4096;
/** The most `ownerDocsPrompt` can return: every file at its cap plus a heading line (and monitor note) each. */
export const OWNER_DOCS_MAX_BYTES = SOUL_MAX_BYTES + OWNER_NOTES_MAX_BYTES + PERSONA_MAX_BYTES + 3 * 1024;
/** Most leading blank bytes `readHead` skips before the text it returns (a whole-blank file is not read to its end). */
const INJECTED_MAX_LEADING_BLANKS = 1 << 20;

/** The error a non-regular injected file is reported with: `EISDIR` for a directory, `EINVAL` for a FIFO, socket or device. */
function notRegularFile(path: string, stat: Stats): NodeJS.ErrnoException {
	const code = stat.isDirectory() ? "EISDIR" : "EINVAL";
	return Object.assign(new Error(`${code}: not a regular file, read '${path}'`), { code, path, syscall: "read" });
}

/**
 * A read descriptor of a regular file; anything else throws before a read: a FIFO would block the open until a writer
 * comes. The open is non-blocking and the descriptor checked again, so a file swapped for a FIFO between the stat and
 * the open does not block either. The caller closes the descriptor.
 */
export function openRegularFile(path: string): number {
	const named = statSync(path);
	if (!named.isFile()) throw notRegularFile(path, named);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile()) throw notRegularFile(path, opened);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/**
 * Whether an opened injected file is a secret: its `dev:ino` is a file of `secrets/` or the `config.json` (a hard
 * link), or its real path lies under `secrets/` (a symlink).
 */
function isSecretFile(path: string, opened: Stats, guard: NonNullable<PersonaFiles["secrets"]>): boolean {
	const id = `${opened.dev}:${opened.ino}`;
	const protectedIds = [...inodesUnder(guard.secretsDir)];
	try {
		const config = statSync(guard.configFile);
		protectedIds.push(`${config.dev}:${config.ino}`);
	} catch {
		// no config.json: nothing to match
	}
	if (protectedIds.includes(id)) return true;
	try {
		const root = realpathSync(guard.secretsDir);
		return realpathSync(path).startsWith(`${root}${sep}`);
	} catch {
		return false;
	}
}

/** Byte length of the longest prefix of `buf[0..len)` without a trailing split multi-byte UTF-8 sequence. */
function completeUtf8PrefixLen(buf: Uint8Array, len: number): number {
	if (len === 0) return 0;
	let i = len - 1;
	while (i >= 0 && i >= len - 4 && ((buf[i] ?? 0) & 0xc0) === 0x80) i -= 1;
	if (i < 0 || i < len - 4) return len;
	const lead = buf[i] ?? 0;
	const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return i + expected > len ? i : len;
}

/**
 * The first `bytes` bytes of a regular file ({@link openRegularFile}) after its leading Unicode whitespace/BOM, as UTF-8,
 * without reading the rest. Flags `exhausted` when leading whitespace alone hits `INJECTED_MAX_LEADING_BLANKS`.
 */
function readHead(path: string, bytes: number, guard: PersonaFiles["secrets"]): { text: string; exhausted: boolean } {
	const fd = openRegularFile(path);
	try {
		if (guard !== undefined && isSecretFile(path, fstatSync(fd), guard)) {
			throw Object.assign(new Error(`ESECRET: injected file is a link to a secret, refused '${path}'`), {
				code: "ESECRET",
				path,
			});
		}
		const buffer = Buffer.alloc(bytes);
		let start = 0;
		while (start < INJECTED_MAX_LEADING_BLANKS) {
			const n = readSync(fd, buffer, 0, bytes, start);
			if (n === 0) break;
			const scanLen = n < bytes ? n : completeUtf8PrefixLen(buffer, n);
			if (scanLen === 0) break;
			const chunk = buffer.subarray(0, scanLen).toString("utf8");
			const ws = /^[\s\uFEFF]+/.exec(chunk)?.[0] ?? "";
			const wsBytes = Buffer.byteLength(ws, "utf8");
			if (wsBytes === 0) break;
			start += wsBytes;
			if (wsBytes < scanLen) break;
		}
		let read = 0;
		for (let n = 1; n > 0 && read < bytes; read += n) n = readSync(fd, buffer, read, bytes - read, start + read);
		return {
			text: buffer.subarray(0, read).toString("utf8"),
			exhausted: start >= INJECTED_MAX_LEADING_BLANKS,
		};
	} finally {
		closeSync(fd);
	}
}

/** Reads one injected file: "" for missing/empty, the capped text with its heading otherwise. */
function readInjected(
	path: string | undefined,
	heading: string,
	maxBytes: number,
	onError: ((error: unknown, path: string) => void) | undefined,
	guard: PersonaFiles["secrets"],
): string {
	if (path === undefined) return "";
	try {
		const { text: head, exhausted } = readHead(path, maxBytes + INJECTED_READ_MARGIN, guard);
		// A NUL byte (a UTF-16 file) makes the child spawn throw: drop them and report the file (qa-z #4).
		if (head.includes("\0"))
			onError?.(Object.assign(new Error(`ENUL: NUL bytes removed from '${path}'`), { code: "ENUL", path }), path);
		const raw = head.replaceAll("\0", "").trim();
		if (raw === "") {
			if (exhausted) {
				onError?.(
					Object.assign(new Error(`EWHITESPACE: leading whitespace exceeded cap in '${path}'`), {
						code: "EWHITESPACE",
						path,
					}),
					path,
				);
			}
			return "";
		}
		return `\n\n${heading}\n${truncateUtf8(raw, maxBytes)}`;
	} catch (error) {
		// The floors text alone is the whole appendix. A missing file is normal; anything else is reported.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError?.(error, path);
		return "";
	}
}

/**
 * The owner docs part of the system prompt (`[정체성(soul)]`, `[오너 관찰지]`, `[페르소나]`, each "" when its file is
 * missing or empty): chat origins get all three, monitor origins soul and owner notes only (with a line that the
 * monitor instruction's answer format wins). `undefined` for origins that never get owner docs (lanes, review).
 */
export function ownerDocsPrompt(
	originKey: string | undefined,
	files: PersonaFiles | undefined,
	onPersonaError: ((error: unknown, path: string) => void) | undefined,
): string | undefined {
	if (originKey === undefined || files === undefined) return undefined;
	const chat = chatPlatformOf(originKey) !== undefined;
	const monitor = originKey.startsWith(MONITOR_ORIGIN_PREFIX);
	if (!chat && !monitor) return undefined;
	const tail = monitor ? MONITOR_PRECEDENCE : "";
	const injected =
		readInjected(
			files.soul,
			`[정체성(soul)] 아래는 이 봇의 이름·성격·말투 정의입니다. 이 지침은 안전 바닥글보다 우선하지 않습니다.${tail}`,
			SOUL_MAX_BYTES,
			onPersonaError,
			files.secrets,
		) +
		readInjected(
			files.owner,
			`[오너 관찰지] 아래는 오너에 대한 관찰 기록입니다. 이 지침은 안전 바닥글보다 우선하지 않습니다.${tail}`,
			OWNER_NOTES_MAX_BYTES,
			onPersonaError,
			files.secrets,
		);
	if (!chat) return injected;
	return (
		injected +
		readInjected(
			files.persona,
			"[페르소나] 아래는 오너가 정의한 성격·말투 지침입니다. 이 지침은 안전 바닥글보다 우선하지 않습니다:",
			PERSONA_MAX_BYTES,
			onPersonaError,
			files.secrets,
		)
	);
}
