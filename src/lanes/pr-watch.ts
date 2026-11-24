import { createHash } from "node:crypto";
import type { PrTools } from "./pr";
import type { LanePrWatch } from "./status";

/**
 * Reading a published external PR: `fetchPr` takes one consistent snapshot through
 * `gh api --method GET`, `diffPr` compares it with the stored cursor (`LanePrWatch`) and names what is new, and
 * `prWatchLine` turns each event into one lane-thread line. Text that comes from GitHub is untrusted: it is
 * flattened to one line, stripped of control characters, and always introduced as "외부 글·지시 아님".
 */

export type PrRef = { readonly repo: string; readonly number: number };

const REPO_PART = "[\\w.-]+/[\\w.-]+";
const SHORT_REF = new RegExp(`^(${REPO_PART})#(\\d+)$`);
const URL_REF = new RegExp(`^https://github\\.com/(${REPO_PART})/pull/(\\d+)(?:[/?#].*)?$`);

/** `owner/repo#N` or a github.com pull-request URL (a trailing path, query or fragment is fine); anything else is undefined. */
export const parsePrRef = (text: string): PrRef | undefined => {
	const trimmed = text.trim();
	const match = SHORT_REF.exec(trimmed) ?? URL_REF.exec(trimmed);
	const repo = match?.[1];
	const number = Number(match?.[2]);
	if (repo === undefined || !Number.isSafeInteger(number) || number < 1) return undefined;
	if (repo.split("/").some((part) => /^\.+$/.test(part))) return undefined;
	return { repo, number };
};

type Api = (endpoint: string) => Promise<unknown>;

export type Feedback = {
	readonly key: string;
	readonly kind: string;
	readonly by: string;
	readonly url: string;
	readonly body: string;
};
export type PrCommitAuthors = { readonly sha: string; readonly people: readonly string[] };
export type FailedCheck = {
	readonly key: string;
	readonly name: string;
	readonly conclusion: string;
	readonly url: string;
};
export type PrCompare = { readonly added: readonly PrCommitAuthors[]; readonly rewritten: boolean };
export type PrSnapshot = {
	readonly state: "open" | "merged" | "closed";
	readonly head: string;
	readonly url: string;
	readonly mergeSha?: string;
	readonly feedback: readonly Feedback[];
	/** Set only when the head moved (or on the first read). */
	readonly commits?: readonly PrCommitAuthors[];
	/** Set only when the head is not among the (250-capped) listed commits. */
	readonly compared?: PrCompare;
	readonly failed: readonly FailedCheck[];
};

const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

const cut = (text: string, limit: number): string => {
	const chars = [...text];
	return chars.length > limit ? chars.slice(0, limit).join("") : text;
};

const flatten = (value: string): string => value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();

/** One line without control, format or line-separator characters, at most `limit` characters. */
export const safeText = (value: string, limit = 4096): string => cut(flatten(value), limit);

/** The URL when it is an https link without whitespace; otherwise an empty string. */
export const safeUrl = (value: string | null | undefined): string => {
	if (typeof value !== "string" || /[\s\p{Cc}]/u.test(value)) return "";
	try {
		return new URL(value).protocol === "https:" ? value : "";
	} catch {
		return "";
	}
};

export const PR_WATCH_INTERVAL_MS = 10 * 60_000;
export const PR_WATCH_IGNORE: ReadonlySet<string> = new Set(["github-actions"]);

export interface PrWatchWho {
	readonly self: string;
	readonly ignore: ReadonlySet<string>;
	readonly selfEmails?: ReadonlySet<string>;
}

/** A value folded to one line and shortened to `max` characters, the last being "…" when it was cut. */
export const excerpt = (value: string, max = 160): string => {
	const text = flatten(value);
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

const login = (name: string): string => name.toLowerCase().replace(/\[bot\]$/, "");
const isQuiet = (name: string, who: PrWatchWho): boolean =>
	login(name) === login(who.self) || [...who.ignore].some((entry) => login(entry) === login(name));

const rec = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const PAGE = 100;
const HEX40 = /^[0-9a-f]{40}$/;
const FAILING_RUNS = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);
const FAILING_STATUSES = new Set(["failure", "error"]);
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

