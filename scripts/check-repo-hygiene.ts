// 저장소 위생 게이트: 추적 파일 중 대용량 블롭(기본 512 KB 초과)과 병합 충돌 마커를 차단한다.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 허용 목록 밖에서 차단할 단일 파일 최대 바이트 수. */
export const MAX_BLOB_BYTES = 512_000;

export interface RepoHygieneOptions {
	maxBytes?: number;
	allowLarge?: ReadonlySet<string>;
}

const CONFLICT_MARKER_PATTERNS = [/^<{7}(?: |$)/, /^={7}$/, /^>{7}(?: |$)/] as const;

/** 지정된 파일 목록에서 대용량 파일과 미해결 병합 충돌 마커 위반을 수집한다. */
export function checkRepoHygiene(root: string, files: readonly string[], options?: RepoHygieneOptions): string[] {
	const maxBytes = options?.maxBytes ?? MAX_BLOB_BYTES;
	const allowLarge = options?.allowLarge;
	const hits: string[] = [];

	for (const file of files) {
		const fullPath = join(root, file);
		const stat = lstatSync(fullPath);
		if (!stat.isFile()) continue;

		if (stat.size > maxBytes && !allowLarge?.has(file)) {
			hits.push(`blob-size: ${file} (${stat.size}B > ${maxBytes}B)`);
		}

		const bytes = readFileSync(fullPath);
		if (bytes.includes(0)) continue;

		const lines = bytes.toString("utf8").split(/\r?\n/);
		lines.forEach((line, index) => {
			if (CONFLICT_MARKER_PATTERNS.some((pattern) => pattern.test(line))) {
				hits.push(`conflict-marker: ${file}:${index + 1}`);
			}
		});
	}

	return hits;
}

if (import.meta.main) {
	const repoRoot = join(import.meta.dir, "..");
	const proc = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "-z"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		const errText = Buffer.from(proc.stderr).toString("utf8").trim();
		console.error(`check-repo-hygiene: git ls-files failed (exit ${proc.exitCode}): ${errText}`);
		process.exitCode = 1;
	} else {
		const files = Buffer.from(proc.stdout)
			.toString("utf8")
			.split("\0")
			.filter((file) => file !== "");
		const violations = checkRepoHygiene(repoRoot, files);
		for (const violation of violations) {
			console.error(violation);
		}
		if (violations.length > 0) {
			console.error(`check-repo-hygiene: ${violations.length} violation(s) found`);
			process.exitCode = 1;
		}
	}
}
