/**
 * 설치된 스킬 디렉터리(`managed-skills` 등)의 SHA-256 락파일 생성·검증 및 위험 패턴 스캔.
 * `revisions/`, `_archived/`, `.git/`는 이력·보관 디렉터리로 취급해 제외하고, 심볼릭 링크는 따라가지 않고 거부한다.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { HANDOFF_SCAN_BYTES, scanHandoffBrief } from "../safety/handoff-risk";
import { assertSafeSkillPath, writeAtomicNoFollow } from "./skill-io";
import { SKILL_REVISIONS_DIR } from "./skills";

export interface SkillLockFileEntry {
	sha256: string;
	bytes: number;
}

export interface SkillLockFile {
	version: 1;
	root: string;
	generatedAt: string;
	files: Record<string, SkillLockFileEntry>;
}

export interface SkillRiskWarning {
	path: string;
	rule: string;
	line: number;
	excerpt: string;
}

export interface SkillVerifyResult {
	ok: boolean;
	lockFile: string;
	root: string;
	totalLocked: number;
	totalCurrent: number;
	added: string[];
	modified: string[];
	removed: string[];
	symlinks: string[];
	warnings: SkillRiskWarning[];
}

const SKIP_DIRS = new Set([SKILL_REVISIONS_DIR, "_archived", ".git"]);
const TEXT_EXTS = new Set([
	".md",
	".txt",
	".sh",
	".bash",
	".zsh",
	".ts",
	".js",
	".mjs",
	".cjs",
	".py",
	".json",
	".yaml",
	".yml",
	".toml",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface SkillTreeScan {
	files: Record<string, SkillLockFileEntry>;
	symlinks: string[];
	warnings: SkillRiskWarning[];
}

/** Scans the skill tree for the lockfile's file map. `excludeFile` (the lockfile itself, when it lives inside the tree) is skipped by resolved path so lock/verify round-trips regardless of placement. */
function scanSkillTree(rootDir: string, action: string, excludeFile?: string): SkillTreeScan {
	const resolvedRoot = resolve(rootDir);
	if (!assertSafeSkillPath(resolvedRoot, action, { requireDir: true })) {
		throw new Error(`${action} failed: skills directory not found: ${resolvedRoot}`);
	}
	const files: Record<string, SkillLockFileEntry> = {};
	const symlinks: string[] = [];
	const warnings: SkillRiskWarning[] = [];

	const walk = (dir: string): void => {
		const entries = readdirSync(dir).sort();
		for (const name of entries) {
			const full = join(dir, name);
			if (excludeFile !== undefined && full === excludeFile) continue;
			const rel = relative(resolvedRoot, full).replaceAll("\\", "/");
			const st = lstatSync(full);
			if (st.isSymbolicLink()) {
				symlinks.push(rel);
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRS.has(name)) continue;
				walk(full);
				continue;
			}
			if (!st.isFile()) continue;
			const buf = readFileSync(full);
			files[rel] = {
				sha256: createHash("sha256").update(buf).digest("hex"),
				bytes: buf.byteLength,
			};
			if (TEXT_EXTS.has(extname(name).toLowerCase()) && buf.byteLength <= HANDOFF_SCAN_BYTES) {
				const scan = scanHandoffBrief(buf.toString("utf8"));
				for (const finding of scan.findings) {
					if (finding.severity === "high_risk") {
						warnings.push({ path: rel, rule: finding.rule, line: finding.line, excerpt: finding.excerpt });
					}
				}
			}
		}
	};

	walk(resolvedRoot);
	return { files, symlinks, warnings };
}

