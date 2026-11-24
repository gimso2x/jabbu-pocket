import type { LaneReservation, ReservationState } from "../lanes/reservations";
import type { LaneHistoryEntry, LaneMeta, LaneRow, LaneStatus } from "../lanes/status";
import type { DeliveryState, InboundState, UncertainReason } from "./transitions";

export interface OriginRow {
	originKey: string;
	epoch: number;
	sessionDir: string;
	updatedAt: number;
	/** Session file pinned by `/resume-jabbu`; opened instead of the newest session of `sessionDir`. */
	sessionFile: string | null;
	/** `provider/model` chosen with `/model-jabbu`; applied every time the omp child opens the session. */
	model: string | null;
	/** Thinking level chosen with `/thinking-jabbu`; applied like `model`. */
	thinking: string | null;
}

/** Per-origin runtime settings kept across idle release, restarts and `/new-jabbu`. */
export type OriginSettings = Pick<OriginRow, "model" | "thinking">;

export interface InboundRow {
	platformMessageId: string;
	originKey: string;
	epoch: number;
	textRef: string;
	state: InboundState;
	createdAt: number;
	dispatchedAt: number | null;
	opRef: string | null;
	/** omp session `leafId` (entry-id string) read right before dispatch; null when the session had no entries. */
	entryCursor: string | null;
	/** Thread the reply goes to (`<channel>:<thread_ts>`); backfilled from platform_message_id for pre-migration rows. */
	threadRef: string;
	/** User id of the peer bot that wrote this row; null for every owner row (and rows from before the column). */
	peerUserId: string | null;
	/** Set while `state` is `uncertain` (and kept after retry/close): why the input was parked, and when. */
	uncertainReason: UncertainReason | null;
	uncertainAt: number | null;
	/** Put in by `jabbu-pocket inject` (`OwnerIngest.injected`), not typed by the owner: never answers an ask card. */
	injected: boolean;
}

export interface DeliveryRow {
	deliveryId: number;
	originKey: string;
	opRef: string;
	part: number;
	threadRef: string;
	body: string;
	state: DeliveryState;
	attempts: number;
	nextAt: number;
	redelivered: boolean;
	createdAt: number;
	lastError: string | null;
	/** Messages of this row already posted before a rate limit cut the send (resume skips them); 0 when none. */
	sentParts: number;
	/** Top-level answer cut after part 1: the ts parts 2+ reply under. */
	replyTs: string | null;
}

/** One ledger row a recall search may quote: an owner message (`inbound`) or a confirmed bot answer (`delivery`). */
export interface RecallCandidate {
	kind: "inbound" | "delivery";
	originKey: string;
	threadRef: string;
	createdAt: number;
	/** First 1200 characters of the message or answer. */
	text: string;
	opRef: string | null;
}

export interface WikiTurnInput {
	originKey: string;
	opRef: string;
	repo: string;
	threadRef: string;
	/** Notes of one group go out as one: `thread:<threadRef>` for a channel thread, `turn:<originKey>:<opRef>` otherwise. */
	groupKey: string;
	/** The turn's end as a `YYYYMMDD` day in the bot's time zone. */
	day: string;
	inbound: string;
	conclusion: string;
	commits: { sha: string; subject: string }[];
	endedAt: number;
}

export interface WikiTurnRow extends WikiTurnInput {
	id: number;
}

export interface WikiTurnSql {
	id: number;
	origin_key: string;
	op_ref: string;
	repo: string;
	thread_ref: string;
	group_key: string;
	day: string;
	inbound: string;
	conclusion: string;
	commits_json: string;
	ended_at: number;
}

export const toWikiTurn = (r: WikiTurnSql): WikiTurnRow => ({
	id: r.id,
	originKey: r.origin_key,
	opRef: r.op_ref,
	repo: r.repo,
	threadRef: r.thread_ref,
	groupKey: r.group_key,
	day: r.day,
	inbound: r.inbound,
	conclusion: r.conclusion,
	commits: JSON.parse(r.commits_json) as { sha: string; subject: string }[],
	endedAt: r.ended_at,
});

export interface TurnSnapshotRow {
	id: number;
	originKey: string;
	opRef: string;
	repo: string;
	headBefore: string;
	treeBefore: string;
	headAfter: string;
	treeAfter: string;
	startedAt: number;
	endedAt: number;
	/** Undo happened at this time; NULL while the turn is still undoable. */
	revertedAt: number | null;
}

export interface TurnSnapshotInput {
	originKey: string;
	opRef: string;
	repo: string;
	headBefore: string;
	treeBefore: string;
	headAfter: string;
	treeAfter: string;
	startedAt: number;
	endedAt: number;
}

export interface TurnSnapshotSql {
	id: number;
	origin_key: string;
	op_ref: string;
	repo: string;
	head_before: string;
	tree_before: string;
	head_after: string;
	tree_after: string;
	started_at: number;
	ended_at: number;
	reverted_at: number | null;
}

export const toTurnSnapshot = (r: TurnSnapshotSql): TurnSnapshotRow => ({
	id: r.id,
	originKey: r.origin_key,
	opRef: r.op_ref,
	repo: r.repo,
	headBefore: r.head_before,
	treeBefore: r.tree_before,
	headAfter: r.head_after,
	treeAfter: r.tree_after,
	startedAt: r.started_at,
	endedAt: r.ended_at,
	revertedAt: r.reverted_at,
});

/** start: a new agent (a resume that starts one too) · followup: a prompt to a running one · remind: the sweep's nudge. */
type HerdrPromptKind = "start" | "followup" | "remind";

