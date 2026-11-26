import { appendFile, write as writeFd } from "node:fs";
import { workerData } from "node:worker_threads";
import { sampleHostPressure } from "./host-pressure";

/**
 * The watchdog's own thread: once the main thread's beat counter stalls for `stallMs` it logs `watchdog_kill` with the
 * host's memory/IO pressure and SIGKILLs the process for systemd (`Restart=on-failure`); it never waits on the main thread.
 */
const { beats, stallMs, logPath } = workerData as { beats: SharedArrayBuffer; stallMs: number; logPath?: string };
const counter = new Int32Array(beats);
let seen = Atomics.load(counter, 0);
let movedAt = performance.now(); // monotonic clock: a wall-clock step (NTP, suspend/resume) must not read as a stall
const KILL_GRACE_MS = 500;

const timer = setInterval(() => {
	const now = performance.now();
	const value = Atomics.load(counter, 0);
	if (value !== seen) {
		seen = value;
		movedAt = now;
		return;
	}
	if (now - movedAt < stallMs) return;
	clearInterval(timer);
	// The record goes through the thread pool: a write that blocks (a FIFO log, a full stderr pipe) or a slow host
	// sample must not keep the kill from happening, so SIGKILL follows when the writes settle or after KILL_GRACE_MS.
	const kill = () => process.kill(process.pid, "SIGKILL");
	setTimeout(kill, KILL_GRACE_MS);
	const line = `${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "watchdog_kill", stalled_ms: Math.round(now - movedAt), pid: process.pid, host: sampleHostPressure() })}\n`;
	let pending = logPath === undefined ? 1 : 2;
	const settled = () => {
		pending -= 1;
		if (pending === 0) kill();
	};
	writeFd(2, line, settled); // stderr closed or full: the file below is the record
	if (logPath !== undefined) appendFile(logPath, line, { mode: 0o600 }, settled);
}, 1_000);
