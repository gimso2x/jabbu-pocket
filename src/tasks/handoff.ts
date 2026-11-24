import { redact } from "../redact";

/** Lines of the old worker's screen the brief carries. */
export const HANDOFF_SCREEN_LINES = 80;
/** Characters of PROGRESS.md the brief carries (its tail: the newest steps and decisions). */
const HANDOFF_PROGRESS_CHARS = 6_000;

/**
 * The brief a worker that replaces another (resume on a changed model) gets as part of its first input: what the
 * task was on, the previous worker's last screen and where the documents are. `progress` and `screen` are
 * `undefined` when they could not be read; the brief says so instead of leaving a gap.
 */
export function buildHandoffBrief(input: {
	from: string;
	to: string;
	specPath: string;
	progress: string | undefined;
	screen: string | undefined;
}): string {
	const tail = (text: string, max: number): string => (text.length > max ? `…${text.slice(-max)}` : text);
	const screen =
		input.screen === undefined ? undefined : input.screen.split("\n").slice(-HANDOFF_SCREEN_LINES).join("\n").trim();
	return [
		`인계: 이 작업은 ${input.from} 워커가 하던 것을 ${input.to} 워커로 바꿔 이어 받는다. 아래는 이전 워커가 남긴 것이다 — 사실 확인은 문서와 저장소로 한다.`,
		`spec 경로: ${input.specPath}`,
		"[마지막 PROGRESS.md]",
		input.progress === undefined || input.progress.trim() === ""
			? "(읽지 못함 또는 비어 있음)"
			: tail(redact(input.progress), HANDOFF_PROGRESS_CHARS),
		`[이전 워커 화면 마지막 ${HANDOFF_SCREEN_LINES}줄]`,
		screen === undefined || screen === "" ? "(없음: 이전 워커가 살아 있지 않았거나 읽지 못함)" : redact(screen),
	].join("\n");
}
