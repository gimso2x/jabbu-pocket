// CI 픽스처 점검: e2e가 조용히 skip되지 않도록 omp(와 gitleaks)가 기대한 버전으로 도는지 확인하고 아니면 Error를 던진다.
// `bun src/dev/check-test-fixtures.ts [--omp-only]`가 부른다(`--omp-only`는 기대 버전을 환경변수로 받는다).
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;
const PINNED = "@oh-my-pi/pi-coding-agent";
const exact = (value: unknown, what: string): string => {
	if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${what}: ${String(value)}`);
	return value;
};
/** 절대 경로 실행 파일이고 `--version`이 기대 버전의 `omp/<버전>`을 내는지. */
const checkOmp = (exe: string | undefined, expected: string, label: string): { omp: string; version: string } => {
	if (exe === undefined || !isAbsolute(exe)) throw new Error(`JABBU_OMP_EXECUTABLE은 절대 경로여야 합니다: ${exe}`);
	if (!statSync(exe, { throwIfNoEntry: false })?.isFile()) throw new Error(`omp 실행 파일이 없습니다: ${exe}`);
	const ran = spawnSync(exe, ["--version"], { encoding: "utf8" });
	const version = /^omp\/(\d+\.\d+\.\d+\S*)/.exec(`${ran.stdout}${ran.stderr}`)?.[1];
	if (ran.status !== 0 || version === undefined) throw new Error(`omp --version이 omp/<버전>을 내지 않습니다: ${exe}`);
	if (version !== expected) throw new Error(`omp ${version}는 ${label} ${expected}와 다릅니다`);
	return { omp: exe, version };
};
/** `JABBU_GITLEAKS`나 PATH의 gitleaks가 실제로 도는지. */
const checkGitleaks = (env: Env): string => {
	const path = env.JABBU_GITLEAKS ?? Bun.which("gitleaks", { PATH: env.PATH ?? "" }) ?? undefined;
	if (path === undefined) throw new Error("gitleaks를 찾지 못했습니다(JABBU_GITLEAKS 또는 PATH)");
	if (spawnSync(path, ["version"]).status !== 0) throw new Error(`gitleaks가 실행되지 않습니다: ${path}`);
	return path;
};
/** 픽스처가 온전한지: 고정 omp가 그 버전으로 실행되고 gitleaks가 돈다. 어긋나면 Error. */
export async function checkTestFixtures(root: string, env: Env = process.env) {
	const manifest = JSON.parse(readFileSync(join(root, "test/fixtures/omp-host/package.json"), "utf8"));
	const pin = exact(manifest?.dependencies?.[PINNED], `픽스처가 ${PINNED}를 정확한 버전으로 고정하지 않습니다`);
	return { ...checkOmp(env.JABBU_OMP_EXECUTABLE, pin, "픽스처 고정"), gitleaks: checkGitleaks(env) };
}
/** 최신 omp 검사용: gitleaks 없이 omp만, 기대 버전은 `JABBU_OMP_EXPECT_VERSION`에서만 받는다(고정 버전으로 폴백하지 않는다). */
export function checkOmpOnly(env: Env = process.env) {
	const expected = exact(env.JABBU_OMP_EXPECT_VERSION, "JABBU_OMP_EXPECT_VERSION은 정확한 x.y.z여야 합니다");
	return checkOmp(env.JABBU_OMP_EXECUTABLE, expected, "기대 버전");
}
if (import.meta.main) {
	try {
		const report = process.argv.includes("--omp-only")
			? checkOmpOnly()
			: await checkTestFixtures(join(import.meta.dir, "..", ".."));
		console.log(`CI_FIXTURES_OK omp=${report.version}${"gitleaks" in report ? ` gitleaks=${report.gitleaks}` : ""}`);
	} catch (error) {
		console.error(`CI_FIXTURES_FAIL: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
