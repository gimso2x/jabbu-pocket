import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleHostPressure } from "../src/daemon/host-pressure";

const dirs: string[] = [];
function fakeProc(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-host-pressure-"));
	dirs.push(dir);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sampleHostPressure", () => {
	test("reads meminfo, the vmstat OOM-kill counter and memory/io PSI averages", () => {
		const proc = fakeProc({
			meminfo: "MemTotal:       24000000 kB\nMemFree:  100 kB\nMemAvailable:     150000 kB\nSwapFree:  0 kB\n",
			vmstat: "nr_free_pages 12\noom_kill 3\n",
			"pressure/memory":
				"some avg10=41.50 avg60=20.25 avg300=5.00 total=99\nfull avg10=30.00 avg60=12.00 avg300=3.00 total=77\n",
			"pressure/io": "some avg10=2.00 avg60=1.00 avg300=0.00 total=5\nfull avg10=0.50 avg60=0.25 avg300=0.00 total=3\n",
		});
		expect(sampleHostPressure(proc)).toEqual({
			mem_available_kb: 150_000,
			mem_total_kb: 24_000_000,
			swap_free_kb: 0,
			oom_kills: 3,
			psi_memory: { some_avg10: 41.5, some_avg60: 20.25, full_avg10: 30, full_avg60: 12 },
			psi_io: { some_avg10: 2, some_avg60: 1, full_avg10: 0.5, full_avg60: 0.25 },
		});
	});

	test("missing or unparsable files leave their fields out instead of failing", () => {
		const proc = fakeProc({ meminfo: "MemAvailable: 42 kB\n", "pressure/memory": "garbage\n" });
		expect(sampleHostPressure(proc)).toEqual({ mem_available_kb: 42 });
		expect(sampleHostPressure(join(proc, "absent"))).toEqual({});
	});
});
