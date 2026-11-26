// Bun 설치 스크립트: WSL2 CI는 태그 설치나 파이프 다운로드 대신 고정 버전을
// 받아 체크섬을 확인한 바이트만 설치한다. 외부 호출(curl·timeout·sleep·sha256sum·unzip)은 PATH 앞 shim으로 대신한다.

import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "ci-install-bun.sh");
const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory that is removed after the run. */
const tempDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
};

/** Write an executable shim; every call appends its argv (and optional stdin) to the shared log. */
const shim = (dir: string, name: string, body: string): void => {
	const file = join(dir, name);
	writeFileSync(file, `#!/usr/bin/env bash\nset -u\nstate=$SHIM_STATE\necho "${name} $*" >> "$state/log"\n${body}`);
	chmodSync(file, 0o755);
};

/** The fake tools the installer shells out to, plus a controller for how the download behaves. */
const shims = (): string => {
	const dir = tempDir("bun-shims-");
	const state = join(dir, "state");
	mkdirSync(state);
	writeFileSync(join(state, "count"), "0");
	shim(
		dir,
		"timeout",
		`while [ $# -gt 0 ]; do case "$1" in --kill-after=*|--kill-after|[0-9]*s) shift ;; *) break ;; esac; done\nexec "$@"\n`,
	);
	shim(
		dir,
		"curl",
		`n=$(( $(cat "$SHIM_STATE/count") + 1 )); echo "$n" > "$SHIM_STATE/count"
[ "$n" -le "\${FAIL_TIMES:-0}" ] && exit "\${FAIL_EXIT:-1}"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done
printf 'zip-bytes' > "$out"\nexit 0\n`,
	);
	shim(dir, "sleep", "exit 0\n");
	shim(dir, "uname", `echo "$SHIM_ARCH"\n`);
	shim(dir, "sha256sum", `cat >> "$SHIM_STATE/stdin"\n[ "\${SHA_OK:-1}" = "1" ]\n`);
	// `unzip -qo <zip> <asset>/bun -d <dir>`: materialize `<asset>/bun` so the installer can chmod and move it.
	shim(
		dir,
		"unzip",
		`member=""; dir=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then dir=$a;
  elif [ "\${a#*/}" = "bun" ]; then member=$a; fi
  prev=$a
done
mkdir -p "$dir/$(dirname "$member")"
printf '#!/bin/sh\\nexit 0\\n' > "$dir/$member"\n`,
	);
	return dir;
};

/** Run the installer with the shims first on PATH. */
const install = (binDir: string, env: Record<string, string>, arch = "x86_64") => {
	const shimsDir = shims();
	const p = Bun.spawnSync(["bash", SCRIPT, binDir], {
		env: {
			PATH: `${shimsDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			SHIM_STATE: join(shimsDir, "state"),
			SHIM_ARCH: arch,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const state = join(shimsDir, "state");
	const log = existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf8") : "";
	const stdin = existsSync(join(state, "stdin")) ? readFileSync(join(state, "stdin"), "utf8") : "";
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
		log,
		stdin,
	};
};

const leftovers = (binDir: string): string[] => readdirSync(binDir).filter((name) => name.startsWith(".bun-download"));

describe("ci-install-bun", () => {
	test.each([0, 2])("installs only verified bytes after %s transient failures", (failTimes) => {
		const binDir = tempDir("bun-bin-");
		const result = install(binDir, { FAIL_TIMES: String(failTimes), FAIL_EXIT: "1" });
		expect(result.code).toBe(0);
		expect(readFileSync(join(binDir, "bun"), "utf8")).toContain("exit 0");
		expect(result.log).toContain("sha256sum -c -");
		expect(result.stdin).toContain("bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c");
		expect(result.stdin).toContain("bun.zip");
		const sleeps = result.log.split("\n").filter((line) => line.startsWith("sleep "));
		expect(sleeps).toEqual(failTimes === 0 ? [] : ["sleep 20", "sleep 40"].slice(0, failTimes));
		expect(leftovers(binDir)).toEqual([]);
	});

	test.each([1, 124])("bounds retries and cleans partial bytes on download exit %s", (failExit) => {
		const binDir = tempDir("bun-bin-");
		writeFileSync(join(binDir, "bun"), "previous");
		const result = install(binDir, { FAIL_TIMES: "9", FAIL_EXIT: String(failExit) });
		expect(result.code).toBe(22);
		expect(result.log.split("\n").filter((line) => line.startsWith("curl ")).length).toBe(3);
		expect(result.log.split("\n").filter((line) => line.startsWith("sleep "))).toEqual(["sleep 20", "sleep 40"]);
		expect(readFileSync(join(binDir, "bun"), "utf8")).toBe("previous");
		expect(leftovers(binDir)).toEqual([]);
	});

	test.each(["aarch64", "arm64"])("arm64 (%s) downloads the aarch64 asset and verifies its own checksum", (arch) => {
		const binDir = tempDir("bun-bin-");
		const result = install(binDir, {}, arch);
		expect(result.code).toBe(0);
		expect(result.log).toContain("bun-v1.4.4/bun-linux-aarch64.zip");
		expect(result.log).not.toContain("bun-linux-x64");
		expect(result.stdin).toContain("baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e");
		expect(readFileSync(join(binDir, "bun"), "utf8")).toContain("exit 0");
	});

	test("x86_64 downloads the x64 asset", () => {
		const result = install(tempDir("bun-bin-"), {}, "x86_64");
		expect(result.log).toContain("bun-v1.4.4/bun-linux-x64.zip");
		expect(result.log).not.toContain("bun-linux-aarch64");
	});

	test.each(["armv7l", "riscv64", "i686"])("unsupported architecture %s fails before any download", (arch) => {
		const binDir = tempDir("bun-bin-");
		const result = install(binDir, {}, arch);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain(arch);
		expect(result.log).not.toContain("curl ");
		expect(existsSync(join(binDir, "bun"))).toBe(false);
	});

	test("checksum rejection preserves the existing binary and cleans the download", () => {
		const binDir = tempDir("bun-bin-");
		writeFileSync(join(binDir, "bun"), "previous");
		const result = install(binDir, { SHA_OK: "0" });
		expect(result.code).not.toBe(0);
		expect(result.log).not.toContain("unzip ");
		expect(readFileSync(join(binDir, "bun"), "utf8")).toBe("previous");
		expect(leftovers(binDir)).toEqual([]);
	});

	test("a missing BIN_DIR argument prints usage instead of installing somewhere", () => {
		const p = Bun.spawnSync(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe" });
		expect(p.exitCode).toBe(2);
		expect(new TextDecoder().decode(p.stderr).trim()).toBe("usage: ci-install-bun.sh BIN_DIR");
	});
});
