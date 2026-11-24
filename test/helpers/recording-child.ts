// A stand-in executable that leaves a record of how it was started: the tests that prove a child gets exactly the argv
// and environment the caller meant (one prompt as one element, no inherited secret, no `GIT_*` redirect) read it back.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One run of a recording child: `argv[0]` is the path it was started as, `env` the whole environment it got. */
export interface Recording {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
}

const SEQUENCE = ".seq";
const LOCK = ".seq.lock";
const RECORDINGS = ".recordings";

/** The script the child runs: a lock-protected run counter, the argv/env/cwd of this run, then the caller's body. */
function scriptText(dir: string, body: string): string {
	const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
	const d = quoted(join(dir, RECORDINGS));
	return `#!/bin/sh
set -u
d=${d}
tries=0
while ! mkdir "$d/${LOCK}" 2>/dev/null; do
	tries=$((tries + 1))
	[ "$tries" -gt 5000 ] && exit 97
	sleep 0.005
done
n=$(cat "$d/${SEQUENCE}" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$d/${SEQUENCE}"
rmdir "$d/${LOCK}"
printf '%s\\000' "$0" > "$d/$n.argv"
for a in "$@"; do printf '%s\\000' "$a" >> "$d/$n.argv"; done
# NUL-separated entries, never re-joined through a line: a value holding a newline stays one variable.
if ! env -0 > "$d/$n.env" 2>/dev/null; then cat "/proc/$$/environ" > "$d/$n.env" 2>/dev/null || env > "$d/$n.env"; fi
pwd -P > "$d/$n.cwd"
${body}
`;
}

/**
 * Writes an executable shell script into `dir` and returns its path. Every run records its argv, environment and
 * working directory (see `readRecording`), then executes `body` as shell text (`exit 0` when absent).
 */
export function recordingChild(dir: string, name = "recording-child", body = "exit 0"): string {
	mkdirSync(join(dir, RECORDINGS), { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, scriptText(dir, body), { mode: 0o755 });
	chmodSync(file, 0o755);
	return file;
}

/** A NUL-separated file as its entries; the trailing empty one a closing NUL leaves is dropped. */
function nulEntries(text: string): string[] {
	const parts = text.split("\0");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

/**
 * The recordings of the children `recordingChild(dir)` made, in the order they ran. A test that wants the environment of
 * exactly one run uses `[0]`; a test proving a variable never reached a child checks every entry.
 */
export function readRecording(dir: string): Recording[] {
	const root = join(dir, RECORDINGS);
	if (!existsSync(root)) return [];
	const count = Number(readFileSync(join(root, SEQUENCE), "utf8").trim() || "0");
	const out: Recording[] = [];
	for (let n = 1; n <= count; n++) {
		const argvFile = join(root, `${n}.argv`);
		if (!existsSync(argvFile)) continue;
		const env: Record<string, string> = {};
		for (const entry of nulEntries(readFileSync(join(root, `${n}.env`), "utf8"))) {
			const eq = entry.indexOf("=");
			if (eq <= 0) continue;
			env[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
		const cwdFile = join(root, `${n}.cwd`);
		out.push({
			argv: nulEntries(readFileSync(argvFile, "utf8")),
			env,
			cwd: existsSync(cwdFile) ? readFileSync(cwdFile, "utf8").trim() : "",
		});
	}
	return out;
}