/** One prompt herdr took; `host` null = local herdr. */
export interface HerdrPromptInput {
	host: string | null;
	agent: string;
	kind: HerdrPromptKind;
	/** The prompt as sent; only its masked preview is stored. */
	text: string;
	originKey: string | null;
}

export interface LaneBoardPost {
	id: number;
	channel: string;
	authorOrigin: string;
	authorLabel: string;
	text: string;
	replyTo: number | null;
	createdAt: number;
}

export interface LaneBoardPostSql {
	id: number;
	channel: string;
	author_origin: string;
	author_label: string;
	text: string;
	reply_to: number | null;
	created_at: number;
}

export const toLaneBoardPost = (r: LaneBoardPostSql): LaneBoardPost => ({
	id: r.id,
	channel: r.channel,
	authorOrigin: r.author_origin,
	authorLabel: r.author_label,
	text: r.text,
	replyTo: r.reply_to,
	createdAt: r.created_at,
});

/** Where one reader stands in one channel: the last post read and the last one a turn prompt announced (0 = none). */
export interface LaneBoardCursor {
	lastRead: number;
	lastNoticed: number;
}

export interface LaneSql {
	name: string;
	title: string;
	thread_ref: string;
	origin_key: string;
	cwd: string;
	session_dir: string;
	status: LaneStatus;
	history: string;
	meta: string;
	created_at: number;
	updated_at: number;
}

export const toLane = (r: LaneSql): LaneRow => ({
	name: r.name,
	title: r.title,
	threadRef: r.thread_ref,
	originKey: r.origin_key,
	cwd: r.cwd,
	sessionDir: r.session_dir,
	status: r.status,
	history: JSON.parse(r.history) as LaneHistoryEntry[],
	meta: JSON.parse(r.meta) as LaneMeta,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

export interface LaneReservationSql {
	id: number;
	origin_key: string;
	thread_ref: string;
	repo: string;
	after_json: string;
	start_args_json: string;
	state: ReservationState;
	notice: string | null;
	lane_name: string | null;
	created_at: number;
	expires_at: number;
}

export const toLaneReservation = (r: LaneReservationSql): LaneReservation => ({
	id: r.id,
	originKey: r.origin_key,
	threadRef: r.thread_ref,
	repo: r.repo,
	after: JSON.parse(r.after_json) as string[],
	startArgs: JSON.parse(r.start_args_json) as Record<string, unknown>,
	state: r.state,
	notice: r.notice,
	laneName: r.lane_name,
	createdAt: r.created_at,
	expiresAt: r.expires_at,
});

type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "replied";

export interface ApprovalRow {
	approvalId: string;
	channel: string;
	messageTs: string;
	status: ApprovalStatus;
	originKey: string | null;
	originThreadRef: string | null;
	replyTs: string | null;
	replyText: string | null;
	/** The request text as the card shows it (redacted, cut). */
	summary: string;
	/** `<channel>:<ts>` of the card's mirror in the asking thread; null without one (and on older rows). */
	mirrorRef: string | null;
}

export interface ApprovalSql {
	approval_id: string;
	channel: string;
	message_ts: string;
	status: ApprovalStatus;
	origin_key: string | null;
	origin_thread_ref: string | null;
	reply_ts: string | null;
	reply_text: string | null;
	summary: string;
	mirror_ref: string | null;
}

export interface OriginSql {
	origin_key: string;
	epoch: number;
	session_dir: string;
	updated_at: number;
	session_file: string | null;
	model: string | null;
	thinking: string | null;
}
export interface InboundSql {
	platform_message_id: string;
	origin_key: string;
	epoch: number;
	text_ref: string;
	state: InboundState;
	created_at: number;
	dispatched_at: number | null;
	op_ref: string | null;
	entry_cursor: string | null;
	thread_ref: string | null;
	peer_user_id: string | null;
	uncertain_reason: UncertainReason | null;
	uncertain_at: number | null;
	/** Absent on a read-only handle of a ledger the daemon has not migrated yet. */
	injected?: number;
}
export interface DeliverySql {
	delivery_id: number;
	origin_key: string;
	op_ref: string;
	part: number;
	thread_ref: string;
	body: string;
	state: DeliveryState;
	attempts: number;
	next_at: number;
	redelivered: number;
	created_at: number;
	last_error: string | null;
	sent_parts: number | null;
	reply_ts: string | null;
}

export const toOrigin = (r: OriginSql): OriginRow => ({
	originKey: r.origin_key,
	epoch: r.epoch,
	sessionDir: r.session_dir,
	updatedAt: r.updated_at,
	sessionFile: r.session_file,
	model: r.model,
	thinking: r.thinking,
});

export const toInbound = (r: InboundSql): InboundRow => ({
	platformMessageId: r.platform_message_id,
	originKey: r.origin_key,
	epoch: r.epoch,
	textRef: r.text_ref,
	state: r.state,
	createdAt: r.created_at,
	dispatchedAt: r.dispatched_at,
	opRef: r.op_ref,
	entryCursor: r.entry_cursor,
	threadRef: r.thread_ref ?? r.platform_message_id,
	peerUserId: r.peer_user_id ?? null,
	uncertainReason: r.uncertain_reason ?? null,
	uncertainAt: r.uncertain_at ?? null,
	injected: r.injected === 1,
});

export const toDelivery = (r: DeliverySql): DeliveryRow => ({
	deliveryId: r.delivery_id,
	originKey: r.origin_key,
	opRef: r.op_ref,
	part: r.part,
	threadRef: r.thread_ref,
	body: r.body,
	state: r.state,
	attempts: r.attempts,
	nextAt: r.next_at,
	redelivered: r.redelivered === 1,
	createdAt: r.created_at,
	lastError: r.last_error,
	sentParts: r.sent_parts ?? 0,
	replyTs: r.reply_ts,
});
