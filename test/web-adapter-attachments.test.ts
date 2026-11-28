import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryItem, DeliverySource } from "../src/channel/types";
import { createLogger } from "../src/log";
import { promptImageBlocks } from "../src/omp/agy-images";
import { openStore, type Store } from "../src/store/db";
import { WebAdapter } from "../src/web/adapter";
import { WebChannel } from "../src/web/channel";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-web-adapter-attach-"));
	dirs.push(dir);
	const clock = {
		t: 1_700_000_000_000,
		now() {
			return this.t;
		},
	};
	const store = openStore({ path: join(dir, "jabbu.db"), timezone: "Asia/Seoul", clock, redact: (t: string) => t });
	stores.push(store);
	const channel = new WebChannel();
	channel.attach(store.web);
	const queue: DeliveryItem[] = [];
	const deliveries: DeliverySource = {
		claimDue: () => queue.splice(0),
		confirm: () => undefined,
		fail: () => undefined,
		defer: () => undefined,
	};
	const inboundTexts: string[] = [];
	const adapter = new WebAdapter({
		channel,
		webStore: store.web,
		core: {
			onInbound: async (inbound: { text?: string }) => {
				inboundTexts.push(inbound.text ?? "");
				return {};
			},
		} as never,
		deliveries,
		clock,
		log: createLogger({ sink: () => undefined, clock, redact: (t: string) => t }),
	});
	return { dir, adapter, inboundTexts };
}

describe("web: attachment notes", () => {
	test("an uploaded image's note carries its mimetype, so the model gets it as an image block", async () => {
		const { dir, adapter, inboundTexts } = setup();
		const inboundRoot = join(dir, "media", "inbound");
		mkdirSync(join(inboundRoot, "web"), { recursive: true });
		const image = join(inboundRoot, "web", "img_0123456789ab_abcdef.png");
		writeFileSync(image, Buffer.concat([PNG_HEAD, Buffer.from("pixels")]));

		const sent = await adapter.sendFromWeb({ conversation: "w_aaaaaaaa", text: "이거 봐줘", files: [image] });
		expect(sent.ok).toBe(true);
		expect(inboundTexts).toHaveLength(1);
		expect(inboundTexts[0]).toBe(`이거 봐줘\n[첨부: ${image} (image/png)]`);

		// The note the adapter writes is the shape `promptImageBlocks` reads: the image reaches the model.
		const blocks = await promptImageBlocks(inboundTexts[0] ?? "", inboundRoot);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.mimeType).toBe("image/png");
	});

	test("a non-image file keeps the plain note without a mimetype", async () => {
		const { dir, adapter, inboundTexts } = setup();
		const doc = join(dir, "report.pdf");
		writeFileSync(doc, Buffer.from("%PDF-1.4 fake"));
		const sent = await adapter.sendFromWeb({ conversation: "w_aaaaaaaa", text: "읽어줘", files: [doc] });
		expect(sent.ok).toBe(true);
		expect(inboundTexts[0]).toBe(`읽어줘\n[첨부: ${doc}]`);
	});
});
