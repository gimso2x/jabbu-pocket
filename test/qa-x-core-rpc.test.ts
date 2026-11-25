// QA qa-x fixes: RPC client/driver edge cases, select cards.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OmpDialogRequest, OmpDriverError, type OmpFinal } from "../src/omp/driver";
import { MAX_RPC_FRAME_BYTES, OmpRpcClient, RpcProtocolError, readLines } from "../src/omp/rpc-client";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import { ExtensionUiTap } from "../src/omp/rpc-ui-tap";
import type { ApprovalBroker } from "../src/safety/approval";
import { answerDialog } from "../src/safety/choice";
import { FakeOmpPeer, fakeOmpExecutable } from "./helpers/fake-omp-rpc";

const root = mkdtempSync(join(tmpdir(), "jabbu-qa-x-core-rpc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirCounter = 0;

/** Rejects when `promise` has not settled within `ms` (a failure deadline, never a wait for time to pass). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
	return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
}

describe("rpc client", () => {
	test("#1 a request the child never answers fails with request_timeout, the code the mailbox replaces the child on", async () => {
		const peer = new FakeOmpPeer();
		peer.replies.set("get_state", () => "hold");
		const client = new OmpRpcClient({
			executable: "omp",
			args: [],
			cwd: root,
			env: {},
			spawn: peer.spawn,
			requestTimeoutMs: 20,
		});
		await client.start();
		try {
			const error = await client.getState().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(OmpDriverError);
			expect(error).toMatchObject({ code: "request_timeout" });
			expect((error as Error).message).toContain("no response to get_state");
		} finally {
			await client.stop();
		}
	});

	test("#2 a prompt_result without a valid status ends the turn as an error final, never an undefined status", async () => {
		const peer = new FakeOmpPeer();
		const dir = join(root, `d${++dirCounter}`);
		mkdirSync(dir, { recursive: true });
		const driver = new RpcOmpDriver({
			ompExecutable: fakeOmpExecutable(dir),
			cwd: join(dir, "ws"),
			sessionDir: join(dir, "s"),
			spawn: peer.spawn,
		});
		await driver.start();
		try {
			const finals: OmpFinal[] = [];
			const ended = Promise.withResolvers<void>();
			driver.onFinal((final) => {
				finals.push(final);
				ended.resolve();
			});
			const opRef = await driver.prompt("hi");
			peer.push({ type: "prompt_result", id: opRef, agentInvoked: true });
			await within(ended.promise, 2000, "error final");
			expect(finals).toEqual([{ opRef, status: "error", text: "", error: expect.stringContaining("status") }]);
		} finally {
			await driver.stop();
		}
	});

	test("#3 a line past the 1 MiB frame limit without a newline is a protocol error, not unbounded buffering", async () => {
		const piece = new Uint8Array(256 * 1024).fill(97);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let sent = 0; sent <= MAX_RPC_FRAME_BYTES; sent += piece.byteLength) controller.enqueue(piece);
				controller.close();
			},
		});
		await expect(
			(async () => {
				for await (const _line of readLines(stream)) {
					// the oversized line must never be yielded
				}
			})(),
		).rejects.toBeInstanceOf(RpcProtocolError);
	});

	test("#3 a frame exactly at the limit still passes", async () => {
		const body = `${"b".repeat(MAX_RPC_FRAME_BYTES - 1)}\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body.slice(0, 1000)));
				controller.enqueue(new TextEncoder().encode(body.slice(1000)));
				controller.close();
			},
		});
		const lines: string[] = [];
		for await (const line of readLines(stream)) lines.push(line);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.length).toBe(MAX_RPC_FRAME_BYTES - 1);
	});
});

/** Runs one select frame through omp's dialog tap and the real `answerDialog` card text, with a recording broker. */
async function cardTextOf(frame: Record<string, unknown>): Promise<{ request: OmpDialogRequest; text: string }> {
	let seen: OmpDialogRequest | undefined;
	let text = "";
	const broker = {
		dropInput: () => {},
		choose: async (_origin: unknown, spec: { text: string }) => {
			text = spec.text;
			return { next: async () => ({ kind: "cancelled" as const }), close: async () => {} };
		},
	} as unknown as ApprovalBroker;
	const replied = Promise.withResolvers<void>();
	const tap = new ExtensionUiTap(
		() => {},
		() => replied.resolve(),
		async (request, signal) => {
			seen = request;
			return answerDialog(broker, { originKey: "discord/dm/1", channel: "1", threadTs: "1" }, request, signal);
		},
	);
	tap.frame({ type: "extension_ui_request", method: "select", id: "u1", title: "고르세요", ...frame });
	await within(replied.promise, 2000, "dialog reply");
	if (seen === undefined) throw new Error("the dialog never reached the answerer");
	return { request: seen, text };
}

describe("select cards", () => {
	test("#4 optionDetails descriptions are listed on the card as `번호. 라벨 — 설명`", async () => {
		const { text } = await cardTextOf({
			options: ["배포", "취소"],
			optionDetails: [{ description: "운영에 올린다" }, {}],
		});
		expect(text).toContain("1. 배포 — 운영에 올린다");
		expect(text).toContain("2. 취소");
		expect(text).not.toContain("2. 취소 —");
	});

	test("#4 a select without descriptions keeps its plain card (no number list under buttons)", async () => {
		const { text } = await cardTextOf({ options: ["a", "b"] });
		expect(text).not.toContain("1. a");
	});

	test("#5 checkedIndices and markableCount mark the checked rows and the action rows", async () => {
		const { request, text } = await cardTextOf({
			options: ["빌드", "테스트", "Done"],
			selectionMarker: "checkbox",
			checkedIndices: [1],
			markableCount: 2,
		});
		expect(request).toMatchObject({ checkedIndices: [1], markableCount: 2 });
		expect(text).toContain("1. ☐ 빌드");
		expect(text).toContain("2. ☑ 테스트");
		expect(text).toContain("3. ▶ Done");
	});
});
