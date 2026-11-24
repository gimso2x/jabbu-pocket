// CI 픽스처 점검: 고정된 omp와 gitleaks가 실제로 도는지 확인하지 못하면
// 실패한다. e2e가 도구 없이 조용히 skip되면 CI가 초록인 채로 RPC 규약이 깨진 omp를 놓치기 때문이다.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkOmpOnly, checkTestFixtures } from "../src/dev/check-test-fixtures";

const REPO = resolve(import.meta.dir, "..");
const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
};

/** A repo-shaped root whose only content is the omp-host fixture manifest, pinned to `pin`. */
const fixtureRoot = (pin = "19.0.1"): string => {
	const root = tempDir("fixtures-root-");
	mkdirSync(join(root, "test", "fixtures", "omp-host"), { recursive: true });
	writeFileSync(
		join(root, "test", "fixtures", "omp-host", "package.json"),
		JSON.stringify({ private: true, dependencies: { "@oh-my-pi/pi-coding-agent": pin } }),
	);
	return root;
};

/** An executable script that prints `stdout` and exits `code`. */
const script = (dir: string, name: string, stdout: string, code = 0): string => {
	const file = join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${stdout === "" ? "" : `echo "${stdout}"\n`}exit ${code}\n`);
	chmodSync(file, 0o755);
	return file;
};

/** An executable that only exists to fill PATH, so `Bun.which` finds nothing else. */
const binDir = (gitleaks: "ok" | "broken" | "absent"): string => {
	const dir = tempDir("fixtures-bin-");
	if (gitleaks === "ok") script(dir, "gitleaks", "8.28.0");
	else if (gitleaks === "broken") script(dir, "gitleaks", "boom", 2);
	return dir;
};

const envOf = (overrides: Record<string, string | undefined>): Record<string, string | undefined> => ({
	PATH: binDir("ok"),
	JABBU_OMP_EXECUTABLE: undefined,
	JABBU_GITLEAKS: undefined,
	...overrides,
});

describe("checkTestFixtures", () => {
	test("the pinned omp and a working gitleaks pass the check without touching the real tools", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		const gitleaks = script(binDir("absent"), "gitleaks", "8.28.0");
		await expect(
			checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: omp, JABBU_GITLEAKS: gitleaks })),
		).resolves.toEqual({ omp, version: "19.0.1", gitleaks });
	});

	test("the fixture pins omp to an exact version, so the check has one answer", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		const env = envOf({ JABBU_OMP_EXECUTABLE: omp });
		await expect(checkTestFixtures(fixtureRoot("^19.0.1"), env)).rejects.toThrow("정확한 버전");
		await expect(checkTestFixtures(fixtureRoot("19.x"), env)).rejects.toThrow("정확한 버전");
	});

	test("gitleaks on PATH counts when JABBU_GITLEAKS is unset", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		const path = binDir("ok");
		const report = await checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: omp, PATH: path }));
		expect(report.gitleaks).toBe(join(path, "gitleaks"));
	});

	test.each(["unset", "relative", "missing", "directory"])("an omp executable that is %s fails", async (kind) => {
		const dir = tempDir("fixtures-omp-");
		const executable =
			kind === "unset" ? undefined : kind === "relative" ? "omp" : kind === "missing" ? join(dir, "nope") : dir;
		await expect(checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: executable }))).rejects.toThrow();
	});

	test("an omp of another version fails", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/18.0.0");
		await expect(checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: omp }))).rejects.toThrow(
			"픽스처 고정 19.0.1",
		);
	});

	test("an omp whose --version fails is refused", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "", 1);
		await expect(checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: omp }))).rejects.toThrow("omp/<버전>");
	});

	test("a missing gitleaks fails instead of letting the release export tests skip", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		await expect(
			checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: omp, PATH: binDir("absent") })),
		).rejects.toThrow("gitleaks를 찾지 못했습니다");
	});

	test("a gitleaks that does not run fails", async () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		await expect(
			checkTestFixtures(fixtureRoot(), envOf({ JABBU_OMP_EXECUTABLE: omp, PATH: binDir("broken") })),
		).rejects.toThrow("gitleaks가 실행되지 않습니다");
	});
});

describe("check-test-fixtures CLI", () => {
	const cli = (env: Record<string, string | undefined>) => {
		const p = Bun.spawnSync([process.execPath, join(REPO, "src", "dev", "check-test-fixtures.ts")], {
			cwd: REPO,
			env: { PATH: binDir("ok"), ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
	};

	test.each(["omp", "gitleaks"])("the real CLI exits nonzero without an OK marker when %s is missing", (missing) => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		const env = missing === "omp" ? { PATH: binDir("ok") } : { PATH: binDir("absent"), JABBU_OMP_EXECUTABLE: omp };
		const result = cli(env);
		expect(result.code).toBe(1);
		expect(result.out).not.toContain("CI_FIXTURES_OK");
		expect(result.err).toContain("CI_FIXTURES_FAIL:");
	});

	test("the real CLI prints the OK marker and exits 0 when both tools are present", () => {
		// The real CLI reads the repo's own pin, which dependabot bumps: the stub reports whatever is pinned.
		const manifest = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "omp-host", "package.json"), "utf8"));
		const pin: string = manifest.dependencies["@oh-my-pi/pi-coding-agent"];
		const omp = script(tempDir("fixtures-omp-"), "omp", `omp/${pin}`);
		const result = cli({ JABBU_OMP_EXECUTABLE: omp });
		expect(result.code).toBe(0);
		expect(result.out).toContain(`CI_FIXTURES_OK omp=${pin} gitleaks=`);
		expect(result.err).toBe("");
	});
});

describe("checkOmpOnly (latest-omp job: no gitleaks, version from JABBU_OMP_EXPECT_VERSION)", () => {
	test("an omp equal to the expected version passes, even when it differs from the fixture pin and no gitleaks exists", () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.1.1");
		const env = envOf({ JABBU_OMP_EXECUTABLE: omp, JABBU_OMP_EXPECT_VERSION: "19.1.1", PATH: binDir("absent") });
		expect(checkOmpOnly(env)).toEqual({ omp, version: "19.1.1" });
	});

	test("an omp of another version fails", () => {
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
		const env = envOf({ JABBU_OMP_EXECUTABLE: omp, JABBU_OMP_EXPECT_VERSION: "19.1.1" });
		expect(() => checkOmpOnly(env)).toThrow("19.1.1");
	});

	test.each([undefined, "", "latest", "^19.1.1", "19.1"])(
		"expected version %p fails without falling back to the pin",
		(expected) => {
			const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.0.1");
			const env = envOf({ JABBU_OMP_EXECUTABLE: omp, JABBU_OMP_EXPECT_VERSION: expected });
			expect(() => checkOmpOnly(env)).toThrow("JABBU_OMP_EXPECT_VERSION");
		},
	);

	test("a missing omp executable fails", () => {
		expect(() => checkOmpOnly(envOf({ JABBU_OMP_EXPECT_VERSION: "19.1.1" }))).toThrow("JABBU_OMP_EXECUTABLE");
	});

	test("the CLI --omp-only exits 0 with an OK marker on a match and 1 on a mismatch or empty input", () => {
		const run = (env: Record<string, string | undefined>) => {
			const p = Bun.spawnSync([process.execPath, join(REPO, "src", "dev", "check-test-fixtures.ts"), "--omp-only"], {
				cwd: REPO,
				env: { PATH: binDir("absent"), ...env },
				stdout: "pipe",
				stderr: "pipe",
			});
			return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
		};
		const omp = script(tempDir("fixtures-omp-"), "omp", "omp/19.1.1");
		const ok = run({ JABBU_OMP_EXECUTABLE: omp, JABBU_OMP_EXPECT_VERSION: "19.1.1" });
		expect(ok.code).toBe(0);
		expect(ok.out).toContain("CI_FIXTURES_OK omp=19.1.1");
		for (const expected of ["19.0.0", ""]) {
			const bad = run({ JABBU_OMP_EXECUTABLE: omp, JABBU_OMP_EXPECT_VERSION: expected });
			expect(bad.code).toBe(1);
			expect(bad.out).not.toContain("CI_FIXTURES_OK");
			expect(bad.err).toContain("CI_FIXTURES_FAIL:");
		}
	});
});
