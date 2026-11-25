import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { WebChannel } from "../src/web/channel";
import { serveWebFile } from "../src/web/file-serve";
import { webUploadRoot } from "../src/web/upload";

const CONVERSATION = "w_abcd1234efgh";
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

let home = "";
let work = "";
let store: Store;
let channel: WebChannel;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-botfile-home-"));
	work = mkdtempSync(join(tmpdir(), "jabbu-web-botfile-work-"));
	chmodSync(home, 0o700);
	store = openStore({ path: join(home, "jabbu.db"), timezone: "Asia/Seoul", clock: { now: () => 1_000 }, redact });
	channel = new WebChannel();
	channel.attach(store.web, home);
});

afterEach(() => {
	store.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
});

async function serve(messageId: string): Promise<Response> {
	return serveWebFile(home, new URL(`http://x/api/web/file?msg=${messageId}&i=0`), false, {});
}

describe("a file the bot sends into the web chat can be downloaded from it", () => {
	test("a text file from the workspace is served as an attachment under its own name", async () => {
		const source = join(work, "report.txt");
		writeFileSync(source, "분기 보고서\n");
		const { fileId } = await channel.uploadFile({ conversationId: CONVERSATION }, { path: source, title: "보고서" });

		const res = await serve(fileId);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("분기 보고서\n");
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect(res.headers.get("content-type")).toBe("application/octet-stream");

		const row = store.web.get(Number(fileId));
		const entry = (JSON.parse(row?.filesJson ?? "[]") as Array<{ path: string; name?: string; title?: string }>)[0];
		expect(entry?.name).toBe("report.txt");
		expect(entry?.title).toBe("보고서");
		expect(entry?.path.startsWith(webUploadRoot(home))).toBe(true);
	});

	test("an image is served inline with its sniffed type and survives the source file being deleted", async () => {
		const source = join(work, "chart.png");
		writeFileSync(source, Buffer.concat([PNG_HEAD, Buffer.from("rest")]));
		const { fileId } = await channel.uploadFile({ conversationId: CONVERSATION }, { path: source });
		rmSync(source);

		const res = await serve(fileId);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toContain("inline");
		expect(res.headers.get("content-disposition")).toContain("chart.png");
	});

	test("the copy lives under the upload root with owner-only mode", async () => {
		const source = join(work, "a.txt");
		writeFileSync(source, "x");
		await channel.uploadFile({ conversationId: CONVERSATION }, { path: source });
		const names = readdirSync(webUploadRoot(home));
		expect(names.length).toBe(1);
		expect(names[0]).toMatch(/^doc_[0-9a-f]{12}_[0-9a-f]{6}\.txt$/);
		expect(lstatSync(join(webUploadRoot(home), names[0] ?? "")).mode & 0o777).toBe(0o600);
	});

	test("a file that cannot be copied keeps the original path and the message still posts", async () => {
		const missing = join(work, "gone.txt");
		const { fileId } = await channel.uploadFile({ conversationId: CONVERSATION }, { path: missing, comment: "c" });
		const row = store.web.get(Number(fileId));
		expect(row?.text).toBe("c");
		expect((JSON.parse(row?.filesJson ?? "[]") as Array<{ path: string }>)[0]?.path).toBe(missing);
		expect((await serve(fileId)).status).toBe(404);
	});

	test("a symlinked upload root is not written through", async () => {
		const elsewhere = join(work, "elsewhere");
		mkdirSync(elsewhere);
		mkdirSync(join(home, "media", "inbound"), { recursive: true });
		symlinkSync(elsewhere, webUploadRoot(home));
		const source = join(work, "a.txt");
		writeFileSync(source, "x");
		const { fileId } = await channel.uploadFile({ conversationId: CONVERSATION }, { path: source });
		expect(readdirSync(elsewhere)).toEqual([]);
		expect((await serve(fileId)).status).toBe(403);
		expect(readFileSync(source, "utf8")).toBe("x");
	});

	test("a channel attached without a home keeps the old behavior (path stored as given)", async () => {
		const bare = new WebChannel();
		bare.attach(store.web);
		const source = join(work, "a.txt");
		writeFileSync(source, "x");
		const { fileId } = await bare.uploadFile({ conversationId: CONVERSATION }, { path: source });
		const row = store.web.get(Number(fileId));
		expect((JSON.parse(row?.filesJson ?? "[]") as Array<{ path: string }>)[0]?.path).toBe(source);
	});
});