/** 현재 스킬 트리의 파일 해시를 `lockPath`에 원자적(`0600`)으로 기록한다. 심볼릭 링크가 있으면 거부한다. */
export function writeSkillLock(rootDir: string, lockPath: string, now: () => number = Date.now): SkillLockFile {
	const resolvedRoot = resolve(rootDir);
	const resolvedLock = resolve(lockPath);
	const scan = scanSkillTree(resolvedRoot, "skills lock", resolvedLock);
	if (scan.symlinks.length > 0) {
		throw new Error(`skills lock refused: symbolic link(s) found: ${scan.symlinks.join(", ")}`);
	}
	assertSafeSkillPath(resolvedLock, "skills lock", { requireFile: true });
	mkdirSync(dirname(resolvedLock), { recursive: true, mode: 0o700 });
	const lock: SkillLockFile = {
		version: 1,
		root: resolvedRoot,
		generatedAt: new Date(now()).toISOString(),
		files: scan.files,
	};
	writeAtomicNoFollow(resolvedLock, `${JSON.stringify(lock, null, "\t")}\n`, 0o600);
	return lock;
}

/** `lockPath`의 스킬 락파일을 읽어 스키마·해시 형식을 검증한다. */
export function readSkillLock(lockPath: string): SkillLockFile {
	const resolvedLock = resolve(lockPath);
	if (!assertSafeSkillPath(resolvedLock, "skills verify", { requireFile: true })) {
		throw new Error(`skills verify failed: lockfile not found: ${resolvedLock}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolvedLock, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`skills verify failed: invalid JSON in lockfile ${resolvedLock}: ${String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`skills verify failed: invalid lockfile object: ${resolvedLock}`);
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== 1 || typeof obj.root !== "string" || typeof obj.generatedAt !== "string") {
		throw new Error(`skills verify failed: unsupported lockfile header: ${resolvedLock}`);
	}
	if (typeof obj.files !== "object" || obj.files === null || Array.isArray(obj.files)) {
		throw new Error(`skills verify failed: invalid lockfile files map: ${resolvedLock}`);
	}
	const files: Record<string, SkillLockFileEntry> = {};
	for (const rel of Object.keys(obj.files as Record<string, unknown>).sort()) {
		if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
			throw new Error(`skills verify failed: invalid lockfile path: ${rel}`);
		}
		const rawEntry = (obj.files as Record<string, unknown>)[rel];
		if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
			throw new Error(`skills verify failed: invalid entry for ${rel}`);
		}
		const entry = rawEntry as Record<string, unknown>;
		if (
			typeof entry.sha256 !== "string" ||
			!SHA256_HEX.test(entry.sha256) ||
			typeof entry.bytes !== "number" ||
			!Number.isSafeInteger(entry.bytes) ||
			entry.bytes < 0
		) {
			throw new Error(`skills verify failed: invalid digest for ${rel}`);
		}
		files[rel] = { sha256: entry.sha256, bytes: entry.bytes };
	}
	return { version: 1, root: obj.root, generatedAt: obj.generatedAt, files };
}

/** `rootDir`의 현재 스킬 트리를 `lockPath`와 대조해 추가·변경·삭제·심볼릭 링크·고위험 지시 경고를 보고한다. */
export function verifySkillLock(rootDir: string, lockPath: string): SkillVerifyResult {
	const resolvedRoot = resolve(rootDir);
	const resolvedLock = resolve(lockPath);
	const lock = readSkillLock(resolvedLock);
	const scan = scanSkillTree(resolvedRoot, "skills verify", resolvedLock);
	const lockedKeys = Object.keys(lock.files).sort();
	const currentKeys = Object.keys(scan.files).sort();
	const added: string[] = [];
	const modified: string[] = [];
	const removed: string[] = [];

	for (const rel of currentKeys) {
		const expected = lock.files[rel];
		const actual = scan.files[rel];
		if (expected === undefined) {
			added.push(rel);
		} else if (actual !== undefined && (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)) {
			modified.push(rel);
		}
	}
	for (const rel of lockedKeys) {
		if (scan.files[rel] === undefined) removed.push(rel);
	}

	return {
		ok: added.length === 0 && modified.length === 0 && removed.length === 0 && scan.symlinks.length === 0,
		lockFile: resolvedLock,
		root: resolvedRoot,
		totalLocked: lockedKeys.length,
		totalCurrent: currentKeys.length,
		added,
		modified,
		removed,
		symlinks: scan.symlinks,
		warnings: scan.warnings,
	};
}
