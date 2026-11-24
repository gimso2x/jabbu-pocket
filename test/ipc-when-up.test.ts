// `callDaemonWhenUp`: a request that found nobody listening is sent again while the daemon restarts; a request that
// went out is never repeated.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	callDaemon,
	callDaemonWhenUp,
	DAEMON_RETRY_MS,
	IpcNoResponse,
	IpcNotListening,
	startIpcServer,
} from "../src/daemon/ipc";

/** A fake clock the fake sleep moves. */
function clock() {
	let at = 0;
	const sleeps: number[] = [];
	return {
		sleeps,
		now: () => at,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			at += ms;
		},
	};
}

describe("callDaemonWhenUp", () => {
	test("nobody listening twice, then the new daemon answers: three attempts, two pauses", async () => {
		const c = clock();
		let calls = 0;
		const call = async () => {
			calls += 1;
			if (calls < 3) throw new IpcNotListening("Failed to connect");
			return { ok: true };
		};
		expect(await callDaemonWhenUp("/sock", {}, 60_000, { call, ...c })).toEqual({ ok: true });
		expect(calls).toBe(3);
		expect(c.sleeps).toEqual([DAEMON_RETRY_MS, DAEMON_RETRY_MS]);
	});

	test("a request that went out (no answer) is not sent again", async () => {
		const c = clock();
		let calls = 0;
		const call = async () => {
			calls += 1;
			throw new IpcNoResponse("ipc timeout");
		};
		await expect(callDaemonWhenUp("/sock", {}, 60_000, { call, ...c })).rejects.toBeInstanceOf(IpcNoResponse);
		expect(calls).toBe(1);
	});

	test("still nobody at the deadline: the last IpcNotListening is thrown", async () => {
		const c = clock();
		let calls = 0;
		const call = async () => {
			calls += 1;
			throw new IpcNotListening("Failed to connect");
		};
		await expect(callDaemonWhenUp("/sock", {}, 5 * DAEMON_RETRY_MS, { call, ...c })).rejects.toBeInstanceOf(
			IpcNotListening,
		);
		expect(calls).toBe(6);
	});

	test("callDaemon rejects with IpcNotListening on a socket nobody serves, and answers once a server is up", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-ipc-up-"));
		const path = join(dir, "jabbu.sock");
		try {
			await expect(callDaemon(path, { op: "x" })).rejects.toBeInstanceOf(IpcNotListening);
			const server = startIpcServer(path, async () => ({ ok: true }));
			try {
				expect(await callDaemon(path, { op: "x" })).toEqual({ ok: true });
			} finally {
				server.stop();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