/** More rows than the page limit allows: the snapshot would be partial, so the pass reports nothing. */
class PartialRead extends Error {}

type PageLimit = { readonly pages: number; readonly overflow: "partial" | "truncate" };
/** 500 rows (5 pages); a sixth page with rows means the read is incomplete. */
const LISTING: PageLimit = { pages: 5, overflow: "partial" };
/** GitHub itself stops these lists at 250 rows (3 pages). */
const CAPPED: PageLimit = { pages: 3, overflow: "truncate" };

async function readPages(
	api: Api,
	base: string,
	take: (body: unknown) => unknown[],
	limit: PageLimit,
): Promise<unknown[]> {
	const rows: unknown[] = [];
	const last = limit.overflow === "partial" ? limit.pages + 1 : limit.pages;
	for (let page = 1; page <= last; page++) {
		const got = take(await api(`${base}?per_page=${PAGE}&page=${page}`));
		if (page > limit.pages) {
			if (got.length > 0) throw new PartialRead(`more than ${limit.pages * PAGE} rows at ${base}`);
			break;
		}
		rows.push(...got);
		if (got.length < PAGE) break;
	}
	return rows;
}

const asList = (body: unknown): unknown[] => {
	if (!Array.isArray(body)) throw new Error("incomplete page");
	return body;
};

const fingerprint = (...parts: string[]): string =>
	createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 10);

const nameOf = (user: unknown): string => {
	const name = rec(user)?.login;
	return typeof name === "string" && name !== "" ? name : "ghost";
};

/** A comment-like row as feedback; an edit changes the fingerprint in the key, so it reads as news again. */
function textFeedback(raw: unknown, prefix: string, kind: string, bad: string, state = ""): Feedback {
	const row = rec(raw);
	if (row === undefined || typeof row.id !== "number" || !Number.isSafeInteger(row.id)) throw new Error(bad);
	if ((row.body !== null && typeof row.body !== "string") || typeof row.html_url !== "string") throw new Error(bad);
	if (row.user !== null && rec(row.user) === undefined) throw new Error(bad);
	const body = row.body ?? "";
	const stamp =
		typeof row.updated_at === "string" ? row.updated_at : typeof row.submitted_at === "string" ? row.submitted_at : "";
	return {
		key: `${prefix}:${row.id}:${fingerprint(stamp, state, body)}`,
		kind,
		by: safeText(nameOf(row.user), 100),
		url: safeUrl(row.html_url),
		body: safeText(body),
	};
}

const REVIEW_KINDS: Record<string, string> = {
	APPROVED: "review-approved",
	CHANGES_REQUESTED: "review-changes",
	COMMENTED: "review-commented",
};

function reviewFeedback(raw: unknown): Feedback[] {
	const state = rec(raw)?.state;
	if (typeof state !== "string" || !REVIEW_STATES.has(state)) throw new Error("incomplete review");
	const kind = REVIEW_KINDS[state];
	// Pending drafts are not public yet, and a dismissal is read from the timeline with its reason.
	if (kind === undefined) return [];
	const item = textFeedback(raw, "rv", kind, "incomplete review", state);
	return state === "COMMENTED" && item.body === "" ? [] : [item];
}

function dismissalFeedback(raw: unknown, prUrl: string): Feedback[] {
	const event = rec(raw);
	if (event?.event !== "review_dismissed") return [];
	const dismissed = rec(event.dismissed_review);
	if (typeof event.id !== "number" || typeof dismissed?.review_id !== "number")
		throw new Error("incomplete timeline event");
	const message = dismissed.dismissal_message;
	return [
		{
			key: `dm:${event.id}`,
			kind: "review-dismissed",
			by: safeText(nameOf(event.actor), 100),
			url: safeUrl(prUrl === "" ? null : `${prUrl}#pullrequestreview-${dismissed.review_id}`),
			body: typeof message === "string" ? safeText(message) : "",
		},
	];
}

