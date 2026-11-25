import { open, realpath, stat } from "node:fs/promises";
import { sniffImageMime } from "../channel/attachments";
import type { Logger } from "../log";
import { isInside } from "../safety/inside";

/*
 * Inbound image attachments as ACP `image` prompt blocks. The adapters save a chat attachment under
 * `<homeDir>/media/inbound/<message>/` and append a note line `[첨부: <path> (<mimetype>)]` to the text
 * (`src/channel/attachments.ts`). Only such a note standing alone on a line, outside a ``` fence and outside a
 * `<<<quoted-…>>>` block, is a candidate, and only a regular image file inside the inbound root is read: other
 * `media` files (bot-made briefings), quoted or recalled notes and paths a sender typed never reach the model as bytes.
 */

/** At most this many images go with one prompt (the first ones). */
export const MAX_PROMPT_IMAGES = 4;
/** An image file larger than this is left to the agent's own tools. */
export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;

/** A `type` (not an interface) so it passes as the driver's `Record<string, unknown>` prompt block. */
export type AcpImageBlock = {
	type: "image";
	mimeType: string;
	data: string;
};

type SkipReason = "outside" | "missing" | "too_large" | "not_image" | "over_limit";

const NOTE_LINE = /^\s*\[첨부: (.+) \((image\/[^()\s]+)\)\]\s*$/;
const QUOTE_OPEN = /^<<<quoted-([^>\n]*)>>>$/;
const MAGIC_HEAD_BYTES = 12;

/** Paths of the image notes that stand alone on a line outside fences and quoted blocks, in order. */
function notedImagePaths(text: string): string[] {
	const paths: string[] = [];
	let fenced = false;
	let quoteEnd: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (quoteEnd !== undefined) {
			if (trimmed === quoteEnd) quoteEnd = undefined;
			continue;
		}
		if (trimmed.startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const quote = QUOTE_OPEN.exec(trimmed);
		if (quote !== null) {
			// An open marker without its end hides the rest of the text.
			quoteEnd = `<<<end-quoted-${quote[1]}>>>`;
			continue;
		}
		const path = NOTE_LINE.exec(line)?.[1];
		if (path !== undefined) paths.push(path);
	}
	return paths;
}

/** One candidate's block, or why it was skipped. Any filesystem failure counts as `missing`. */
async function readImage(path: string, root: string): Promise<AcpImageBlock | SkipReason> {
	let real: string;
	try {
		real = await realpath(path);
	} catch {
		return "missing";
	}
	if (real === root || !isInside(real, root)) return "outside";
	try {
		const info = await stat(real);
		if (!info.isFile()) return "not_image";
		if (info.size > MAX_PROMPT_IMAGE_BYTES) return "too_large";
		const handle = await open(real, "r");
		try {
			const head = new Uint8Array(MAGIC_HEAD_BYTES);
			await handle.read(head, 0, MAGIC_HEAD_BYTES, 0);
			const mimeType = sniffImageMime(head);
			if (mimeType === undefined) return "not_image";
			const bytes = await handle.readFile();
			// The file may have grown since `stat`.
			if (bytes.length > MAX_PROMPT_IMAGE_BYTES) return "too_large";
			return { type: "image", mimeType, data: bytes.toString("base64") };
		} finally {
			await handle.close();
		}
	} catch {
		return "missing";
	}
}

/**
 * The image blocks for the attachment notes in `text` (see the file comment); none without `inboundRoot` or when it
 * does not exist. Every skipped note is logged `agy.acp.image_skipped` with its reason, the taken ones together as
 * `agy.acp.image_attached`.
 */
export async function promptImageBlocks(
	text: string,
	inboundRoot: string | undefined,
	log?: Logger,
	origin?: string,
): Promise<AcpImageBlock[]> {
	if (inboundRoot === undefined) return [];
	const paths = notedImagePaths(text);
	if (paths.length === 0) return [];
	let root: string;
	try {
		root = await realpath(inboundRoot);
	} catch {
		return [];
	}
	const blocks: AcpImageBlock[] = [];
	for (const path of paths) {
		const read = blocks.length < MAX_PROMPT_IMAGES ? await readImage(path, root) : "over_limit";
		if (typeof read === "string") log?.info("agy.acp.image_skipped", { origin, path, reason: read });
		else blocks.push(read);
	}
	if (blocks.length > 0) {
		const bytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.data, "base64"), 0);
		log?.info("agy.acp.image_attached", { origin, count: blocks.length, bytes });
	}
	return blocks;
}
