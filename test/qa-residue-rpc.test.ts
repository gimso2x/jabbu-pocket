import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

interface BtwRecord {
	id: string;
	status: string;
	answer: string;
	error?: string;
}

/**
 * The side-question wire of an in-memory omp peer: the `btw` command stays open until `answerBtw`/`failBtw`,
 * `emitBtwRecord` writes a `btw_record` frame; frames keep their stdout order, as on the real pipe.
 */
class BtwPeer extends FakeOmpPeer {
	constructor() {
		super();
		this.replies.set("btw", () => "hold");
	}
	get btwCalls(): unknown[] {
		return this.commands.filter((c) => c.type === "btw").map((c) => c.question);
	}
	get cancelCalls(): unknown[][] {
		return this.commands
			.filter((c) => c.type === "btw_cancel")
			.map((c) => (c.recordId === undefined ? [] : [c.recordId]));
	}
	emitBtwRecord(record: BtwRecord): void {
		this.push({ type: "btw_record", record });
	}
	async answerBtw(record: BtwRecord): Promise<void> {
		this.respond(await this.command((c) => c.type === "btw"), { data: { record } });
	}
	async failBtw(message: string): Promise<void> {
		this.respond(await this.command((c) => c.type === "btw"), { error: message });
	}
}

const record = (id: string, status: string, answer = "", error?: string): BtwRecord =>
	error === undefined ? { id, status, answer } : { id, status, answer, error };

describe("qa-y 16: btw ends with the child", () => {
	test("a side question whose omp child exits is rejected at once, not at the btw deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "jabbu-btw-exit-"));
		const client = new BtwPeer();
		const driver = new RpcOmpDriver({
			ompExecutable: fakeOmpExecutable(root),
			cwd: root,
			sessionDir: join(root, "s"),
			spawn: client.spawn,
			btwTimeoutMs: 2_000,
		});
		try {
			await driver.start();
			const answer = driver.btw("q").then(
				() => "resolved",
				(error: Error) => `rejected: ${error.message}`,
			);
			await client.command((c) => c.type === "btw");
			await client.answerBtw(record("r1", "running"));
			// A later round trip on the same ordered pipe: once it is back, the `btw` response before it has been read.
			await driver.state();
			client.exit(1);
			// Before the fix nothing rejected the wait: it ended at the side-question deadline as `btw timeout`.
			expect(await answer).toContain("omp exited");
		} finally {
			await driver.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