/** Who made a commit besides us: empty for ours, "unknown" when GitHub names nobody (web merges, rebases). */
function authorsOf(raw: unknown, who: PrWatchWho): PrCommitAuthors {
	const row = rec(raw);
	const git = rec(row?.commit);
	if (row === undefined || git === undefined || typeof row.sha !== "string" || !HEX40.test(row.sha)) {
		throw new Error("incomplete commit");
	}
	const email = rec(git.author)?.email;
	if (typeof email === "string" && who.selfEmails?.has(email.toLowerCase()) === true)
		return { sha: row.sha, people: [] };
	const names = [row.author, row.committer]
		.map((user) => rec(user)?.login)
		.filter((name): name is string => typeof name === "string" && name !== "" && name.toLowerCase() !== "web-flow");
	if (names.length === 0) return { sha: row.sha, people: ["unknown"] };
	return {
		sha: row.sha,
		people: [...new Set(names)].filter((name) => !isQuiet(name, who)).map((name) => safeText(name, 100)),
	};
}

type Meta = { state: PrSnapshot["state"]; head: string; url: string; mergeSha?: string };

async function readMeta(api: Api, ref: PrRef): Promise<Meta> {
	const body = rec(await api(`repos/${ref.repo}/pulls/${ref.number}`));
	const head = rec(body?.head)?.sha;
	if (
		body === undefined ||
		typeof head !== "string" ||
		!HEX40.test(head) ||
		(body.state !== "open" && body.state !== "closed") ||
		typeof body.merged !== "boolean"
	) {
		throw new Error("incomplete pull request");
	}
	const merge = body.merge_commit_sha;
	return {
		state: body.state === "open" ? "open" : body.merged ? "merged" : "closed",
		head,
		url: safeUrl(typeof body.html_url === "string" ? body.html_url : null),
		...(body.merged && typeof merge === "string" ? { mergeSha: merge } : {}),
	};
}

async function readFailed(api: Api, ref: PrRef, head: string): Promise<FailedCheck[]> {
	const base = `repos/${ref.repo}/commits/${head}`;
	let total: number | undefined;
	const runs = await readPages(
		api,
		`${base}/check-runs`,
		(body) => {
			const page = rec(body);
			if (page === undefined || !Array.isArray(page.check_runs) || typeof page.total_count !== "number") {
				throw new Error("incomplete check runs");
			}
			total ??= page.total_count;
			return page.check_runs;
		},
		LISTING,
	);
	if (total !== runs.length) throw new Error("incomplete check runs");
	const failed: FailedCheck[] = [];
	for (const raw of runs) {
		const run = rec(raw);
		if (
			run === undefined ||
			typeof run.id !== "number" ||
			typeof run.name !== "string" ||
			typeof run.html_url !== "string" ||
			run.head_sha !== head ||
			(run.conclusion !== null && typeof run.conclusion !== "string")
		) {
			throw new Error("incomplete check runs");
		}
		if (run.conclusion !== null && FAILING_RUNS.has(run.conclusion)) {
			failed.push({
				key: `ck:${run.id}:${run.conclusion}`,
				name: safeText(run.name, 200),
				conclusion: run.conclusion,
				url: safeUrl(run.html_url),
			});
		}
	}
	// Commit statuses: only the newest entry of each context counts.
	const newest = new Map<string, { id: number; state: string; url: string | null }>();
	for (const raw of await readPages(api, `${base}/statuses`, asList, LISTING)) {
		const status = rec(raw);
		if (
			status === undefined ||
			typeof status.id !== "number" ||
			typeof status.state !== "string" ||
			typeof status.context !== "string" ||
			(status.target_url !== null && typeof status.target_url !== "string")
		) {
			throw new Error("incomplete statuses");
		}
		const held = newest.get(status.context);
		if (held === undefined || held.id < status.id) {
			newest.set(status.context, { id: status.id, state: status.state, url: status.target_url });
		}
	}
	const bad = [...newest]
		.filter(([, status]) => FAILING_STATUSES.has(status.state))
		.sort(([, a], [, b]) => a.id - b.id);
	for (const [context, status] of bad) {
		failed.push({
			key: `st:${status.id}`,
			name: safeText(context, 200),
			conclusion: status.state,
			url: safeUrl(status.url),
		});
	}
	return failed;
}

