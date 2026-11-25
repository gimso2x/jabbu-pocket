import type { LaneManagerDeps, LaneRequestOutcome } from "./manager-types";
import { defaultPrTools } from "./pr";
import {
	excerpt,
	ghApiOf,
	ghLoginOf,
	PR_WATCH_IGNORE,
	PR_WATCH_INTERVAL_MS,
	parsePrRef,
	prWatchLine,
	prWatchPass,
} from "./pr-watch";
import type { LanePr, LaneRow } from "./status";

/** What the watcher needs of its lane manager. */
export interface PrWatchCtx {
	deps: LaneManagerDeps;
	patchPr(name: string, patch: LanePr, entry?: { event: string; detail?: string; sha?: string }): LaneRow;
	spawn(lane: string, work: () => Promise<void>): void;
}

/** Reads the published external PRs of lanes on their own cadence. */
export class PrWatchRunner {
	readonly #ctx: PrWatchCtx;
	/** Lanes with a published-PR read running (pr-watch): a tick never starts a second one. */
	readonly #watching = new Set<string>();
	/** The last read failure posted per lane: the same reason is not repeated until a read succeeds. */
	readonly #warned = new Map<string, string>();
	/**
	 * Lines of a pass whose cursor was held back because a later line failed to post, per lane: the next pass reads the
	 * same news again and skips these. Memory only: after a restart a line may repeat, never get lost.
	 */
	readonly #posted = new Map<string, Set<string>>();
	/** Our `gh api user` login (the pr-watch reads our own comments and pushes as news without it); read once. */
	#self: string | undefined;
	/** Aborts the pr-watch reads of this process (`stop()`); made on the first pass. */
	#abort: AbortController | undefined;

	constructor(ctx: PrWatchCtx) {
		this.#ctx = ctx;
	}

	/** A pr-watch read is read-only: aborting it loses nothing (the next process reads again on its cadence). */
	stop(): void {
		this.#abort?.abort();
	}

	/**
	 * `!prwatch off <레인>`: the owner stops reading this lane's published PR.
	 * The cursor is kept as history; a later publish of the same lane starts watching afresh.
	 */
	async off(name: string): Promise<LaneRequestOutcome> {
		const lane = this.#ctx.deps.store.getLane(name);
		const pr = lane?.meta.pr;
		if (lane === undefined || pr === undefined) return { handled: false, text: "레인을 찾을 수 없습니다." };
		if (pr.state !== "published") return { handled: false, text: "게시된 PR이 없는 레인입니다." };
		if (pr.watchOff === true) return { handled: false, text: "이미 PR 추적이 꺼져 있습니다." };
		const ended = pr.watch !== undefined && pr.watch.state !== "open";
		this.#ctx.patchPr(name, { state: pr.state, watchOff: true }, { event: "pr_watch_off", detail: "오너 요청" });
		this.#warned.delete(name);
		this.#posted.delete(name);
		if (ended) return { handled: true, text: `👀 PR 추적은 머지·닫힘으로 이미 끝났습니다(${lane.title}).` };
		return { handled: true, text: `👀 PR 추적을 끕니다(${lane.title}).` };
	}

	/**
	 * A published PR is read on its own cadence (`PR_WATCH_INTERVAL_MS`, the first read one interval after the
	 * publish): the pass runs in the background so a slow `gh` never holds the tick. A lane whose watch ended (the
	 * PR merged or closed, or `!prwatch off`) is never read again.
	 */
	tick(lane: LaneRow, now: number): void {
		const pr = lane.meta.pr;
		if (pr?.state !== "published" || pr.url === undefined || pr.watchOff === true) return;
		if (pr.watch !== undefined && pr.watch.state !== "open") return;
		const last = pr.watch === undefined ? (pr.at ?? 0) : Date.parse(pr.watch.polledAt);
		if (Number.isFinite(last) && now - last < PR_WATCH_INTERVAL_MS) return;
		if (this.#watching.has(lane.name)) return;
		this.#watching.add(lane.name);
		this.#ctx.spawn(lane.name, async () => {
			try {
				await this.#pass(lane.name);
			} finally {
				this.#watching.delete(lane.name);
			}
		});
	}

	/**
	 * One pr-watch pass (Cataly `prWatchPass`): reads the PR through `gh api --method GET`, posts what is new into the
	 * lane thread — each line first, the cursor after, so a crash repeats a line rather than losing it — and saves the
	 * cursor to `meta.pr.watch`. A failed read changes nothing for that PR and warns once per distinct reason.
	 */
	async #pass(name: string): Promise<void> {
		const { store, log, clock } = this.#ctx.deps;
		const lane = store.getLane(name);
		const pr = lane?.meta.pr;
		if (lane === undefined || pr?.state !== "published" || pr.url === undefined || pr.watchOff === true) return;
		if (pr.watch !== undefined && pr.watch.state !== "open") return;
		const warn = async (reason: string) => {
			const short = excerpt(reason, 300);
			if (this.#warned.get(name) === short) return;
			this.#warned.set(name, short);
			log.warn("lane_pr_watch_failed", { lane: name, reason: short });
			await this.#post(lane, `⚠️ PR 추적 읽기 실패 · ${short}`);
		};
		const ref = parsePrRef(pr.url);
		if (ref === undefined) return await warn(`PR 주소에서 번호를 읽지 못했습니다: ${pr.url}`);
		const tools = this.#ctx.deps.prTools ?? defaultPrTools;
		this.#abort ??= new AbortController();
		const api = ghApiOf(tools, { cwd: lane.meta.repo ?? process.cwd(), signal: this.#abort.signal });
		if (this.#self === undefined) {
			try {
				this.#self = await ghLoginOf(api);
			} catch (error) {
				// Without our own login every push of ours would read as someone else's: hold rather than guess.
				return await warn(`우리 gh 계정을 확인하지 못해 이번 패스는 건너뜁니다: ${String(error).slice(0, 200)}`);
			}
		}
		const pass = await prWatchPass({
			api,
			ref,
			prev: pr.watch,
			who: { self: this.#self, ignore: PR_WATCH_IGNORE },
			now: new Date(clock.now()).toISOString(),
		});
		if (!pass.ok) return await warn(pass.reason);
		this.#warned.delete(name);
		const done = this.#posted.get(name) ?? new Set<string>();
		for (const event of pass.events) {
			const line = prWatchLine(event);
			if (done.has(line)) continue;
			if (!(await this.#post(lane, line))) {
				// The cursor stays where it was: the next pass reads this news again and posts what is still missing.
				this.#posted.set(name, done);
				return;
			}
			done.add(line);
		}
		this.#posted.delete(name);
		const ended = pass.entry.state !== "open";
		const current = store.getLane(name)?.meta.pr;
		// The owner may have turned the watch off meanwhile: the cursor then stays as the record of what was read.
		if (current === undefined || current.url !== pr.url || current.watchOff === true) return;
		this.#ctx.patchPr(
			name,
			{ state: pr.state, watch: pass.entry },
			ended ? { event: "pr_watch_ended", detail: pass.entry.state } : undefined,
		);
	}

	/** One pr-watch line into the lane thread; false when the post failed (logged, and the pass keeps its cursor). */
	async #post(lane: LaneRow, text: string): Promise<boolean> {
		const route = this.#ctx.deps.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return true;
		try {
			await route.port.post(route.target, { text });
			return true;
		} catch (error) {
			this.#ctx.deps.log.warn("lane_pr_watch_post_failed", { lane: lane.name, error: String(error) });
			return false;
		}
	}
}
