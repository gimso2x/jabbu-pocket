/** Refusal for a `작업:` first line that aimed at `@<절대경로>` with `~` or a relative path (`./`, `../`). */
const LANE_TRIGGER_FORMAT_TEXT =
	"레인으로 열지 못했습니다 — 형식은 `작업: <제목> @<절대경로>`입니다 (상대경로·`~`는 쓸 수 없습니다).";

const MALFORMED_PATH_TRIGGER = /^작업:[ \t]*\S.*[ \t]+@(?:~|\.\.?\/)/;

/**
 * Detects a `작업:` message whose first line tried a `~` or relative (`./`, `../`) path after `@`.
 * Mentions (`<@…>`, `@이름`), emails (`a@b`), scoped packages (`@types/bun`), and `@` on later lines return undefined.
 */
export function laneTriggerRefusal(text: string): string | undefined {
	const firstLine = text.trim().split("\n", 1)[0] ?? "";
	return MALFORMED_PATH_TRIGGER.test(firstLine) ? LANE_TRIGGER_FORMAT_TEXT : undefined;
}
