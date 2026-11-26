import { appendFile, write as writeFd } from "node:fs";
import { workerData } from "node:worker_threads";

/**
 * The watchdog's own thread: it reads the main thread's beat counter every second, and when the counter has not moved
 * for `stallMs` it logs `watchdog_kill` and SIGKILLs the whole process, so systemd (`Restart=on-failure`) starts a new
 * one. It runs while the main thread is stuck, which is the whole point: nothing here may wait on the main thread.
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
	const line = `${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "watchdog_kill", stalled_ms: Math.round(now - movedAt), pid: process.pid })}\n`;
	clearInterval(timer);
	// The record goes through the thread pool: a write that blocks (a FIFO log path, a full stderr pipe) must not keep
	// the kill from happening, so SIGKILL follows when the writes settle or after KILL_GRACE_MS.
	let pending = logPath === undefined ? 1 : 2;
	const kill = () => process.kill(process.pid, "SIGKILL");
	const settled = () => {
		pending -= 1;
		if (pending === 0) kill();
	};
	setTimeout(kill, KILL_GRACE_MS);
	writeFd(2, line, settled); // stderr closed or full: the file below is the record
	if (logPath !== undefined) appendFile(logPath, line, { mode: 0o600 }, settled);
}, 1_000);
