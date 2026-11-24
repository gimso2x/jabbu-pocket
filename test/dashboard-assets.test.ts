import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { appAssets, PAGE_CSS } from "../src/dashboard/assets";
import { SCRIPT } from "../src/dashboard/html";
import { startDashboardServer } from "../src/dashboard/server";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";

const KIB = 1024;
const off = { ok: false as const, error: "not in this test" };
const SNAPSHOT: DashboardSnapshot = {
	generatedAt: "2026-11-25T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		// Long enough that the JSON clears the 1 KB gzip floor.
		ompVersion: "v".repeat(3000),
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0, uncertain: 0 },
		monitors: { count: 0, next: null },
		openGates: [],
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
};

const heard: string[] = [];
let base = "";
let stop = (): void => {};
const assets = appAssets(SCRIPT, PAGE_CSS);

beforeAll(() => {
	const server = startDashboardServer({
		port: 0,
		hostname: "127.0.0.1",
		snapshot: async () => SNAPSHOT,
		onRequest: (kind, detail) => heard.push(detail === undefined ? kind : `${kind} view=${detail}`),
	});
	stop = () => server.stop(true);
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => stop());

/** Raw bytes as sent: `Bun.fetch` decodes gzip unless told not to, so ask through `decompress: false`. */
const raw = (path: string, acceptEncoding?: string) =>
	fetch(`${base}${path}`, {
		decompress: false,
		headers: acceptEncoding === undefined ? { "accept-encoding": "identity" } : { "accept-encoding": acceptEncoding },
	});

describe("gzip (AC-1)", () => {
	test("page, script, style and snapshot go out gzip-encoded under their budgets", async () => {
		const budgets: Array<[string, number]> = [
			["/", 20 * KIB],
			[`/${assets.js.name}`, 80 * KIB],
			[`/${assets.css.name}`, 20 * KIB],
			["/api/snapshot", 20 * KIB],
		];
		for (const [path, budget] of budgets) {
			const response = await raw(path, "gzip, deflate");
			expect([path, response.status, response.headers.get("content-encoding")]).toEqual([path, 200, "gzip"]);
			expect(response.headers.get("vary")).toContain("accept-encoding");
			const bytes = new Uint8Array(await response.arrayBuffer());
			expect([path, bytes.byteLength < budget]).toEqual([path, true]);
			expect(gunzipSync(bytes).byteLength).toBeGreaterThan(bytes.byteLength);
		}
	});

	test("without gzip in Accept-Encoding the same bodies come uncompressed", async () => {
		for (const accept of [undefined, "gzip;q=0", "br"]) {
			for (const path of ["/", `/${assets.js.name}`, `/${assets.css.name}`, "/api/snapshot"]) {
				const plain = await raw(path, accept);
				expect([path, accept, plain.headers.get("content-encoding")]).toEqual([path, accept, null]);
				const zipped = await raw(path, "gzip");
				expect(await plain.text()).toBe(gunzipSync(new Uint8Array(await zipped.arrayBuffer())).toString("utf8"));
			}
		}
	});

	test("a body under 1 KB, an event stream and an icon are not compressed", async () => {
		for (const path of ["/healthz", "/manifest.webmanifest", "/icons/icon-192.png", "/api/board/events"]) {
			const response = await raw(path, "gzip");
			expect([path, response.headers.get("content-encoding")]).toEqual([path, null]);
			await response.body?.cancel();
		}
	});
});

describe("script and style assets (AC-2)", () => {
	test("the page has no inline script body or style block, links the hashed assets and allows script-src 'self'", async () => {
		const response = await fetch(`${base}/`);
		const html = await response.text();
		expect(html).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/);
		expect(html).not.toContain("<style");
		expect(html).toContain(`<script src="${assets.js.name}"></script>`);
		expect(html).toContain(`<link rel="stylesheet" href="${assets.css.name}">`);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("style-src 'self' 'unsafe-inline'");
		expect(csp).toContain("img-src 'self' data:");
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
	});

	test("the hashes are content hashes: 12 hex digits, equal to the served bodies' own", async () => {
		expect(assets.js.name).toMatch(/^app-[0-9a-f]{12}\.js$/);
		expect(assets.css.name).toMatch(/^app-[0-9a-f]{12}\.css$/);
		expect(await (await raw(`/${assets.js.name}`)).text()).toBe(SCRIPT);
		expect(await (await raw(`/${assets.css.name}`)).text()).toBe(PAGE_CSS);
	});

	test("the current hash is 200 and immutable; any other hash is 404 — also under a prefix", async () => {
		const wrongJs = `app-${"f".repeat(12)}.js`;
		const wrongCss = `app-${"0".repeat(12)}.css`;
		for (const prefix of ["", "/task"]) {
			for (const asset of [assets.js, assets.css]) {
				const response = await fetch(`${base}${prefix}/${asset.name}`);
				expect([prefix, asset.name, response.status]).toEqual([prefix, asset.name, 200]);
				expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
				expect(response.headers.get("content-type")).toBe(asset.type);
				await response.arrayBuffer();
			}
			for (const name of [wrongJs, wrongCss, "app-short.js", `${assets.js.name}x`]) {
				const response = await fetch(`${base}${prefix}/${name}`);
				expect([prefix, name, response.status]).toEqual([prefix, name, 404]);
				await response.arrayBuffer();
			}
			const page = await fetch(`${base}${prefix}/`);
			expect([prefix, page.status]).toEqual([prefix, 200]);
			await page.arrayBuffer();
		}
	});
});

describe("snapshot usage log (AC-3)", () => {
	test("api/snapshot?view= is heard as snapshot with the view; a hidden tab as snapshot_hidden", async () => {
		heard.length = 0;
		for (const path of [
			"/api/snapshot?view=flow",
			"/api/snapshot?view=turns&hidden=1",
			"/task/api/snapshot",
			"/api/snapshot?view=flow&hidden=0",
		]) {
			await (await fetch(`${base}${path}`)).arrayBuffer();
		}
		expect(heard).toEqual(["snapshot view=flow", "snapshot_hidden view=turns", "snapshot", "snapshot view=flow"]);
	});
});
