import type { LaneInfo } from "./work-types";

/** Whether an origin (optionally `<peer>:`-prefixed) is an inline channel main session (`discord/ch/<C>` or `slack/ch/<C>`). */
export function isChannelMainOrigin(key: string): boolean {
	return /^(?:[^/:]+:)?(?:discord|slack)\/ch\/[^/]+$/.test(key);
}

/** Whether an origin (optionally `<peer>:`-prefixed) is a work lane (`jabbu/work/<name>`). */
export function isLaneOriginKey(key: string): boolean {
	return /^(?:[^/:]+:)?jabbu\/work\//.test(key);
}

/** Owner-facing badge `[word, tone]` for a closed lane's active landing state. */
export function laneLandBadge(landState: string | undefined): [string, string] | undefined {
	if (landState === "pending") return ["머지 대기", "is-warning"];
	if (landState === "pr-open") return ["PR 열림", "is-info"];
	if (landState === "blocked") return ["착지 막힘", "is-warning"];
	if (landState === "merged-not-pushed") return ["푸시 안 됨", "is-warning"];
	return undefined;
}

/** Effective 3-column placement (`attention` / `working` / `done`) for a lane or lane-backed thread. */
export function effectiveLaneColumn(
	lane: Pick<LaneInfo, "status" | "uncertainCount" | "landState">,
	base?: "attention" | "working" | "done",
): "attention" | "working" | "done" {
	if (
		base === "attention" ||
		lane.uncertainCount > 0 ||
		lane.status === "paused" ||
		lane.status === "not-done" ||
		lane.landState === "pending" ||
		lane.landState === "blocked" ||
		lane.landState === "merged-not-pushed"
	) {
		return "attention";
	}
	if (
		base === "working" ||
		lane.status === "working" ||
		lane.status === "done-claimed" ||
		lane.landState === "pr-open"
	) {
		return "working";
	}
	return base ?? "done";
}

/** Display title of a channel main session: `<peer> · #채널` or `#채널` (falls back to `thread.title` when unnamed). */
export function channelDisplayTitle(
	thread: { originKey: string; title: string; install?: string },
	channelNames?: Record<string, string>,
): string {
	const m = /^(?:[^/:]+:)?(?:slack|discord)\/ch\/([^/]+)$/.exec(thread.originKey);
	const chId = m?.[1] ?? "";
	const named = chId !== "" ? channelNames?.[chId] : undefined;
	if (named === undefined) return thread.title;
	return thread.install ? `${thread.install} · ${named}` : named;
}
