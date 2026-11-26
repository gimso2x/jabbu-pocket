// 줄 수 래칫: src 트리 `.ts` 줄 수가 기준선·새 파일 한도를 넘으면 실패한다.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 기준선에 없는 새 파일이 넘을 수 없는 줄 수. */
export const NEW_FILE_MAX = 400;
/** 상대경로(posix 구분자) → 줄 수. */
export type LocCounts = Record<string, number>;

const BASELINE = "src/dev/loc-baseline.json";

/** 텍스트의 줄 수. 끝 개행은 빈 줄을 더하지 않는다(`"a\n"`은 1줄). */
export function countLines(text: string): number {
	return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** `root` 아래 src 트리의 `.ts` 파일 줄 수. 키는 `root` 기준 상대경로이고 이름순이다. */
export function scanLoc(root: string): LocCounts {
	const files = [...new Bun.Glob("src/**/*.ts").scanSync(root)].map((f) => f.replaceAll("\\", "/")).sort();
	return Object.fromEntries(files.map((file) => [file, countLines(readFileSync(join(root, file), "utf8"))]));
}

/** 한도를 넘은 파일마다 `"<파일>: <줄>줄 > <한도>줄 (기준선|새 파일 한도)"` 한 줄. */
export function locViolations(counts: LocCounts, baseline: LocCounts): string[] {
	return Object.keys(counts)
		.sort()
		.flatMap((file) => {
			const lines = counts[file] ?? 0;
			const limit = baseline[file] ?? NEW_FILE_MAX;
			if (lines <= limit) return [];
			return [`${file}: ${lines}줄 > ${limit}줄 (${baseline[file] === undefined ? "새 파일 한도" : "기준선"})`];
		});
}

/** 기준선을 내리기만 한다: 줄어든 파일은 새 줄 수로, 지운 파일은 빠지고, 새 파일은 들어가지 않는다. */
export function lowerBaseline(counts: LocCounts, baseline: LocCounts): LocCounts {
	const next: LocCounts = {};
	for (const [file, lines] of Object.entries(baseline)) {
		const now = counts[file];
		if (now !== undefined) next[file] = Math.min(lines, now);
	}
	return next;
}

if (import.meta.main) {
	const repo = join(import.meta.dir, "..", "..");
	const baseline = JSON.parse(readFileSync(join(repo, ...BASELINE.split("/")), "utf8")) as LocCounts;
	const counts = scanLoc(repo);
	if (process.argv.includes("--update")) {
		const next = lowerBaseline(counts, baseline);
		writeFileSync(join(repo, ...BASELINE.split("/")), `${JSON.stringify(next, null, "\t")}\n`);
		console.log(`[check-loc] 기준선 하향 ${Object.keys(next).filter((f) => next[f] !== baseline[f]).length}건`);
	} else {
		const shrank = Object.keys(baseline).filter((f) => counts[f] !== undefined && baseline[f] !== counts[f]);
		if (shrank.length > 0)
			console.log(`[check-loc] 줄어든 파일 ${shrank.length}개 — bun src/dev/check-loc.ts --update로 기준선을 내리세요`);
	}
	const over = locViolations(counts, baseline);
	for (const line of over) console.error(line);
	const hint = `[check-loc] ${over.length}건 초과. 파일을 줄이거나 나누세요(기준선은 ${BASELINE}, 올리지 않습니다).`;
	if (over.length > 0) console.error(hint);
	process.exitCode = over.length > 0 ? 1 : 0;
}