async function compareHeads(
	api: Api,
	ref: PrRef,
	prev: LanePrWatch,
	head: string,
	who: PrWatchWho,
	listed: readonly PrCommitAuthors[],
): Promise<PrCompare> {
	let status: unknown;
	try {
		const rows = await readPages(
			api,
			`repos/${ref.repo}/compare/${prev.head}...${head}`,
			(body) => {
				const page = rec(body);
				if (page === undefined || !Array.isArray(page.commits) || typeof page.status !== "string") {
					throw new Error("incomplete compare");
				}
				status = page.status;
				return page.commits;
			},
			CAPPED,
		);
		return { added: rows.map((row) => authorsOf(row, who)), rewritten: status !== "ahead" };
	} catch (error) {
		// The old head is gone from the repository: the history was rewritten.
		if (!/HTTP 404|Not Found/i.test(String(error))) throw error;
		const known = new Set(prev.commits);
		return { added: listed.filter((commit) => !known.has(commit.sha)), rewritten: true };
	}
}

/** One consistent snapshot: the PR metadata is read before and after, and a change in between drops the snapshot. */
async function fetchPr(api: Api, ref: PrRef, prev: LanePrWatch | undefined, who: PrWatchWho): Promise<PrSnapshot> {
	const meta = await readMeta(api, ref);
	const pull = `repos/${ref.repo}/pulls/${ref.number}`;
	const issue = `repos/${ref.repo}/issues/${ref.number}`;
	const comments = (await readPages(api, `${issue}/comments`, asList, LISTING)).map((row) =>
		textFeedback(row, "ic", "comment", "incomplete comment"),
	);
	const reviewComments = (await readPages(api, `${pull}/comments`, asList, LISTING)).map((row) =>
		textFeedback(row, "rc", "review-comment", "incomplete review comment"),
	);
	const reviews = (await readPages(api, `${pull}/reviews`, asList, LISTING)).flatMap(reviewFeedback);
	const dismissals = (await readPages(api, `${issue}/timeline`, asList, LISTING)).flatMap((row) =>
		dismissalFeedback(row, meta.url),
	);
	let commits: PrCommitAuthors[] | undefined;
	let compared: PrCompare | undefined;
	if (prev === undefined || prev.head !== meta.head) {
		commits = (await readPages(api, `${pull}/commits`, asList, CAPPED)).map((row) => authorsOf(row, who));
		if (prev !== undefined && !commits.some((commit) => commit.sha === meta.head)) {
			compared = await compareHeads(api, ref, prev, meta.head, who, commits);
		}
	}
	const failed = meta.state === "open" ? await readFailed(api, ref, meta.head) : [];
	const after = await readMeta(api, ref);
	if (after.head !== meta.head || after.state !== meta.state) {
		throw new Error("the PR changed while it was read; this snapshot is dropped");
	}
	return {
		...meta,
		feedback: [...comments, ...reviewComments, ...reviews, ...dismissals],
		...(commits !== undefined ? { commits } : {}),
		...(compared !== undefined ? { compared } : {}),
		failed,
	};
}

export type PrWatchEvent =
	| {
			readonly kind: "baseline";
			readonly head: string;
			readonly state: PrSnapshot["state"];
			readonly known: number;
			readonly url: string;
	  }
	| {
			readonly kind: "feedback";
			readonly feedbackKind: string;
			readonly by: string;
			readonly url: string;
			readonly body: string;
	  }
	| {
			readonly kind: "head-moved";
			readonly by: readonly string[];
			readonly added: number;
			readonly from: string;
			readonly to: string;
			readonly rewritten: boolean;
			readonly url: string;
	  }
	| {
			readonly kind: "ci-fail";
			readonly name: string;
			readonly conclusion: string;
			readonly head: string;
			readonly url: string;
	  }
	| { readonly kind: "merged"; readonly sha?: string }
	| { readonly kind: "closed" };

