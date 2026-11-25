import { STYLE } from "./style";
import { TASK_WORK_STYLE } from "./task-work-client";

/** The page's stylesheet: the shared style plus the card-link rules only the page uses. */
export const PAGE_CSS = `${STYLE}${TASK_WORK_STYLE}.card-thread{position:relative}.card-link{display:flex;flex-direction:column;gap:var(--sp-1);min-width:0}.card-link::after{content:"";position:absolute;inset:0;border-radius:var(--r-m)}.card-job{position:relative;z-index:1}.card-job:hover{text-decoration:underline}`;

/** Web app manifest for "install as app" in Chrome/Edge; URLs are relative so any tunnel prefix keeps working. */
export const WEB_MANIFEST = JSON.stringify({
	id: "./",
	name: "jabbu 현황판",
	short_name: "jabbu",
	start_url: "./",
	scope: "./",
	display: "standalone",
	background_color: "#0D0F12",
	theme_color: "#15181D",
	lang: "ko",
	icons: [
		{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		{ src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
	],
});

/** A response under this size goes out as it is: gzip would save nothing worth the CPU. */
const MIN_GZIP_BYTES = 1024;
const COMPRESSIBLE = /^(?:application\/(?:json|javascript)|text\/(?:html|css|javascript))\b/;
const ASSET = /^\/(?:.*\/)?app-([0-9a-f]{12})\.(js|css)$/;

interface Asset {
	body: string;
	gzip: Uint8Array<ArrayBuffer>;
	/** File name relative to the page, e.g. `app-0123456789ab.js`. */
	name: string;
	type: string;
}
export interface AppAssets {
	js: Asset;
	css: Asset;
}

let built: { script: string; css: string; assets: AppAssets } | undefined;

const asset = (body: string, ext: "js" | "css", type: string): Asset => {
	const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 12);
	return { body, gzip: Bun.gzipSync(body, { level: 9 }), name: `app-${hash}.${ext}`, type };
};

/** The script and stylesheet as content-hashed assets; built once per content (at the first page of a server's life). */
export function appAssets(script: string, css: string): AppAssets {
	if (built?.script !== script || built.css !== css) {
		built = {
			script,
			css,
			assets: {
				js: asset(script, "js", "text/javascript; charset=utf-8"),
				css: asset(css, "css", "text/css; charset=utf-8"),
			},
		};
	}
	return built.assets;
}

export const acceptsGzip = (request: Request): boolean =>
	/(?:^|[\s,])gzip\s*(?:;\s*q=(?!0(?:\.0{0,3})?\s*(?:,|$))[0-9.]+)?\s*(?:,|$)/i.test(
		request.headers.get("accept-encoding") ?? "",
	);

/**
 * `app-<hash>.js` / `.css`: 200 with an immutable cache only when the hash is exactly the current one, else 404.
 * Undefined when the path is not an asset path at all.
 */
export function serveAsset(
	request: Request,
	pathname: string,
	assets: AppAssets,
	headers: Record<string, string>,
): Response | undefined {
	const match = ASSET.exec(pathname);
	if (match === null) return undefined;
	const found = match[2] === "js" ? assets.js : assets.css;
	if (found.name !== pathname.slice(pathname.lastIndexOf("/") + 1)) {
		return new Response("not found\n", {
			status: 404,
			headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
		});
	}
	const gzip = acceptsGzip(request);
	return new Response(request.method === "HEAD" ? null : gzip ? found.gzip : found.body, {
		headers: {
			...headers,
			"content-type": found.type,
			"cache-control": "public, max-age=31536000, immutable",
			vary: "accept-encoding",
			...(gzip ? { "content-encoding": "gzip" } : {}),
		},
	});
}

/**
 * Gzips a text answer (page, JSON, script, style) when the client accepts it. Streams, images, HEAD, empty and
 * already-encoded answers and anything under 1 KB pass untouched.
 */
export async function withGzip(request: Request, response: Response): Promise<Response> {
	const type = response.headers.get("content-type") ?? "";
	if (request.method === "HEAD" || response.body === null || response.headers.has("content-encoding")) return response;
	if (!COMPRESSIBLE.test(type) || !acceptsGzip(request)) return response;
	const body = new Uint8Array(await response.arrayBuffer());
	const headers = new Headers(response.headers);
	headers.set("vary", "accept-encoding");
	headers.delete("content-length");
	if (body.byteLength < MIN_GZIP_BYTES) return new Response(body, { status: response.status, headers });
	headers.set("content-encoding", "gzip");
	return new Response(Bun.gzipSync(body, { level: 6 }), { status: response.status, headers });
}
