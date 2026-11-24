// The reload field classification (which `config.json` keys the running daemon re-reads, which are boot-bound, which
// only the CLI reads) — `./reload` re-exports and judges with these; moved out to keep it within the size ratchet.

import type { OmpbotConfig } from "../config";

/** Read by the running daemon on every use (after reload: the next inbound, card, answer, omp child or sweep). */
export const LIVE_FIELDS = [
	"skillReviewTurns",
	"ownerSilenceFallbackMinutes",
	"dispatchHosts",
	"recordsRepo",
	"workerOmpArgs",
	// Each new [TASK] and each agy resume reads it (`DispatchToolDeps.workerAgy`).
	"workerAgy",
	"herdrBoard",
	"taskAutoLand",
	"restartNotice",
	"recallEnabled",
	"peerHopLimit",
	// The peer silence sweep and the call recording read it after every reload.
	"peerSilenceAlert",
	"turnSnapshot",
	// Every note write reads it, so an added or removed block turns the notes on or off.
	"wikiNotes",
	"costCap",
	// The lane manager reads `lanes.models` at every lane start.
	"lanes",
	// The briefing renderer reads it on every `!brief` (a moved chromium applies without a restart).
	"briefing",
	// The candidate pass reads it on every sweep.
	"candidates",
	// `!brief` reads `dashboard.opsStatus` for its host-check card on every call; the `ompbot dashboard` service still
	// reads port/bind/herdrWebUrl only when it starts (`systemctl --user restart ompbot-dashboard`).
	"dashboard",
] as const satisfies ReadonlyArray<keyof OmpbotConfig>;

/** Bound when the daemon starts (tokens, socket, omp children, scheduler). */
export const RESTART_FIELDS = [
	// The owner of each platform: the adapters and the approval broker take it when they start.
	"channels",
	"ompExecutable",
	"ompProfile",
	// The file's path; its contents are read by each new omp child, so editing the file needs no restart.
	"ompConfigOverlay",
	"workspaceDir",
	// Day keys, prompts and monitor tool descriptions take it when the daemon starts.
	"timezone",
	"agent",
	"agyExecutable",
	"model",
	"thinking",
	"idleTimeoutMinutes",
	// Read when the daemon builds the router, like the idle time itself.
	"idleKeepResident",
	// The lane manager and the [TASK] tool deps take the ceiling when the daemon starts.
	"hostSessionCeiling",
	"watcherRoots",
	// The daemon reads it only to decide whether the `offsite_age` gate exists; the CLI re-reads it on every run.
	"offsite",
	"webhook",
	// The dispatch tool schema and the [TASK] sweeper are decided when the daemon starts.
	"herdr",
] as const satisfies ReadonlyArray<keyof OmpbotConfig>;

/**
 * Read by the CLI levers on every run (`ompbot gc` / `ompbot backup` load config.json themselves, `ompbot apply`
 * reads `apply`), so a change needs no daemon action. The daemon reads only `maxBundleBytes`, once, for its first-boot
 * backup (`#bootBackup`); a changed value reaches that backup after a restart.
 */
export const CLI_FIELDS = ["sessionRetentionDays", "maxBundleBytes", "apply"] as const satisfies ReadonlyArray<
	keyof OmpbotConfig
>;