const SEEN_MAX = 400;
/** Slots kept free for the floor markers (one per key source: ic, rc, rv, dm, ck, st). */
const FLOOR_SLOTS = 8;
const FLOOR = "floor:";

/**
 * The cursor's `seen` list, capped at 400. Keys that fall off the front are not forgotten: each source keeps a
 * `floor:<source>:<id>` marker, and a key whose id is at or below its source's floor still counts as reported.
 */
function capSeen(keys: readonly string[]): string[] {
	if (keys.length <= SEEN_MAX) return [...keys];
	const floors = new Map<string, number>();
	const real: string[] = [];
	for (const key of keys) {
		if (!key.startsWith(FLOOR)) real.push(key);
		else raiseFloor(floors, key.slice(FLOOR.length));
	}
	for (const dropped of real.slice(0, Math.max(0, real.length - (SEEN_MAX - FLOOR_SLOTS)))) raiseFloor(floors, dropped);
	return [...[...floors].map(([source, id]) => `${FLOOR}${source}:${id}`), ...real.slice(-(SEEN_MAX - FLOOR_SLOTS))];
}

function raiseFloor(floors: Map<string, number>, key: string): void {
	const [source = "", id = ""] = key.split(":");
	const number = Number(id);
	if (source !== "" && Number.isFinite(number)) floors.set(source, Math.max(floors.get(source) ?? 0, number));
}

/** What the stored cursor says is already reported. */
function reported(seen: readonly string[]): (key: string) => boolean {
	const keys = new Set(seen);
	const floors = new Map<string, number>();
	for (const key of seen) if (key.startsWith(FLOOR)) raiseFloor(floors, key.slice(FLOOR.length));
	return (key) => {
		if (keys.has(key)) return true;
		const [source = "", id = ""] = key.split(":");
		const floor = floors.get(source);
		return floor !== undefined && Number(id) <= floor;
	};
}

/** Compares a snapshot with the cursor: the news (nothing on the first read but a baseline) and the next cursor. */
export const diffPr = (
	prev: LanePrWatch | undefined,
	snap: PrSnapshot,
	who: PrWatchWho,
	now: string,
): { events: PrWatchEvent[]; entry: LanePrWatch } => {
	if (prev !== undefined && prev.state !== "open") return { events: [], entry: { ...prev, polledAt: now } };
	const events: PrWatchEvent[] = [];
	const seen = [...(prev?.seen ?? [])];
	const isReported = reported(seen);
	let known = 0;
	const take = (key: string): boolean => {
		if (isReported(key)) return false;
		seen.push(key);
		known++;
		return prev !== undefined;
	};
	for (const item of snap.feedback) {
		if (isQuiet(item.by, who) || !take(item.key)) continue;
		events.push({ kind: "feedback", feedbackKind: item.kind, by: item.by, url: item.url, body: item.body });
	}
	if (prev !== undefined && prev.head !== snap.head) {
		const had = new Set(prev.commits);
		const listed = snap.commits ?? [];
		const added = snap.compared?.added ?? listed.filter((commit) => !had.has(commit.sha));
		const rewritten = snap.compared?.rewritten ?? !listed.some((commit) => commit.sha === prev.head);
		const by = [...new Set(added.flatMap((commit) => commit.people))];
		if (by.length > 0 || rewritten) {
			events.push({
				kind: "head-moved",
				by,
				added: added.length,
				from: prev.head,
				to: snap.head,
				rewritten,
				url: snap.url,
			});
		}
	}
	for (const check of snap.failed) {
		if (!take(check.key)) continue;
		events.push({ kind: "ci-fail", name: check.name, conclusion: check.conclusion, head: snap.head, url: check.url });
	}
	if (prev === undefined) {
		events.unshift({ kind: "baseline", head: snap.head, state: snap.state, known, url: snap.url });
	}
	const ended = snap.state !== "open";
	if (ended) events.push(snap.state === "merged" ? { kind: "merged", sha: snap.mergeSha } : { kind: "closed" });
	return {
		events,
		entry: {
			head: snap.head,
			commits: snap.commits?.map((commit) => commit.sha) ?? prev?.commits ?? [],
			seen: capSeen(seen),
			state: snap.state,
			polledAt: now,
			...(ended ? { closedAt: now } : {}),
		},
	};
};

