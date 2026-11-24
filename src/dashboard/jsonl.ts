import { closeSync, openSync, readSync } from "node:fs";
import { isRecord } from "../omp/type-guards";

type Json = Record<string, unknown>;

/**
 * The object records of a session `.jsonl`, one at a time and read in chunks, skipping the torn line omp may be
 * writing. A caller that needs only the first records stops early without reading the rest of the file.
 */
export function* iterJsonlRecords(file: string): Generator<Json> {
	const fd = openSync(file, "r");
	try {
		const decoder = new TextDecoder();
		const chunk = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
		let pending = "";
		let scanned = 0; // pending has no "\n" before this index, so a search resumes from it
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			const last = read === 0;
			pending += last ? decoder.decode() : decoder.decode(chunk.subarray(0, read), { stream: true });
			let start = 0;
			for (;;) {
				const end = pending.indexOf("\n", scanned);
				if (end === -1) break;
				const entry = parseJsonlLine(pending.slice(start, end));
				if (entry !== undefined) yield entry;
				start = end + 1;
				scanned = start;
			}
			if (last) {
				const entry = parseJsonlLine(pending.slice(start));
				if (entry !== undefined) yield entry;
				return;
			}
			pending = pending.slice(start);
			scanned = pending.length;
		}
	} finally {
		closeSync(fd);
	}
}

const JSONL_CHUNK_BYTES = 1 << 20;

function parseJsonlLine(line: string): Json | undefined {
	if (line === "") return undefined;
	try {
		const entry: unknown = JSON.parse(line);
		return isRecord(entry) ? entry : undefined;
	} catch (error) {
		// The line omp is writing right now; the next read has it whole.
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** The object records of a session `.jsonl`, skipping the torn line omp may be writing. */
export function readJsonlRecords(file: string): Json[] {
	return Array.from(iterJsonlRecords(file));
}
