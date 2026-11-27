import { sendFileToolName } from "../safety/prompt";

/** Host tools the daemon refuses while onboarding runs (read-only): posting, starting work, registering monitors, uploads. */
export const ONBOARDING_DENIED_TOOLS: ReadonlySet<string> = new Set([
	"jabbu_dispatch",
	"jabbu_work_start",
	"jabbu_board_post",
	"jabbu_monitor_add",
	"jabbu_monitor_remove",
	sendFileToolName("discord"),
	sendFileToolName("web"),
]);
