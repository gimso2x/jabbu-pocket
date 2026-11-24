import { escapeMrkdwn } from "../channel/text";
import type { LaneChanges, LaneRow } from "./status";

/** What a `land: "pr"` merge does, as the cards say it. */
export const PR_MERGE_STEPS = "누출 검사 → PR → CI → squash 머지 → 로컬 ff";

/** The `pr-open` card's lines: the PR, where its CI stands, and what happens next (no button: the core goes on alone). */
export function prOpenLines(lane: LaneRow): string[] {
	const prLand = lane.meta.land?.prLand;
	const ci = { success: "초록", failure: "빨강", pending: "도는 중", none: "아직 시작 안 함" }[
		prLand?.ci?.verdict ?? "none"
	];
	return [
		`PR: ${escapeMrkdwn(prLand?.url ?? "?")} · 브랜치 \`${prLand?.branch ?? lane.meta.branch ?? "?"}\``,
		`CI: ${ci}${prLand?.bounces === undefined ? "" : ` · 반송 ${prLand.bounces}회`}`,
		"CI 초록이면 코어가 squash 머지합니다. 빨강이면 레인이 같은 브랜치를 고칩니다.",
	];
}

/** `변경: path (+x −y), …` with the most changed files; none when the diff failed or changed only binaries. */
export function topLine(changes: LaneChanges): string[] {
	if (changes.error !== undefined || changes.top.length === 0) return [];
	const listed = changes.top.map((entry) => `${entry.path} (+${entry.added} −${entry.deleted})`).join(", ");
	const rest = changes.files - changes.top.length;
	return [`변경: ${listed}${rest > 0 ? ` 외 ${rest}개` : ""}`];
}

/** `⚠️ 겹침: …` naming other lanes and the base branch that changed the same files; none when nothing overlaps. */
export function overlapLine(changes: LaneChanges): string[] {
	const parts = [
		...changes.overlaps.map((overlap) => `레인 \`${overlap.lane}\` — ${overlap.files.join(", ")}`),
		...(changes.baseDrift.length === 0 ? [] : [`base가 그새 바꾼 파일 — ${changes.baseDrift.join(", ")}`]),
	];
	if (parts.length > 0) {
		return [`⚠️ 겹침: ${parts.join(" · ")}${changes.overlapError === undefined ? "" : " (일부 확인 실패)"}`];
	}
	return changes.overlapError === undefined ? [] : ["⚠️ 겹침: 일부 확인 실패"];
}
