// The short title the approvals view shows for an approval summary.

const APPROVAL_TITLE_CHARS = 80;

/** `formText`'s header line (src/safety/form-choice.ts) when the form has no intro: every such card starts with it. */
const FORM_HEADER = /^❓ 항목 (\d+)개 — 답하지 않은 첫 항목부터 답장이 채워집니다$/;

/** `text` cut to `max` characters with `…`, never inside a surrogate pair. */
function cutTitle(text: string, max: number): string {
	if (text.length <= max) return text;
	const last = text.charCodeAt(max - 2);
	const cut = last >= 0xd800 && last <= 0xdbff ? max - 2 : max - 1;
	return `${text.slice(0, cut)}…`;
}

/**
 * The title of an `ask` form card without an intro: its first question (`*N. question*`, a `(필수)` mark dropped),
 * with ` 외 N개` for more. Null for any other summary (a form with an intro keeps the intro as its first line) and for
 * a form whose first block is not a question line, so the generic first-line title stays the fallback.
 */
function formQuestionTitle(summary: string): string | null {
	const [first, ...rest] = summary.split("\n");
	const header = FORM_HEADER.exec(first?.trim() ?? "");
	if (header === null) return null;
	const block = rest.find((line) => line.trim() !== "");
	const question = /^\*\d+\. (.+?)(?: \(필수\))?\*$/.exec(block?.trim() ?? "")?.[1]?.trim();
	if (question === undefined || question === "") return null;
	const more = Number(header[1]) - 1;
	const suffix = more > 0 ? ` 외 ${more}개` : "";
	return `${cutTitle(question, APPROVAL_TITLE_CHARS - suffix.length)}${suffix}`;
}

/** First sentence (`.`/`!`/`?` before a space, or `。`) of the first line, cut to 80 characters with `…`. */
export function approvalTitle(summary: string): string {
	const form = formQuestionTitle(summary);
	if (form !== null) return form;
	const line = summary.split("\n")[0]?.trim() ?? "";
	const sentence = (/^.*?(?:[.!?](?=\s)|。)/.exec(line)?.[0] ?? line).trim();
	return cutTitle(sentence === "" ? summary.trim() : sentence, APPROVAL_TITLE_CHARS);
}
