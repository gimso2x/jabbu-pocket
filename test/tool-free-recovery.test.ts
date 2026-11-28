import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastAssistantEntry } from "../src/core/tool-free-recovery";

const assistant = (id: string, usage: unknown, timestamp = "2026-11-27T10:00:00.000Z"): Record<string, unknown> => ({
	id,
	parentId: null,
	type: "message",
	timestamp,
	message: {
		role: "assistant",
		content: [{ type: "text", text: "old answer" }],
		usage,
		provider: "anthropic",
		model: "claude-sonnet-4",
	},
});

const usage = { input: 1000, cacheRead: 300000, cacheWrite: 5000, cost: { cacheWrite: 0.5 } };

describe("readLastAssistantEntry", () => {
	test("returns the last assistant entry with usage from the tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-seed-tail-"));
		try {
			const file = join(dir, "session.jsonl");
			writeFileSync(
				file,
				[
					JSON.stringify({ id: "e1", parentId: null, type: "model_change" }),
					JSON.stringify(assistant("e2", usage)),
					JSON.stringify(assistant("e3", undefined)),
					JSON.stringify({ id: "e4", parentId: "e3", type: "session_info" }),
				].join("\n"),
			);
			expect(readLastAssistantEntry(file)?.id).toBe("e2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns undefined for a missing file and for a tail with no assistant usage", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-seed-tail-"));
		try {
			expect(readLastAssistantEntry(join(dir, "nope.jsonl"))).toBeUndefined();
			const file = join(dir, "session.jsonl");
			writeFileSync(
				file,
				[JSON.stringify(assistant("e2", undefined)), JSON.stringify({ id: "e3", type: "model_change" })].join("\n"),
			);
			expect(readLastAssistantEntry(file)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("tolerates a truncated line at the tail boundary", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-seed-tail-"));
		try {
			const file = join(dir, "session.jsonl");
			writeFileSync(file, `${JSON.stringify(assistant("e2", usage))}\n{"id":"e3","type":"mess`);
			expect(readLastAssistantEntry(file)?.id).toBe("e2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("does not look past the 64 KiB tail window", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-seed-tail-"));
		try {
			const file = join(dir, "session.jsonl");
			const filler = Array.from({ length: 1400 }, (_, i) =>
				JSON.stringify({
					id: `f${i}`,
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "x".repeat(50) }] },
				}),
			);
			writeFileSync(file, [JSON.stringify(assistant("e2", usage)), ...filler].join("\n"));
			expect(readLastAssistantEntry(file)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
