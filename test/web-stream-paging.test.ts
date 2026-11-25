import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { handleWebStream } from "../src/web/stream";

let home = "";
let store: Store;
let tick = 1_800_000_000_000;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-stream-"));
	store = openStore({ path: join(home, "jabbu.db"), timezone: "Asia/Seoul", clock: { now: () => tick++ }, redact });
});

afterEach(() => {
	store.close();
	rmSync(home, { recursive: true, force: true });
});

/** Runs `polls` stream polls from the given cursors and returns the message ids delivered, in order. */
function deliveries(after: number, afterEdited: number, polls: number): number[] {
	const ids: number[] = [];
	const queue: Array<() => void> = [];
	handleWebStream(
		new Request("http://x/api/web/stream"),
		new URL(`http://x/api/web/stream?after=${after}&afterEdited=${afterEdited}`),
		{
			streamSchedule: (fn) => {
				queue.push(fn);
				return () => {};
			},
		},
		{ id: "b", homeDir: home } as never,
		false,
		{},
		(_req, _keepAliveMs, subscribe) => {
			subscribe((chunk) => {
				const m = /^event: messages\ndata: (.*)\n\n$/s.exec(chunk);
				if (m !== null) for (const row of JSON.parse(m[1] as string).messages) ids.push(row.id);
			});
			return new Response("");
		},
	);
	for (let i = 0; i < polls; i++) queue.shift()?.();
	return ids;
}

function seed(total: number, edited: number, order: "asc" | "desc"): void {
	for (let i = 0; i < total; i++) store.web.insert({ conversation: "c1", role: "assistant", text: `m${i}` });
	const targets = Array.from({ length: edited }, (_, i) => i + 1);
	if (order === "desc") targets.reverse();
	for (const id of targets) store.web.edit(id, { text: `edited ${id}` });
}

describe("web stream pages through more than 200 changes", () => {
	test("edits made newest-first to 250 old rows still deliver the 100 newer rows, each exactly once", () => {
		seed(250, 250, "desc");
		for (let i = 0; i < 100; i++) store.web.insert({ conversation: "c1", role: "assistant", text: `n${i}` });
		const ids = deliveries(0, 0, 5);
		expect(new Set(ids).size).toBe(350);
		expect(ids.length).toBe(350);
	});

	test("edits in id order keep working and nothing repeats", () => {
		seed(250, 250, "asc");
		for (let i = 0; i < 100; i++) store.web.insert({ conversation: "c1", role: "assistant", text: `n${i}` });
		const ids = deliveries(0, 0, 5);
		expect(new Set(ids).size).toBe(350);
		expect(ids.length).toBe(350);
	});

	test("a later edit after a full catch-up is delivered once", () => {
		seed(10, 0, "asc");
		expect(deliveries(0, 0, 3)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});
});
