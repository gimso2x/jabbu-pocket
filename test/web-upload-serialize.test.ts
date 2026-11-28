import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWebUpload, webUploadRoot } from "../src/web/upload";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-upload-serial-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

// Lets the event loop run queued microtasks and one macrotask turn, so a second upload that is free
// to start would have finished writing its file by the time this resolves.
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

function uploadRequest(body: Uint8Array | ReadableStream<Uint8Array>): Request {
	return new Request("http://x/api/web/upload", {
		method: "POST",
		headers: { "content-type": "application/octet-stream", "x-filename": "a.bin" },
		body,
		duplex: "half",
	});
}

describe("web uploads run one at a time", () => {
	test("a second upload writes nothing while the first is still streaming", async () => {
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted!: () => void;
		const firstStartedPromise = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		// Bun pulls a stream body eagerly, so the first pull marks the upload as streaming, not as read.
		let started = false;
		const firstBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				firstStarted();
				if (started) return;
				started = true;
				void firstReleased.then(() => {
					controller.enqueue(new TextEncoder().encode("x"));
					controller.close();
				});
			},
		});

		const a = saveWebUpload(uploadRequest(firstBody), home);
		const b = saveWebUpload(uploadRequest(new TextEncoder().encode("y")), home);
		await firstStartedPromise;
		await drain();
		// The first upload is still mid-body and the second is queued behind it: nothing written yet.
		expect(readdirSync(webUploadRoot(home))).toEqual([]);

		releaseFirst();
		const [first, second] = await Promise.all([a, b]);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(readdirSync(webUploadRoot(home))).toHaveLength(2);
	});
});
