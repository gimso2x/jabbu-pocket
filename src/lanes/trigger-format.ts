import { statSync } from "node:fs";
import { LaneInputError } from "./manager-constants";

/** Refusal for a `작업:` first line that aimed at `@<절대경로>` with `~` or a relative path (`./`, `../`). */
const LANE_TRIGGER_FORMAT_TEXT =
	"레인으로 열지 못했습니다 — 형식은 `작업: <제목> @<절대경로>`입니다 (상대경로·`~`는 쓸 수 없습니다).";

const MALFORMED_PATH_TRIGGER = /^작업:[ \t]+\S.*[ \t]+@(?:~|\.\.?\/)/;

/**
 * Detects a `작업:` message whose first line tried a `~` or relative (`./`, `../`) path after `@`.
 * Mentions (`<@…>`, `@이름`), emails (`a@b`), scoped packages (`@types/bun`), and `@` on later lines return undefined.
 */
export function laneTriggerRefusal(text: string): string | undefined {
	const firstLine = text.trim().split("\n", 1)[0] ?? "";
	return MALFORMED_PATH_TRIGGER.test(firstLine) ? LANE_TRIGGER_FORMAT_TEXT : undefined;
}

const SPACED_PATH_WORDS = 8;

const isDirectoryOnDisk = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * A path with a space ends at the space, so `작업: 제목 @/a/my proj` reads as `/a/my` plus a brief. When `<경로> <첫 줄의 앞 단어들>`
 * is itself a directory, the owner meant that one and a lane at the shorter path would run in another repository:
 * the refusal says so. `undefined` when no such directory exists (the usual brief).
 */
export function spacedPathRefusal(
	cwd: string,
	brief: string,
	isDirectory: (path: string) => boolean = isDirectoryOnDisk,
): string | undefined {
	const words = (brief.split("\n", 1)[0] ?? "").split(/[ \t]+/).filter((word) => word !== "");
	for (let count = 1; count <= Math.min(words.length, SPACED_PATH_WORDS); count += 1) {
		const longer = `${cwd} ${words.slice(0, count).join(" ")}`;
		if (isDirectory(longer))
			return `레인을 시작하지 않았습니다: 경로는 첫 공백에서 끝나서 \`${cwd}\`로 읽혔지만 \`${longer}\`도 있는 디렉터리입니다. 공백이 있는 경로는 쓸 수 없으니 공백 없는 경로(심볼릭 링크 등)로 다시 보내 주세요.`;
	}
	return undefined;
}

/** Throws the refusal as a `LaneInputError` (the daemon answers it in the lane's channel). */
export function assertNoSpacedPath(cwd: string, brief: string): void {
	const refusal = spacedPathRefusal(cwd, brief);
	if (refusal !== undefined) throw new LaneInputError(refusal);
}
