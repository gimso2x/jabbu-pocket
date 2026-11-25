import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sniffImageMime } from "../channel/attachments";
import { readWebMessageById } from "../store/web-messages";
import { validateWebAttachmentPath } from "./upload";

function jsonError(status: number, error: string, commonHeaders: Record<string, string>): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { ...commonHeaders, "content-type": "application/json; charset=utf-8" },
	});
}

function safeDownloadName(raw: string): string {
	const cleaned = basename(raw)
		.replace(/[\p{Cc}"\\;\r\n]/gu, "_")
		.trim();
	return cleaned === "" ? "attachment" : cleaned;
}

function contentDisposition(inline: boolean, name: string): string {
	const safe = safeDownloadName(name);
	const ascii = safe.replace(/[^\x20-\x7e]/g, "_") || "attachment";
	const encoded = encodeURIComponent(safe);
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Serves an inbound web attachment strictly from `<botHomeDir>/media/inbound/web` (no arbitrary paths). */
export function serveWebFile(
	botHomeDir: string,
	url: URL,
	head: boolean,
	commonHeaders: Record<string, string>,
): Response {
	const rawMsg = url.searchParams.get("msg") ?? "";
	if (!/^[1-9]\d{0,14}$/.test(rawMsg)) return jsonError(400, "invalid_message_id", commonHeaders);
	const rawIdx = url.searchParams.get("i");
	const idx = rawIdx === null || rawIdx === "" ? 0 : /^\d{1,3}$/.test(rawIdx) ? Number(rawIdx) : -1;
	if (idx < 0) return jsonError(400, "invalid_file_index", commonHeaders);

	const row = readWebMessageById(botHomeDir, Number(rawMsg));
	if (row === undefined || row.filesJson === null) return jsonError(404, "not_found", commonHeaders);

	let entries: Array<{ path?: unknown; name?: unknown; title?: unknown }>;
	try {
		const parsed = JSON.parse(row.filesJson) as unknown;
		if (!Array.isArray(parsed)) return jsonError(404, "not_found", commonHeaders);
		entries = parsed as Array<{ path?: unknown; name?: unknown; title?: unknown }>;
	} catch {
		return jsonError(404, "not_found", commonHeaders);
	}
	const entry = entries[idx];
	if (entry === undefined) return jsonError(404, "not_found", commonHeaders);
	if (typeof entry.path !== "string") return jsonError(403, "forbidden_file_path", commonHeaders);

	const check = validateWebAttachmentPath(entry.path, botHomeDir);
	if (!check.ok) {
		return jsonError(check.error === "file_not_found" ? 404 : 403, check.error, commonHeaders);
	}

	let bytes: Uint8Array;
	try {
		bytes = readFileSync(check.path);
	} catch {
		return jsonError(404, "file_not_found", commonHeaders);
	}
	const sniffed = sniffImageMime(bytes.subarray(0, 12));
	const isImage = sniffed !== undefined;
	const label =
		typeof entry.name === "string" && entry.name.trim() !== ""
			? entry.name
			: typeof entry.title === "string" && entry.title.trim() !== ""
				? entry.title
				: basename(check.path);

	return new Response(head ? null : bytes, {
		status: 200,
		headers: {
			...commonHeaders,
			"cache-control": "private, max-age=300",
			"content-type": sniffed ?? "application/octet-stream",
			"content-disposition": contentDisposition(isImage, label),
			"content-security-policy": "default-src 'none'",
		},
	});
}
