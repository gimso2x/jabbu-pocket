// CI 픽스처 점검: e2e가 조용히 skip되지 않도록 고정된 omp와 gitleaks가 실제로
// 도는지 확인하고 아니면 Error를 던진다. `bun src/dev/check-test-fixtures.ts`가 이 함수를 부른다.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** 점검을 통과한 도구들: omp 실행 파일 경로, 그 `omp/<버전>`, gitleaks 경로. */
export type FixtureReport = { omp: string; version: string; gitleaks: string };
type Env = Record<string, string | undefined>;
const PINNED = "@oh-my-pi/pi-coding-agent";
/** 픽스처 manifest의 omp 고정 버전. 정확한 x.y.z가 아니면 Error. */
const pinnedVersion = (root: string): string => {
	const file = join(root, "test/fixtures/omp-host/package.json");
	const deps: unknown = JSON.parse(readFileSync(file, "utf8"))?.dependencies;
	const pin = deps !== null && typeof deps === "object" && PINNED in deps ? deps[PINNED] : undefined;
	if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin))
		throw new Error(`픽스처가 ${PINNED}를 정확한 버전으로 고정하지 않습니다: ${String(pin)}`);
	return pin;
};
/** 절대 경로 실행 파일이고 `--version`이 고정 버전의 `omp/<버전>`을 내는지. */
const checkOmp = (exe: string | undefined, pinned: string): { omp: string; version: string } => {
	if (exe === undefined || exe === "") throw new Error("OMPBOT_OMP_EXECUTABLE이 없습니다");
	if (!isAbsolute(exe)) throw new Error(`OMPBOT_OMP_EXECUTABLE은 절대 경로여야 합니다: ${exe}`);
	if (!statSync(exe, { throwIfNoEntry: false })?.isFile()) throw new Error(`omp 실행 파일이 없습니다: ${exe}`);
	const ran = spawnSync(exe, ["--version"], { encoding: "utf8" });
	const version = /^omp\/(\d+\.\d+\.\d+\S*)/.exec(`${ran.stdout}${ran.stderr}`)?.[1];
	if (ran.status !== 0 || version === undefined) throw new Error(`omp --version이 omp/<버전>을 내지 않습니다: ${exe}`);
	if (version !== pinned) throw new Error(`omp ${version}는 픽스처 고정 ${pinned}와 다릅니다`);
	return { omp: exe, version };
};
/** `OMPBOT_GITLEAKS`나 PATH의 gitleaks가 실제로 도는지. */
const checkGitleaks = (env: Env): string => {
	const path = env.OMPBOT_GITLEAKS ?? Bun.which("gitleaks", { PATH: env.PATH ?? "" }) ?? undefined;
	if (path === undefined) throw new Error("gitleaks를 찾지 못했습니다(OMPBOT_GITLEAKS 또는 PATH)");
	if (spawnSync(path, ["version"]).status !== 0) throw new Error(`gitleaks가 실행되지 않습니다: ${path}`);
	return path;
};
/** 픽스처가 온전한지: 고정 omp가 그 버전으로 실행되고 gitleaks가 돈다. 어긋나면 Error. */
export async function checkTestFixtures(root: string, env: Env = process.env): Promise<FixtureReport> {
	const { omp, version } = checkOmp(env.OMPBOT_OMP_EXECUTABLE, pinnedVersion(root));
	return { omp, version, gitleaks: checkGitleaks(env) };
}
if (import.meta.main) {
	try {
		const report = await checkTestFixtures(join(import.meta.dir, "..", ".."));
		console.log(`CI_FIXTURES_OK omp=${report.version} gitleaks=${report.gitleaks}`);
	} catch (error) {
		console.error(`CI_FIXTURES_FAIL: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
