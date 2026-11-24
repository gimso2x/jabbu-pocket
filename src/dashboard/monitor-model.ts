import type { MonitorInfo } from "./snapshot";

type ModelOf = Pick<MonitorInfo, "deliver" | "model" | "thinking">;

/** The detail page's model cell (plain text, not escaped yet). A verbatim monitor posts without a turn, so no model runs. */
export const monitorModelDetail = (monitor: ModelOf): string =>
	monitor.deliver === "verbatim"
		? "쓰지 않음 · 턴 없이 스크립트 출력을 그대로 보냄"
		: `${monitor.model ?? "기본 모델"}${monitor.thinking === null ? "" : ` · thinking ${monitor.thinking}`}`;
