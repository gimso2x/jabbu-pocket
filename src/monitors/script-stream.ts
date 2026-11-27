import { createHash, type Hash } from "node:crypto";

/** ASCII whitespace bytes trimmed from raw `Uint8Array` stdout chunks (` `, `\t`, `\n`, `\v`, `\f`, `\r`). */
const isAsciiSpace = (byte: number): boolean => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

/**
 * sha256 of the stream's trimmed content, fed chunk by chunk.
 * - `Uint8Array` chunks trim leading/trailing ASCII whitespace bytes (`0x20`, `0x09..0x0d`) and hash raw bytes as-is.
 * - `string` chunks trim leading/trailing JS `\s` whitespace and encode text as UTF-8.
 * Trailing whitespace goes into a forked copy of the hash state instead of a pending buffer, so a long whitespace run
 * uses O(1) memory; non-whitespace that follows adopts the fork, while trailing whitespace at EOF is discarded.
 */
export function trimmedHash(): { update(chunk: string | Uint8Array): void; digest(): string } {
	let sha = createHash("sha256");
	let started = false;
	/** `sha` plus the whitespace seen since the last non-whitespace byte/char; undefined when there is none. */
	let ahead: Hash | undefined;
	const commit = (body: string | Uint8Array, trailing: string | Uint8Array): void => {
		if (ahead !== undefined) {
			sha = ahead;
			ahead = undefined;
		}
		sha.update(body);
		if (trailing.length > 0) {
			ahead = sha.copy();
			ahead.update(trailing);
		}
	};
	return {
		update(chunk) {
			if (typeof chunk === "string") {
				const text = started ? chunk : chunk.replace(/^\s+/, "");
				if (text === "") return;
				started = true;
				let end = text.length;
				while (end > 0 && /\s/.test(text[end - 1] as string)) end -= 1;
				if (end === 0) {
					ahead ??= sha.copy();
					ahead.update(text);
					return;
				}
				commit(text.slice(0, end), text.slice(end));
				return;
			}
			let start = 0;
			if (!started) while (start < chunk.length && isAsciiSpace(chunk[start] as number)) start += 1;
			if (start === chunk.length) return;
			started = true;
			let end = chunk.length;
			while (end > start && isAsciiSpace(chunk[end - 1] as number)) end -= 1;
			if (end === start) {
				ahead ??= sha.copy();
				ahead.update(chunk.subarray(start));
				return;
			}
			commit(chunk.subarray(start, end), chunk.subarray(end));
		},
		digest: () => sha.digest("hex"),
	};
}

export interface LastLineResult {
	line: string;
	overflow: boolean;
}

/**
 * Tracks the last non-empty trimmed line of a decoded stdout stream within bounded memory (`maxChars`).
 * Completely decoupled from the 4 MiB head collection cap so a chunk/cap boundary never fabricates a line break.
 */
export class LastLineTracker {
	readonly #maxChars: number;
	#lastLine = "";
	#lastOverflow = false;
	#cur = "";
	#curOverflow = false;
	#pendingWs = "";
	#pendingWsOverflow = false;

	constructor(maxChars: number) {
		this.#maxChars = maxChars;
	}

	update(chunk: string): void {
		if (chunk === "") return;
		let start = 0;
		for (;;) {
			const nl = chunk.indexOf("\n", start);
			if (nl === -1) {
				this.#appendSegment(start === 0 ? chunk : chunk.slice(start));
				return;
			}
			this.#appendSegment(chunk.slice(start, nl));
			this.#commitLine();
			start = nl + 1;
		}
	}

	finish(): LastLineResult {
		this.#commitLine();
		return { line: this.#lastLine, overflow: this.#lastOverflow };
	}

	#commitLine(): void {
		if (this.#curOverflow || this.#cur !== "") {
			this.#lastLine = this.#cur;
			this.#lastOverflow = this.#curOverflow;
		}
		this.#cur = "";
		this.#curOverflow = false;
		this.#pendingWs = "";
		this.#pendingWsOverflow = false;
	}

	#appendSegment(seg: string): void {
		if (seg === "" || this.#curOverflow) return;
		const rest = this.#cur === "" ? seg.replace(/^\s+/, "") : seg;
		if (rest === "") return;
		let end = rest.length;
		while (end > 0 && /\s/.test(rest[end - 1] as string)) end -= 1;
		if (end === 0) {
			if (this.#pendingWsOverflow) return;
			if (this.#cur.length + this.#pendingWs.length + rest.length > this.#maxChars) {
				this.#pendingWsOverflow = true;
				this.#pendingWs = "";
			} else {
				this.#pendingWs += rest;
			}
			return;
		}
		const body = rest.slice(0, end);
		const trail = rest.slice(end);
		if (this.#pendingWsOverflow || this.#cur.length + this.#pendingWs.length + body.length > this.#maxChars) {
			if (!this.#pendingWsOverflow) {
				const room = this.#maxChars - this.#cur.length;
				if (room > 0) this.#cur += `${this.#pendingWs}${body}`.slice(0, room);
			}
			this.#curOverflow = true;
			this.#pendingWs = "";
			this.#pendingWsOverflow = false;
			return;
		}
		this.#cur += `${this.#pendingWs}${body}`;
		this.#pendingWs = "";
		if (trail !== "") {
			if (this.#cur.length + trail.length > this.#maxChars) this.#pendingWsOverflow = true;
			else this.#pendingWs = trail;
		}
	}
}
