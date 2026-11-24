import type { ActionButton } from "../channel/port";
import { THINKING_LEVELS } from "../monitors/spec";
import type { TaskCheck } from "../tasks/checker";
import { laneCostLine, lanePauseActionId, laneResumeActionId } from "./card";
import type { LaneRow } from "./status";

export const pauseButton = (name: string): ActionButton => ({
	actionId: lanePauseActionId(name),
	label: "⏸ 멈춤",
	value: name,
});

export const resumeButton = (name: string): ActionButton => ({
	actionId: laneResumeActionId(name),
	label: "▶ 재개",
	value: name,
	style: "primary",
});

export function failedChecksOf(lane: LaneRow): TaskCheck[] {
	const checks = lane.meta.checks;
	if (checks === undefined || checks.head === "") return [];
	return checks.results.filter((result) => !result.ok && !result.inconclusive);
}

/** One owner line in the lane's thread for a terminal hand-back; the cost is the terminal's own (outside the lane cap). */
export function detachSummary(
	turns: number,
	changed: number | undefined,
	costUsd: number,
	orphan: boolean,
	cost?: { usd: number; calls: number } | undefined,
): string {
	const files = changed === undefined ? "바뀐 파일 수 확인 못 함" : `바뀐 파일 ${changed}개`;
	const by = orphan ? " (attach 프로세스가 끝나 코어가 되찾음)" : "";
	const base = `🖥 터미널 omp에서 레인을 돌려받았습니다${by} — TUI에서 ${turns}턴, ${files}, TUI 비용 $${costUsd.toFixed(2)}`;
	return cost === undefined ? base : `${base}\n${laneCostLine(cost)}`;
}

/**
 * A `lanes.models` value as origin settings: a trailing `:<thinking level>` is the thinking level, not part of the model id
 * (the RPC model list holds bare `provider/id`s); any other colon stays in the id. Null: no model configured.
 */
export function splitModelThinking(value: string | null): { model: string; thinking?: string } | undefined {
	if (value === null) return undefined;
	const cut = value.lastIndexOf(":");
	const level = value.slice(cut + 1);
	return cut > 0 && (THINKING_LEVELS as readonly string[]).includes(level)
		? { model: value.slice(0, cut), thinking: level }
		: { model: value };
}

export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9가-힣]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug === "" ? "lane" : slug;
}
