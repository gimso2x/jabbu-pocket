import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInboundAttachment } from "../src/channel/attachments";
import { createLogger, type Logger } from "../src/log";
import { MAX_PROMPT_IMAGE_BYTES, promptImageBlocks } from "../src/omp/agy-images";
import { redact } from "../src/redact";

const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);

function captureLog(): { log: Logger; lines: string[] } {
	const lines: string[] = [];
	return { log: createLogger({ sink: (line) => lines.push(line), clock: { now: () => Date.now() }, redact }), lines };
}

/** A home with `media/inbound/m1/` and `media/briefing/`; `png(dir, name)` writes a small png and returns its note. */
function makeHome(): {
	media: string;
	inbound: string;
	png(dir: string, name: string): { path: string; note: string };
} {
	const home = mkdtempSync(join(tmpdir(), "jabbu-agy-images-"));
	tempDirs.push(home);
	const media = join(home, "media");
	const inbound = join(media, "inbound");
	mkdirSync(join(inbound, "m1"), { recursive: true });
	mkdirSync(join(media, "briefing"), { recursive: true });
	return {
		media,
		inbound,
		png: (dir, name) => {
			const path = join(dir, name);
			writeFileSync(path, PNG);
			return { path, note: `[첨부: ${path} (image/png)]` };
		},
	};
}

test("a standalone note of an inbound png becomes one image block with the sniffed type and the file's base64", async () => {
	const home = makeHome();
	const { note } = home.png(join(home.inbound, "m1"), "img_a.png");
	const { log, lines } = captureLog();
	const blocks = await promptImageBlocks(`look at this\n  ${note}  \nthanks`, home.inbound, log, "o1");
	expect(blocks).toEqual([{ type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") }]);
	expect(lines.some((line) => line.includes("event=agy.acp.image_attached") && line.includes("count=1"))).toBe(true);
});

test("notes outside the inbound root, missing, oversized or non-image files, fenced, quoted or inline notes give none", async () => {
	const home = makeHome();
	const { log, lines } = captureLog();
	const blocksFor = (text: string, root = home.inbound) => promptImageBlocks(text, root, log, "o1");

	const briefing = home.png(join(home.media, "briefing"), "brief.png");
	expect(await blocksFor(briefing.note)).toEqual([]);
	const outsideTarget = home.png(home.media, "outside.png");
	const link = join(home.inbound, "m1", "link.png");
	symlinkSync(outsideTarget.path, link);
	expect(await blocksFor(`[첨부: ${link} (image/png)]`)).toEqual([]);
	expect(await blocksFor(`[첨부: ${join(home.inbound, "m1", "gone.png")} (image/png)]`)).toEqual([]);

	const big = join(home.inbound, "m1", "big.png");
	const bigBytes = new Uint8Array(MAX_PROMPT_IMAGE_BYTES + 1);
	bigBytes.set(PNG);
	writeFileSync(big, bigBytes);
	expect(await blocksFor(`[첨부: ${big} (image/png)]`)).toEqual([]);
	const fake = join(home.inbound, "m1", "fake.png");
	writeFileSync(fake, "<html>not an image</html>");
	expect(await blocksFor(`[첨부: ${fake} (image/png)]`)).toEqual([]);

	const real = home.png(join(home.inbound, "m1"), "real.png");
	expect(await blocksFor(`before\n\`\`\`\n${real.note}\n\`\`\`\nafter`)).toEqual([]);
	expect(await blocksFor(`<<<quoted-ab12>>>\n${real.note}\n<<<end-quoted-ab12>>>`)).toEqual([]);
	expect(await blocksFor(`<<<quoted-ab12>>>\nno end marker\n${real.note}`)).toEqual([]);
	expect(await blocksFor(`see ${real.note} here`)).toEqual([]);
	expect(await promptImageBlocks(real.note, undefined, log)).toEqual([]);
	expect(await blocksFor(real.note, join(home.media, "no-such-inbound"))).toEqual([]);

	// The same note outside the fence and the quote is taken.
	expect(await blocksFor(`\`\`\`\nx\n\`\`\`\n<<<quoted-ab12>>>\ny\n<<<end-quoted-ab12>>>\n${real.note}`)).toHaveLength(
		1,
	);
	const reasons = lines
		.filter((line) => line.includes("event=agy.acp.image_skipped"))
		.map((line) => /reason=(\w+)/.exec(line)?.[1]);
	expect(reasons).toEqual(["outside", "outside", "missing", "too_large", "not_image"]);
});

test("five image notes give the first four", async () => {
	const home = makeHome();
	const notes = [1, 2, 3, 4, 5].map((n) => home.png(join(home.inbound, "m1"), `img_${n}.png`).note);
	const { log, lines } = captureLog();
	expect(await promptImageBlocks(notes.join("\n"), home.inbound, log)).toHaveLength(4);
	expect(lines.filter((line) => line.includes("reason=over_limit"))).toHaveLength(1);
});

test("the note saveInboundAttachment writes is read back as one image", async () => {
	const home = makeHome();
	const { log } = captureLog();
	const note = await saveInboundAttachment({
		file: { id: "F1", name: "photo one.png", mimetype: "image/png", url: "https://example.invalid/f1" },
		dir: join(home.inbound, "m2"),
		where: { message: "m2" },
		log,
		download: async ({ destPath }) => {
			mkdirSync(join(home.inbound, "m2"), { recursive: true });
			writeFileSync(destPath, PNG);
		},
	});
	const blocks = await promptImageBlocks(`사진 봐줘\n${note}`, home.inbound, log);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]?.mimeType).toBe("image/png");
});
