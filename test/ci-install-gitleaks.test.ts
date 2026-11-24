// gitleaks 설치 스크립트: CI는 태그 설치나 파이프 다운로드 대신 고정 버전을
// 받아 체크섬을 확인한 바이트만 설치한다. 외부 호출(curl·timeout·sleep·sha256sum·tar)은 PATH 앞 shim으로 대신한다.

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

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "ci-install-gitleaks.sh");
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
	const dir = tempDir("gitleaks-shims-");
	const state = join(dir, "state");
	mkdirSync(state);
	writeFileSync(join(state, "count"), "0");
	// `timeout --kill-after=5s 60s curl ...`: drop the timeout options, then run the wrapped command.
	shim(
		dir,
		"timeout",
		`while [ $# -gt 0 ]; do case "$1" in --kill-after=*|--kill-after|[0-9]*s) shift ;; *) break ;; esac; done\nexec "$@"\n`,
	);
	// Fail the first $FAIL_TIMES downloads with $FAIL_EXIT, then write bytes to the -o target.
	shim(
		dir,
		"curl",
		`n=$(( $(cat "$SHIM_STATE/count") + 1 )); echo "$n" > "$SHIM_STATE/count"
[ "$n" -le "\${FAIL_TIMES:-0}" ] && exit "\${FAIL_EXIT:-1}"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done
printf 'tarball-bytes' > "$out"\nexit 0\n`,
	);
	shim(dir, "sleep", "exit 0\n");
	// `uname -m` reports the architecture the test asks for.
	shim(dir, "uname", `echo "$SHIM_ARCH"\n`);
	// `sha256sum -c -` reads "<sha>  <file>" from stdin; SHA_OK=0 rejects it like a mismatch.
	shim(dir, "sha256sum", `cat >> "$SHIM_STATE/stdin"\n[ "\${SHA_OK:-1}" = "1" ]\n`);
	// `tar -xzf <file> -C <dir> gitleaks`: materialize the member so the installer has something to move.
	shim(
		dir,
		"tar",
		`dir=""; prev=""
for a in "$@"; do [ "$prev" = "-C" ] && dir=$a; prev=$a; done
printf '#!/bin/sh\\nexit 0\\n' > "$dir/gitleaks"; chmod +x "$dir/gitleaks"\n`,
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

const leftovers = (binDir: string): string[] =>
	readdirSync(binDir).filter((name) => name.startsWith(".gitleaks-download"));

describe("ci-install-gitleaks", () => {
	test.each([0, 2])("installs only verified bytes after %s transient failures", (failTimes) => {
		const binDir = tempDir("gitleaks-bin-");
		const result = install(binDir, { FAIL_TIMES: String(failTimes), FAIL_EXIT: "1" });
		expect(result.code).toBe(0);
		expect(readFileSync(join(binDir, "gitleaks"), "utf8")).toContain("exit 0");
		// Every byte that got installed came from a tarball the checksum step saw.
		expect(result.log).toContain("sha256sum -c -");
		expect(result.stdin).toContain("a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb");
		expect(result.stdin).toContain("gitleaks.tar.gz");
		// Retries back off 20 then 40 seconds.
		const sleeps = result.log.split("\n").filter((line) => line.startsWith("sleep "));
		expect(sleeps).toEqual(failTimes === 0 ? [] : ["sleep 20", "sleep 40"].slice(0, failTimes));
		expect(leftovers(binDir)).toEqual([]);
	});

	test.each([1, 124])("bounds retries and cleans partial bytes on download exit %s", (failExit) => {
		const binDir = tempDir("gitleaks-bin-");
		writeFileSync(join(binDir, "gitleaks"), "previous");
		const result = install(binDir, { FAIL_TIMES: "9", FAIL_EXIT: String(failExit) });
		expect(result.code).toBe(22);
		// Three attempts, two waits, then give up without touching the installed binary.
		expect(result.log.split("\n").filter((line) => line.startsWith("curl ")).length).toBe(3);
		expect(result.log.split("\n").filter((line) => line.startsWith("sleep "))).toEqual(["sleep 20", "sleep 40"]);
		expect(readFileSync(join(binDir, "gitleaks"), "utf8")).toBe("previous");
		expect(leftovers(binDir)).toEqual([]);
	});

	test.each(["aarch64", "arm64"])("arm64 (%s) downloads the arm64 asset and verifies its own checksum", (arch) => {
		const binDir = tempDir("gitleaks-bin-");
		const result = install(binDir, {}, arch);
		expect(result.code).toBe(0);
		expect(result.log).toContain("gitleaks_8.28.0_linux_arm64.tar.gz");
		expect(result.log).not.toContain("linux_x64");
		expect(result.stdin).toContain("eff65261156100e5d94a6b3dec313d532fddfe19ae1590bf7a2b4f2699128356");
		expect(readFileSync(join(binDir, "gitleaks"), "utf8")).toContain("exit 0");
	});

	test("x86_64 downloads the x64 asset", () => {
		const result = install(tempDir("gitleaks-bin-"), {}, "x86_64");
		expect(result.log).toContain("gitleaks_8.28.0_linux_x64.tar.gz");
		expect(result.log).not.toContain("linux_arm64");
	});

	test.each(["armv7l", "riscv64", "i686"])("unsupported architecture %s fails before any download", (arch) => {
		const binDir = tempDir("gitleaks-bin-");
		const result = install(binDir, {}, arch);
		expect(result.code).not.toBe(0);
		expect(result.err).toContain(arch);
		expect(result.log).not.toContain("curl ");
		expect(existsSync(join(binDir, "gitleaks"))).toBe(false);
	});

	test("checksum rejection preserves the existing binary and cleans the download", () => {
		const binDir = tempDir("gitleaks-bin-");
		writeFileSync(join(binDir, "gitleaks"), "previous");
		const result = install(binDir, { SHA_OK: "0" });
		expect(result.code).not.toBe(0);
		expect(result.log).not.toContain("tar ");
		expect(readFileSync(join(binDir, "gitleaks"), "utf8")).toBe("previous");
		expect(leftovers(binDir)).toEqual([]);
	});

	test("a missing BIN_DIR argument prints usage instead of installing somewhere", () => {
		const p = Bun.spawnSync(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe" });
		expect(p.exitCode).toBe(2);
		expect(new TextDecoder().decode(p.stderr).trim()).toBe("usage: ci-install-gitleaks.sh BIN_DIR");
	});
});
