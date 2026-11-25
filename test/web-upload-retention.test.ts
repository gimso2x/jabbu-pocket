import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEDIA_MAX_AGE_MS, pruneMediaFiles } from "../src/ops/media";
import { pruneWebUploads, sweepMedia } from "../src/ops/media-prune";
import { redact } from "../src/redact";
import { openStore, type Store } from "../src/store/db";
import { serveWebFile } from "../src/web/file-serve";
import { saveWebUpload, webUploadRoot } from "../src/web/upload";

const NOW = 1_800_000_000_000;
const OLD = (NOW - MEDIA_MAX_AGE_MS - 60_000) / 1000;
const FRESH = (NOW - 60_000) / 1000;

let home = "";
let store: Store;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jabbu-web-retention-"));
	store = openStore({ path: join(home, "jabbu.db"), timezone: "Asia/Seoul", clock: { now: () => NOW }, redact });
});

afterEach(() => {
	store.close();
	rmSync(home, { recursive: true, force: true });
});

function put(dir: string, name: string, mtimeSec: number): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "x");
	utimesSync(path, mtimeSec, mtimeSec);
	return path;
}

describe("web uploads live as long as the chat message that shows them", () => {
	test("the 24h media sweep leaves media/inbound/web alone and still prunes the other inbound files", () => {
		const media = join(home, "media");
		const web = put(webUploadRoot(home), "img_aaaaaaaaaaaa_bbbbbb.png", OLD);
		const discord = put(join(media, "inbound", "1700000000"), "a.png", OLD);
		const briefing = put(join(media, "briefing"), "b.png", OLD);
		expect(pruneMediaFiles(media, NOW)).toBe(2);
		expect(existsSync(web)).toBe(true);
		expect(existsSync(discord)).toBe(false);
		expect(existsSync(briefing)).toBe(false);
	});

	test("an uploaded file is still served 25 hours later when its message row is kept", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2]);
		const upload = await saveWebUpload(
			new Request("http://x/api/web/upload", {
				method: "POST",
				headers: { "content-type": "image/png", "x-filename": "a.png" },
				body: png,
			}),
			home,
		);
		if (!upload.ok) throw new Error(upload.error);
		utimesSync(upload.path, OLD, OLD);
		const row = store.web.insert({
			conversation: "w_abcd1234efgh",
			role: "owner",
			text: "(첨부 파일)",
			filesJson: JSON.stringify([{ path: upload.path, name: "a.png" }]),
		});
		pruneMediaFiles(join(home, "media"), NOW);
		pruneWebUploads(join(home, "media"), store.web.referencedFileNames(), NOW);
		const res = serveWebFile(home, new URL(`http://x/api/web/file?msg=${row.id}&i=0`), false, {});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
	});

	test("a file no message row names goes after 24h, a referenced one and a fresh one stay", () => {
		const root = webUploadRoot(home);
		const kept = put(root, "doc_111111111111_aaaaaa.txt", OLD);
		const orphanOld = put(root, "doc_222222222222_bbbbbb.txt", OLD);
		const orphanFresh = put(root, "doc_333333333333_cccccc.txt", FRESH);
		const staleTmp = put(root, ".tmp-0123456789abcdef", OLD);
		store.web.insert({
			conversation: "w_abcd1234efgh",
			role: "assistant",
			text: "t",
			filesJson: JSON.stringify([{ path: kept }]),
		});
		const removed = pruneWebUploads(join(home, "media"), store.web.referencedFileNames(), NOW);
		expect(removed).toBe(2);
		expect(existsSync(kept)).toBe(true);
		expect(existsSync(orphanFresh)).toBe(true);
		expect(existsSync(orphanOld)).toBe(false);
		expect(existsSync(staleTmp)).toBe(false);
	});

	test("the hourly sweep ends up keeping what a message shows, dropping the rest, and leaving the web dir alone without a ledger", () => {
		const root = webUploadRoot(home);
		const kept = put(root, "doc_111111111111_aaaaaa.txt", OLD);
		const orphan = put(root, "doc_222222222222_bbbbbb.txt", OLD);
		const discord = put(join(home, "media", "inbound", "1700000000"), "a.png", OLD);
		store.web.insert({
			conversation: "w_abcd1234efgh",
			role: "owner",
			text: "t",
			filesJson: JSON.stringify([{ path: kept }]),
		});
		expect(sweepMedia(join(home, "media"), NOW, undefined)).toBe(1);
		expect(existsSync(orphan)).toBe(true);
		expect(existsSync(discord)).toBe(false);
		put(join(home, "media", "inbound", "1700000001"), "b.png", OLD);
		expect(sweepMedia(join(home, "media"), NOW, store.web)).toBe(2);
		expect(existsSync(kept)).toBe(true);
		expect(existsSync(orphan)).toBe(false);
	});

	test("rows that carry no or malformed files_json do not break the reference scan", () => {
		store.web.insert({ conversation: "w_abcd1234efgh", role: "owner", text: "a" });
		store.web.insert({ conversation: "w_abcd1234efgh", role: "owner", text: "b", filesJson: "not json" });
		store.web.insert({
			conversation: "w_abcd1234efgh",
			role: "owner",
			text: "c",
			filesJson: '[{"name":"x"},null,{"path":5},{"path":"/a/b/doc_4.txt"}]',
		});
		expect([...store.web.referencedFileNames()]).toEqual(["doc_4.txt"]);
	});

	test("a missing upload root, and a symlinked one that points elsewhere, are left alone", () => {
		expect(pruneWebUploads(join(home, "media"), new Set(), NOW)).toBe(0);
		const elsewhere = mkdtempSync(join(tmpdir(), "jabbu-web-retention-elsewhere-"));
		try {
			const outside = put(elsewhere, "doc_555555555555_dddddd.txt", OLD);
			mkdirSync(join(home, "media", "inbound"), { recursive: true });
			symlinkSync(elsewhere, webUploadRoot(home));
			expect(pruneWebUploads(join(home, "media"), new Set(), NOW)).toBe(0);
			expect(existsSync(outside)).toBe(true);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});
