import { cutCodePointSafe } from "../channel/text";
import type { DeliveryRow } from "../store/db-rows";

/** Longest preview of a held body in the list; a longer one is cut and marked with `...`. */
const PREVIEW_CHARS = 60;
/** Fields of one list line are separated by two spaces (ids and thread refs have none, so a cut on it is unambiguous). */
const FIELD_SEP = "  ";

/** A held body's first {@link PREVIEW_CHARS} characters, JSON-escaped so quotes and control characters stay on one line. */
export function heldPreview(body: string): string {
	const cut = cutCodePointSafe(body, PREVIEW_CHARS);
	return `${JSON.stringify(cut)}${body.length > PREVIEW_CHARS ? "..." : ""}`;
}

/** One line per held row: id, origin, thread, created time, preview. */
export function heldLine(row: DeliveryRow): string {
	return [
		String(row.deliveryId),
		row.originKey,
		row.threadRef,
		new Date(row.createdAt).toISOString(),
		heldPreview(row.body),
	].join(FIELD_SEP);
}
