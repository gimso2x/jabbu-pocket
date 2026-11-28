/**
 * `jabbu-pocket omp sync`: the profile-sync half of the omp CLI (split out of `omp.ts`, which keeps
 * trial/status/command). Mirrors the owner's agent dir into the bot profile.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backupSkillRevision, SKILL_REVISIONS_DIR } from "../review/skills";

/** `<home>/omp/last-sync`: when `omp sync` last ran. */
export const lastSyncPath = (homeDir: string): string => join(homeDir, "omp", "last-sync");
/** omp's agent dir of `OMP_PROFILE=<profile>` (`~/.omp/profiles/<profile>/agent`). */
export const profileAgentDir = (userHome: string, profile: string): string =>
	join(userHome, ".omp", "profiles", profile, "agent");
/** The owner's agent dir, the sync source: `PI_CODING_AGENT_DIR`, else `~/.omp/agent`. */
export const sourceAgentDir = (env: Record<string, string | undefined>): string =>
	env.PI_CODING_AGENT_DIR ?? join(userHomeOf(env), ".omp", "agent");
export const userHomeOf = (env: Record<string, string | undefined>): string => env.HOME ?? homedir();

function readLink(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- profile sync

/** Entries mirrored from the owner's agent dir on every sync (removed from the profile when the owner has none). */
const SYNC_MIRRORED = ["RULES.md", "extensions", "skills", "models.yml", "mcp.json"] as const;
/** The login store: always symlinks to the owner's files, never copies (two copies would refresh OAuth tokens apart). */
const SYNC_LOGIN_LINKS = ["agent.db", "agent.db-shm", "agent.db-wal"] as const;
/** Names never copied inside a mirrored tree. */
const SKIPPED_NAME = /\.bak/;

interface SyncResult {
	/** One line per change (`copied <path>`, `removed <path>`, `linked <path>`, …). */
	changed: string[];
	warnings: string[];
}

interface SyncContext {
	dryRun: boolean;
	result: SyncResult;
	/** Revision timestamps for snapshots taken before an overwrite. */
	now: () => number;
}

function lstatOrUndefined(path: string): Stats | undefined {
	return lstatSync(path, { throwIfNoEntry: false });
}

function sameFile(a: string, b: string): boolean {
	const sa = statSync(a);
	const sb = statSync(b);
	return (sa.mode & 0o777) === (sb.mode & 0o777) && sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
}

function remove(path: string, rel: string, ctx: SyncContext): void {
	ctx.result.changed.push(`removed ${rel}`);
	if (!ctx.dryRun) rmSync(path, { recursive: true, force: true });
}

/**
 * Makes `dst` the same as `src`: files by content and mode, directories entry by entry (profile-only entries removed),
 * symlinks re-created as absolute links to the source link's real path (a relative link breaks two levels deeper).
 * A broken source link is skipped with a warning and leaves the profile's entry alone. Entries `keep` names are left
 * alone in both directions (used for a managed skill's `revisions/`, which the profile owns).
 */
function mirror(src: string, dst: string, rel: string, ctx: SyncContext, keep?: (name: string) => boolean): void {
	const s = lstatOrUndefined(src);
	const d = lstatOrUndefined(dst);
	if (s === undefined) {
		if (d !== undefined) remove(dst, rel, ctx);
		return;
	}
	if (s.isSymbolicLink()) {
		let real: string;
		try {
			real = realpathSync(src);
		} catch {
			ctx.result.warnings.push(`skipped broken link ${rel} -> ${readLink(src) ?? "?"}`);
			return;
		}
		if (d?.isSymbolicLink() && readLink(dst) === real) return;
		ctx.result.changed.push(`linked ${rel} -> ${real}`);
		if (ctx.dryRun) return;
		if (d !== undefined) rmSync(dst, { recursive: true, force: true });
		symlinkSync(real, dst);
		return;
	}
	if (s.isDirectory()) {
		if (d !== undefined && !d.isDirectory()) remove(dst, rel, ctx);
		const present = d?.isDirectory() === true;
		if (!present) {
			ctx.result.changed.push(`created ${rel}/`);
			if (!ctx.dryRun) mkdirSync(dst, { recursive: true, mode: s.mode & 0o777 });
		}
		const names = new Set(readdirSync(src));
		if (present) for (const name of readdirSync(dst)) names.add(name);
		for (const name of [...names].sort()) {
			if (SKIPPED_NAME.test(name)) continue;
			if (keep?.(name)) continue;
			mirror(join(src, name), join(dst, name), `${rel}/${name}`, ctx, keep);
		}
		return;
	}
	if (!s.isFile()) return;
	if (d?.isFile() && sameFile(src, dst)) return;
	ctx.result.changed.push(`copied ${rel}`);
	if (ctx.dryRun) return;
	if (d !== undefined && !d.isFile()) rmSync(dst, { recursive: true, force: true });
	copyFileSync(src, dst);
	chmodSync(dst, s.mode & 0o777);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `config.yml` text with every path into the owner's agent dir (`~/.omp/agent`, its absolute form, the source) moved to `target`. */
function rewriteAgentPaths(text: string, source: string, target: string, userHome: string): string {
	const forms = [...new Set(["~/.omp/agent", join(userHome, ".omp", "agent"), resolve(source)])];
	const pattern = new RegExp(`(?:${forms.map(escapeRegExp).join("|")})(?=/|["'\\s,\\]}]|$)`, "gm");
	return text.replace(pattern, target);
}

function sha256(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** A consistent copy of one SQLite file (`VACUUM INTO`), readable while the owner's omp writes to it. */
function vacuumInto(src: string, dst: string): void {
	const db = new Database(src, { readonly: true });
	try {
		db.run("VACUUM INTO ?", [dst]);
	} finally {
		db.close();
	}
	chmodSync(dst, 0o600);
}

/** `--init` only: the owner's mnemopi memory (main db and `banks/`), copied once when the profile has none. */
function initMemory(source: string, target: string, ctx: SyncContext): void {
	const srcDir = join(source, "memories", "mnemopi");
	const dstDir = join(target, "memories", "mnemopi");
	if (!existsSync(join(srcDir, "mnemopi.db")) || existsSync(join(dstDir, "mnemopi.db"))) return;
	const banksDir = join(srcDir, "banks");
	const banks = existsSync(banksDir)
		? readdirSync(banksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
		: [];
	ctx.result.changed.push(`copied memories/mnemopi (banks=${banks.length})`);
	if (ctx.dryRun) return;
	mkdirSync(dstDir, { recursive: true, mode: 0o700 });
	for (const bank of banks) {
		const from = join(banksDir, bank.name);
		const to = join(dstDir, "banks", bank.name);
		mkdirSync(to, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(from, { withFileTypes: true })) {
			if (!entry.isFile() || /\.db-(?:wal|shm)$/.test(entry.name) || SKIPPED_NAME.test(entry.name)) continue;
			if (entry.name.endsWith(".db")) vacuumInto(join(from, entry.name), join(to, entry.name));
			else copyFileSync(join(from, entry.name), join(to, entry.name));
		}
	}
	// The main db last: its presence marks a finished init.
	vacuumInto(join(srcDir, "mnemopi.db"), join(dstDir, "mnemopi.db"));
}

/**
 * Saves the profile copy's current SKILL.md into its own revisions/ before a sync overwrites it — the same safety net
 * as an install, so a destructive overwrite stays reversible. A snapshot that cannot be taken is a warning, not a
 * silent loss; the mirror still runs.
 */
function snapshotProfileSkill(dst: string, rel: string, ctx: SyncContext): void {
	try {
		backupSkillRevision(dst, ctx.now());
	} catch (error) {
		ctx.result.warnings.push(
			`${rel}: could not snapshot the profile SKILL.md before overwrite: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Mirrors one managed skill, snapshotting the profile copy first when it is about to be overwritten. The skill's
 * `revisions/` is profile-owned: mirror never copies the source's revisions in and never deletes the profile's.
 */
function mirrorSkill(src: string, dst: string, rel: string, ctx: SyncContext, snapshot: boolean): void {
	if (snapshot && !ctx.dryRun) snapshotProfileSkill(dst, rel, ctx);
	mirror(src, dst, rel, ctx, (child) => child === SKILL_REVISIONS_DIR);
}

/**
 * `managed-skills/`: a skill only the owner has is copied; one both have is replaced when the owner's SKILL.md differs
 * and is newer (`init`: whenever the trees differ); one only the profile has (the bot made it) stays. An overwrite
 * first snapshots the profile copy, and a differing but older source SKILL.md warns instead of silently diverging.
 */
function syncManagedSkills(source: string, target: string, init: boolean, ctx: SyncContext): void {
	const srcRoot = join(source, "managed-skills");
	const dstRoot = join(target, "managed-skills");
	if (!existsSync(srcRoot)) return;
	if (!existsSync(dstRoot)) {
		ctx.result.changed.push("created managed-skills/");
		if (!ctx.dryRun) mkdirSync(dstRoot, { recursive: true, mode: 0o700 });
	}
	for (const name of readdirSync(srcRoot).sort()) {
		if (SKIPPED_NAME.test(name)) continue;
		const src = join(srcRoot, name);
		const dst = join(dstRoot, name);
		const rel = `managed-skills/${name}`;
		if (lstatOrUndefined(dst) === undefined) {
			mirrorSkill(src, dst, rel, ctx, false);
			continue;
		}
		const srcSkill = join(src, "SKILL.md");
		const dstSkill = join(dst, "SKILL.md");
		const differ = sha256(srcSkill) !== sha256(dstSkill);
		if (init || (differ && mtimeOf(srcSkill) > mtimeOf(dstSkill))) {
			mirrorSkill(src, dst, rel, ctx, differ);
			continue;
		}
		if (differ)
			ctx.result.warnings.push(
				`${rel}: owner's SKILL.md differs but is not newer than the profile copy; profile version kept (omp sync --init to force)`,
			);
	}
}

/**
 * Brings the profile agent dir `target` in line with the owner's agent dir `source` (see `OMP_USAGE`). `dryRun` only
 * lists what would change. Sessions, caches, history, models.db and backups are never touched.
 */
export function syncProfile(input: {
	source: string;
	target: string;
	/** Whose `~/.omp/agent` the absolute config.yml paths name; default two levels above `source`. */
	userHome?: string;
	init?: boolean;
	dryRun?: boolean;
	/** Revision timestamps; default `Date.now`. */
	now?: () => number;
}): SyncResult {
	const { source, target } = input;
	const ctx: SyncContext = {
		dryRun: input.dryRun === true,
		result: { changed: [], warnings: [] },
		now: input.now ?? Date.now,
	};
	if (!existsSync(source)) throw new Error(`source agent dir ${source} does not exist`);
	if (!existsSync(target)) {
		ctx.result.changed.push(`created ${target}`);
		if (ctx.dryRun) return ctx.result;
	}
	if (!ctx.dryRun) {
		mkdirSync(target, { recursive: true, mode: 0o700 });
		chmodSync(target, 0o700);
	}
	for (const name of SYNC_MIRRORED) mirror(join(source, name), join(target, name), name, ctx);

	const srcConfig = join(source, "config.yml");
	const dstConfig = join(target, "config.yml");
	if (!existsSync(srcConfig)) {
		if (lstatOrUndefined(dstConfig) !== undefined) remove(dstConfig, "config.yml", ctx);
	} else {
		const userHome = input.userHome ?? resolve(source, "..", "..");
		const text = rewriteAgentPaths(readFileSync(srcConfig, "utf8"), source, target, userHome);
		const d = lstatOrUndefined(dstConfig);
		if (!(d?.isFile() === true && readFileSync(dstConfig, "utf8") === text)) {
			ctx.result.changed.push("copied config.yml (agent paths rewritten)");
			if (!ctx.dryRun) {
				if (d !== undefined) rmSync(dstConfig, { recursive: true, force: true });
				writeFileSync(dstConfig, text, { mode: 0o600 });
			}
		}
	}

	for (const name of SYNC_LOGIN_LINKS) {
		const link = join(target, name);
		const want = join(source, name);
		const d = lstatOrUndefined(link);
		if (d?.isSymbolicLink() && readLink(link) === want) continue;
		ctx.result.changed.push(`linked ${name} -> ${want}`);
		if (ctx.dryRun) continue;
		if (d !== undefined) rmSync(link, { recursive: true, force: true });
		symlinkSync(want, link);
	}

	syncManagedSkills(source, target, input.init === true, ctx);
	if (input.init === true) initMemory(source, target, ctx);
	return ctx.result;
}

/**
 * `jabbu-pocket omp sync`: the profile of `config.ompProfile` from the owner's agent dir. Prints every change and ends with
 * `omp_profile_sync changed=<n>`; records the time in `<home>/omp/last-sync`. Throws when there is no profile to sync.
 */
export function runProfileSync(input: {
	homeDir: string;
	profile: string | undefined;
	env: Record<string, string | undefined>;
	init?: boolean;
	out: (line: string) => void;
	now: () => number;
}): number {
	if (input.profile === undefined) throw new Error("config ompProfile is not set: there is no bot profile to sync");
	const source = sourceAgentDir(input.env);
	const target = profileAgentDir(userHomeOf(input.env), input.profile);
	const result = syncProfile({
		source,
		target,
		userHome: userHomeOf(input.env),
		...(input.init === true ? { init: true } : {}),
		now: input.now,
	});
	for (const warning of result.warnings) input.out(`warn ${warning}`);
	for (const line of result.changed) input.out(line);
	mkdirSync(dirname(lastSyncPath(input.homeDir)), { recursive: true, mode: 0o700 });
	writeFileSync(
		lastSyncPath(input.homeDir),
		`${new Date(input.now()).toISOString()} changed=${result.changed.length}\n`,
		{
			mode: 0o600,
		},
	);
	input.out(`omp_profile_sync changed=${result.changed.length}`);
	return result.changed.length;
}