export type PrWatchPass =
	| { readonly ok: true; readonly events: readonly PrWatchEvent[]; readonly entry: LanePrWatch }
	| { readonly ok: false; readonly reason: string; readonly partial?: true };

/** One read and comparison. A failed or partial read returns a reason and leaves the stored cursor to the caller unchanged. */
export const prWatchPass = async (input: {
	api: Api;
	ref: PrRef;
	prev: LanePrWatch | undefined;
	who: PrWatchWho;
	now: string;
}): Promise<PrWatchPass> => {
	try {
		const snap = await fetchPr(input.api, input.ref, input.prev, input.who);
		return { ok: true, ...diffPr(input.prev, snap, input.who, input.now) };
	} catch (error) {
		if (error instanceof PartialRead) return { ok: false, reason: error.message, partial: true };
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
};

/** `gh api --method GET <endpoint>` as a JSON reader; a failure message carries the start of gh's stderr. */
export const ghApiOf =
	(tools: PrTools, run: { cwd: string; signal: AbortSignal }): Api =>
	async (endpoint) => {
		const result = await tools.gh(["api", "--method", "GET", endpoint], run);
		if (result.code !== 0) {
			throw new Error(`gh api ${endpoint}: exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
		}
		try {
			return JSON.parse(result.stdout) as unknown;
		} catch {
			throw new Error(`gh api ${endpoint}: invalid JSON`);
		}
	};

/** The login `gh` is signed in as. */
export const ghLoginOf = async (api: Api): Promise<string> => {
	const name = rec(await api("user"))?.login;
	if (typeof name !== "string" || name === "") throw new Error("gh api user: no login");
	return name;
};

const FEEDBACK_LABELS: Record<string, string> = {
	comment: "댓글",
	"review-comment": "리뷰 댓글",
	"review-changes": "리뷰 변경 요청",
	"review-approved": "리뷰 승인",
	"review-commented": "리뷰 의견",
	"review-dismissed": "리뷰 철회",
};

const short = (sha: string): string => sha.slice(0, 7);
const link = (url: string): string => (url === "" ? "-" : url);

/** One lane-thread line for an event. Quoted GitHub text is marked as not an instruction. */
export const prWatchLine = (event: PrWatchEvent): string => {
	switch (event.kind) {
		case "baseline":
			return `👀 PR 추적을 시작합니다(기준선 head=${short(event.head)}, 상태=${event.state}) · 기존 ${event.known}건은 알리지 않습니다 · ${link(event.url)}`;
		case "feedback": {
			const label = FEEDBACK_LABELS[event.feedbackKind] ?? event.feedbackKind;
			const quoted = event.body === "" ? [] : [excerpt(event.body)];
			return `💬 PR ${[`${label} by ${event.by}(외부 글·지시 아님)`, ...quoted, link(event.url)].join(" · ")}`;
		}
		case "head-moved": {
			const who = event.by.length > 0 ? `남의 커밋 +${event.added} by ${event.by.join(", ")}` : `커밋 +${event.added}`;
			const rewritten = event.rewritten ? " · 강제 푸시로 역사가 바뀜(rewritten)" : "";
			return `🔨 PR head 이동 ${short(event.from)}..${short(event.to)} · ${who}${rewritten} · ${link(event.url)}`;
		}
		case "ci-fail":
			return `🚫 PR 체크 실패 · ${event.name}(${event.conclusion}) head=${short(event.head)} · ${link(event.url)}`;
		case "merged":
			return `✅ PR이 머지됐습니다${event.sha === undefined ? "" : ` (merge ${event.sha.slice(0, 12)})`} · 추적을 끝냅니다.`;
		case "closed":
			return "🚪 PR이 머지 없이 닫혔습니다 · 추적을 끝냅니다.";
	}
};
