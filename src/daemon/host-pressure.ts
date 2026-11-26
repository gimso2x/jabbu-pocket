import { readFileSync } from "node:fs";
import { join } from "node:path";

/** PSI stall percentages of one resource (`/proc/pressure/<resource>`): `full` is absent for `cpu` on older kernels. */
export interface PsiSample {
	some_avg10?: number;
	some_avg60?: number;
	full_avg10?: number;
	full_avg60?: number;
}

/**
 * Host memory and I/O pressure at one moment, for the `watchdog_kill` record: a main thread stalled by a starved host
 * reads differently from one stuck in its own loop. Each field is present only when its file was readable, so off
 * Linux (no `/proc`) the result is `{}`.
 */
export interface HostPressure {
	mem_available_kb?: number;
	mem_total_kb?: number;
	swap_free_kb?: number;
	/** `oom_kill` in `/proc/vmstat`: kernel OOM kills on the whole host since boot. */
	oom_kills?: number;
	psi_memory?: PsiSample;
	psi_io?: PsiSample;
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined; // missing on this kernel or OS: the field is left out
	}
}

/** `{ key: number }` for each line of a `Key: 123 kB` or `key 123` file. */
function keyedNumbers(text: string): Map<string, number> {
	const found = new Map<string, number>();
	for (const line of text.split("\n")) {
		const [key, value] = line.replace(":", " ").trim().split(/\s+/);
		const number = Number(value);
		if (key && value !== undefined && Number.isFinite(number)) found.set(key, number);
	}
	return found;
}

/** A PSI file's `some`/`full` lines (`some avg10=0.00 avg60=0.00 avg300=0.00 total=0`). */
function psi(text: string): PsiSample | undefined {
	const sample: PsiSample = {};
	for (const line of text.split("\n")) {
		const [kind, ...pairs] = line.trim().split(/\s+/);
		if (kind !== "some" && kind !== "full") continue;
		for (const pair of pairs) {
			const [key, value] = pair.split("=");
			const number = Number(value);
			if ((key === "avg10" || key === "avg60") && Number.isFinite(number)) sample[`${kind}_${key}`] = number;
		}
	}
	return Object.keys(sample).length > 0 ? sample : undefined;
}

/** Samples `<proc>/meminfo`, `<proc>/vmstat` and `<proc>/pressure/{memory,io}` (`proc` overrides `/proc` for tests). */
export function sampleHostPressure(proc = "/proc"): HostPressure {
	const out: HostPressure = {};
	const meminfoText = readText(join(proc, "meminfo"));
	if (meminfoText !== undefined) {
		const meminfo = keyedNumbers(meminfoText);
		const available = meminfo.get("MemAvailable");
		const total = meminfo.get("MemTotal");
		const swapFree = meminfo.get("SwapFree");
		if (available !== undefined) out.mem_available_kb = available;
		if (total !== undefined) out.mem_total_kb = total;
		if (swapFree !== undefined) out.swap_free_kb = swapFree;
	}
	const vmstatText = readText(join(proc, "vmstat"));
	const oomKills = vmstatText === undefined ? undefined : keyedNumbers(vmstatText).get("oom_kill");
	if (oomKills !== undefined) out.oom_kills = oomKills;
	for (const [resource, field] of [
		["memory", "psi_memory"],
		["io", "psi_io"],
	] as const) {
		const text = readText(join(proc, "pressure", resource));
		const sample = text === undefined ? undefined : psi(text);
		if (sample !== undefined) out[field] = sample;
	}
	return out;
}
