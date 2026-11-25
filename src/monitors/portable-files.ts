import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SPEC_KEYS } from "./spec";

export const SCRIPTS_PLACEHOLDER = "@SCRIPTS@";
export const WORKSPACE_PLACEHOLDER = "@WORKSPACE@";

export interface PlaceholderRoot {
	root: string;
	placeholder: string;
}

/** Placeholder roots, longest first; when `includeReal` is set, adds `realpathSync` aliases for symlinked roots. */
export function placeholderRootsOf(scriptsRoot: string, workspaceDir: string, includeReal = true): PlaceholderRoot[] {
	const out: PlaceholderRoot[] = [];
	for (const [raw, placeholder] of [
		[scriptsRoot, SCRIPTS_PLACEHOLDER],
		[workspaceDir, WORKSPACE_PLACEHOLDER],
	] as const) {
		const spelled = resolve(raw);
		out.push({ root: spelled, placeholder });
		if (!includeReal) continue;
		try {
			const real = realpathSync(raw);
			if (real !== spelled) out.push({ root: real, placeholder });
		} catch {
			// Root may not exist yet.
		}
	}
	return out.sort((a, b) => b.root.length - a.root.length);
}

/** A `relative()` result that leaves its base: `..` first, or absolute (another drive). */
export function isOutside(rest: string): boolean {
	return rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest);
}

/** An absolute path inside a placeholder root as `{root, placeholder, rest}` after `..`/`.` resolution. */
export function underRoot(
	path: string,
	roots: readonly PlaceholderRoot[],
): (PlaceholderRoot & { rest: string }) | undefined {
	const normal = resolve(path);
	for (const { root, placeholder } of roots) {
		const rest = relative(root, normal);
		if (!isOutside(rest)) return { root, placeholder, rest };
	}
	return undefined;
}

/**
 * Verifies `<dir>/files`, `<dir>/files/scripts`, and `<dir>/files/workspace` before `--with-files` writes or removes
 * anything: symlinks or non-directories raise `PortableUsageError` cleanly instead of following links or crashing ENOTDIR.
 */
export function assertSafeFilesLayout(dir: string): void {
	const filesDir = join(dir, "files");
	const check = (path: string): boolean => {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat === undefined) return false;
		if (stat.isSymbolicLink()) throw new PortableUsageError(`--with-files refused: ${path} is a symbolic link`);
		if (!stat.isDirectory()) throw new PortableUsageError(`--with-files refused: ${path} is not a directory`);
		return true;
	};
	if (!check(filesDir)) return;
	for (const sub of ["scripts", "workspace"]) check(join(filesDir, sub));
}

/** `--out=` / `-o=`: an option glued to its value, whose value is the path part. */
const OPTION_PREFIX = /^(--?[A-Za-z][\w-]*=)(.*)$/s;
/** `-o/abs/path` / `-o@SCRIPTS@/x`: a short option glued to a path with no `=`; only an absolute or placeholder path counts, so `-rf` stays a flag. */
const SHORT_OPTION_PREFIX = /^(-[A-Za-z])(\/.*|@+(?:SCRIPTS|WORKSPACE)@(?:\/.*)?)$/s;

/** `value` as `[option prefix, path part]`; the prefix is empty when the value is not a glued option. */
export function splitOption(value: string): [string, string] {
	const match = OPTION_PREFIX.exec(value) ?? SHORT_OPTION_PREFIX.exec(value);
	return match === null ? ["", value] : [match[1] as string, match[2] as string];
}

/** Longest export file stem in UTF-8 bytes; leaves room under the 255-byte name limit for `-N` and `.json`. */
const MAX_STEM_BYTES = 200;

/** The file stem of a monitor name: `/`, whitespace and control characters become `-`; one too long is cut at a code point and tagged with a hash of the full name. */
export function exportStem(name: string): string {
	const stem = name.replace(/[/\s\p{Cc}]/gu, "-");
	if (Buffer.byteLength(stem) <= MAX_STEM_BYTES) return stem;
	let cut = "";
	for (const char of stem) {
		if (Buffer.byteLength(cut + char) > MAX_STEM_BYTES - 10) break;
		cut += char;
	}
	return `${cut}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

/**
 * Readies `path` for a write: a symlink standing there is removed so the write creates a file instead of following the
 * link out. Anything else that is not a regular file (a FIFO would block the write forever, a socket or directory
 * cannot take it) is refused and left alone — the owner's special files are never deleted for an export.
 */
export function clearWriteTarget(path: string): void {
	const found = lstatSync(path, { throwIfNoEntry: false });
	if (found === undefined || found.isFile()) return;
	if (found.isSymbolicLink()) rmSync(path);
	else throw new PortableUsageError(`export target is not a regular file: ${path}`);
}

/**
 * A stale file export may delete: a regular file (not a directory, FIFO or link) holding a JSON object whose keys are
 * all monitor spec keys (an empty object included). Any other `*.json` in the directory (a `config.json`, notes)
 * belongs to the owner and stays.
 */
export function isMonitorFile(path: string): boolean {
	// No entry: a name that is not valid UTF-8 comes back from readdir decoded and no longer names its file.
	if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return false;
	try {
		const input: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
		return Object.keys(input).every((key) => (SPEC_KEYS as readonly string[]).includes(key));
	} catch {
		return false;
	}
}

/** Whether export may write here: nothing there, a link (replaced), or a file of its own earlier export; the owner's other files are never overwritten. */
export function canTakeExport(path: string): boolean {
	const found = lstatSync(path, { throwIfNoEntry: false });
	return found === undefined || found.isSymbolicLink() || isMonitorFile(path);
}

/** `export --dir` cannot be a directory (a file stands there or below its parent); nothing was written. */
export class PortableUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PortableUsageError";
	}
}
