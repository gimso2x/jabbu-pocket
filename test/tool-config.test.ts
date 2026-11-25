// 도구 설정 위생: 이 저장소에는 `release/` 디렉터리가 없다(내보내기 도구는 개발 기록 저장소에만 있다).
// 설정 파일이 없는 경로를 가리키면 knip이 "no matches" 힌트를 내고, 그 경로에 기대는 테스트는 영원히 skip된다.
// 그래서 세 설정의 경로 목록과 test/ 아래 내보내기 테스트가 `release/` 잔재를 다시 들여오지 않는지 본다.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const STALE = "release/";

/** Every path pattern a config file names, so one rule can reject the stale ones wherever they hide. */
function pathPatternsOf(configs: { knip: unknown; biome: unknown; tsconfig: unknown }): string[] {
	const knip = configs.knip as { entry?: unknown; project?: unknown };
	const biome = configs.biome as { files?: { includes?: unknown } };
	const tsconfig = configs.tsconfig as { include?: unknown };
	const flatten = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	return [
		...flatten(knip.entry),
		...flatten(knip.project),
		...flatten(biome.files?.includes),
		...flatten(tsconfig.include),
	];
}

const repoJson = (file: string): unknown => JSON.parse(readFileSync(join(REPO, file), "utf8"));

describe("tool config hygiene", () => {
	test("rejects stale release/ paths in knip, biome and tsconfig", () => {
		const patterns = pathPatternsOf({
			knip: repoJson("knip.json"),
			biome: repoJson("biome.json"),
			tsconfig: repoJson("tsconfig.json"),
		});
		// The read really did reach each file's path list, so an empty result means "clean", not "nothing read".
		expect(patterns.length).toBeGreaterThan(8);
		expect(patterns.filter((pattern) => pattern.includes(STALE))).toEqual([]);
	});

	test("rejects release-export tests left behind for a directory that does not exist", () => {
		const leftovers = readdirSync(join(REPO, "test")).filter((name) => /^release-export.*\.test\.ts$/.test(name));
		expect(leftovers).toEqual([]);
	});

	test("the stale-path rule flags a planted release/ entry, so the check above can fail", () => {
		const planted = pathPatternsOf({
			knip: { entry: ["release/export.ts"], project: ["src/**/*.ts"] },
			biome: { files: { includes: ["src/**"] } },
			tsconfig: { include: ["src/**/*.ts", "release/**/*.ts"] },
		});
		expect(planted.filter((pattern) => pattern.includes(STALE))).toEqual(["release/export.ts", "release/**/*.ts"]);
	});
});
