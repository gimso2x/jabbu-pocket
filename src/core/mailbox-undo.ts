import {
	applyUndo,
	type GitRunner,
	type PlannedFile,
	planUndo,
	type RepoPlan,
	type TurnSnapshotRow,
	undoPlanNotes,
} from "../ops/turn-snapshot";
import { redact } from "../redact";

/** Injected so tests use `FakeOmpDriver`; production builds an `RpcOmpDriver` for (origin, sessionDir). */
import type { MailboxDeps, MailboxHost, UndoCard } from "./mailbox-types";

/**
 * `!undo`: the origin's newest turn that changed a repository, put back after the owner
 * approves. Runs outside the serial chain (the card waits minutes) and re-enters it for the write, where the plan is
 * recomputed: files that changed meanwhile become conflicts, and a turn that started meanwhile cancels the undo. A
 * newest turn with nothing left to revert is closed first and the turn before it is offered instead.
 */
export function startUndo(host: MailboxHost, opRef: string, threadRef: string): void {
	const { store, originKey, log } = host.deps;
	const reply = (text: string): void => {
		store.recordAnswer({ originKey, opRef, threadRef, parts: [text] });
	};
	const turnUndo = host.deps.turnUndo;
	// "Not configured" is about the repository list, not about the dependency: the daemon always passes one and a
	// config reload fills it without a restart.
	if (turnUndo === undefined || turnUndo.repos().length === 0) {
		reply("턴 되돌리기가 설정되지 않았습니다(turnSnapshot).");
		return;
	}
	if (host.turn()) {
		reply("턴이 끝난 뒤 다시 시도하세요. 되돌리기는 턴이 끝난 뒤에만 됩니다.");
		return;
	}
	const notes = [...(host.lastUndoFailures()?.failed ?? [])].map(
		([repo, reason]) =>
			`스냅샷 없음: ${repo}(${redact(reason.split("\n")[0] ?? reason)}) — 직전 턴을 기록하지 못해 이 저장소는 되돌리지 않음`,
	);
	// A repository the last turn could not snapshot has no row for that turn: its newest row belongs to an older
	// turn, which the owner is not asking to undo. Leave it out instead of silently going further back.
	const failed = host.lastUndoFailures();
	const newest = (): TurnSnapshotRow[] =>
		store
			.latestUndoableTurn(originKey)
			.filter((row) => failed === undefined || !failed.failed.has(row.repo) || row.opRef === failed.opRef);
	const first = newest();
	if (first.length === 0) {
		reply(notes.length > 0 ? notes.join("\n") : "되돌릴 턴 변경이 없습니다.");
		return;
	}
	const generation = host.turnGeneration();
	let rows = first;
	const planNewest = async (): Promise<UndoCard | undefined> => {
		// A turn whose files are all conflicts or overlaps can never be reverted (a revert that stopped midway, a
		// hand edit since): it is closed so it does not pin `!undo` to itself, and the turn before it is planned.
		for (;;) {
			const planned = await planUndoCard(host.deps, rows, notes, { run: turnUndo.run });
			const stuck =
				planned.plans.some((repoPlan) => repoPlan.files.length > 0 || repoPlan.missing === true) &&
				planned.plans.every(
					(repoPlan) => repoPlan.commit === undefined && repoPlan.files.every((file) => file.kind !== "revert"),
				);
			if (!stuck) return planned;
			const opRefs = [...new Set(rows.map((row) => row.opRef))];
			for (const turnRef of opRefs) store.markTurnReverted(originKey, turnRef, host.deps.clock.now());
			log.info("undo_turn_closed", { origin: originKey, opRef: opRefs.join(",") });
			notes.push(
				`되돌릴 파일이 없어 닫은 턴: ${rows.map((row) => row.repo).join(", ")} — 충돌·겹침만 남아 그 이전 턴으로 넘어감`,
			);
			const older = newest();
			if (older.length === 0) return undefined;
			rows = older;
		}
	};
	planNewest()
		.then(async (planned) => {
			if (planned === undefined) {
				reply([...notes, "더 되돌릴 턴 변경이 없습니다."].join("\n"));
				return;
			}
			if (planned.plans.every((plan) => plan.files.length === 0 && plan.commit === undefined)) {
				reply(planned.nothing);
				return;
			}
			const outcome = await turnUndo.approve({ summary: planned.summary, threadRef, originKey });
			if (outcome !== "approved") {
				reply(outcome === "timeout" ? "승인 시간이 지나 되돌리지 않았습니다." : "승인하지 않아 되돌리지 않았습니다.");
				return;
			}
			const answer = await host.serial(() => applyUndoPlan(host, rows, planned.plans, generation, notes));
			reply(answer);
		})
		.catch((error: unknown) => {
			log.error("undo_failed", { origin: originKey, opRef, error: String(error) });
			reply(`되돌리지 못했습니다: ${redact(String(error))}`);
		});
}

/**
 * The card text and the per-repository plans of one turn. A turn that committed only advises a `git revert`; the
 * other repositories list their files by kind, the first ten of each.
 */
export async function planUndoCard(
	deps: MailboxDeps,
	rows: readonly TurnSnapshotRow[],
	notes: readonly string[],
	options: { run?: GitRunner },
): Promise<UndoCard> {
	// Overlap is checked against every row of the repository, whatever its origin: a turn of another conversation is
	// exactly the case that must be seen (turns of one origin never run at the same time).
	const plans = await Promise.all(
		rows.map((row) =>
			planUndo({
				row,
				others: deps.store.listTurnSnapshots({ repo: row.repo }),
				run: options.run,
			}),
		),
	);
	const lines: string[] = ["이 대화의 최근 변경 턴을 되돌릴까요?"];
	let totalRevert = 0;
	for (const plan of plans) {
		const count = (kind: PlannedFile["kind"]): number => plan.files.filter((file) => file.kind === kind).length;
		totalRevert += count("revert");
		if (plan.commit !== undefined) {
			lines.push(`· ${plan.repo}: 턴이 커밋했습니다 — 파일은 그대로 두고 ${plan.commit.advice}`);
			continue;
		}
		lines.push(`· ${plan.repo}: 되돌림 ${count("revert")}개, 충돌 ${count("conflict")}개, 겹침 ${count("overlap")}개`);
		for (const note of undoPlanNotes(plan)) lines.push(`  ${note}`);
		for (const kind of ["revert", "conflict", "overlap"] as const) {
			const paths = plan.files.filter((file) => file.kind === kind).map((file) => file.path);
			if (paths.length === 0) continue;
			const shown = paths.slice(0, 10).join(", ");
			lines.push(`  ${kind}: ${shown}${paths.length > 10 ? ` … 외 ${paths.length - 10}개` : ""}`);
		}
	}
	for (const note of notes) lines.push(`· ${note}`);
	const summary = lines.join("\n");
	const nothing = totalRevert === 0 ? `${summary}\n되돌릴 파일이 없습니다(모두 충돌·겹침이거나 커밋된 턴).` : summary;
	return { plans, summary, nothing };
}

/**
 * Re-checks a plan right before writing (the card waited, and the serial chain was free meanwhile): a turn started in
 * between cancels the undo, and any file whose classification changed is left alone. Files that are still `revert`
 * go back to their before-tree.
 */
export async function applyUndoPlan(
	host: MailboxHost,
	rows: readonly TurnSnapshotRow[],
	planned: readonly RepoPlan[],
	generation: number,
	notes: readonly string[],
): Promise<string> {
	const { store, originKey, log } = host.deps;
	const turnUndo = host.deps.turnUndo;
	if (turnUndo === undefined) return "턴 되돌리기가 설정되지 않았습니다(turnSnapshot).";
	if (host.turn() !== undefined || host.turnGeneration() !== generation) {
		return "승인 사이에 새 턴이 시작돼 되돌리지 않았습니다.";
	}
	const fresh = await Promise.all(
		rows.map((row) => planUndo({ row, others: store.listTurnSnapshots({ repo: row.repo }), run: turnUndo.run })),
	);
	const lines: string[] = [];
	const changed: string[] = [];
	let failed = false;
	for (const [index, plan] of fresh.entries()) {
		const before = planned[index];
		if (plan.commit !== undefined) {
			lines.push(plan.commit.advice);
			continue;
		}
		const allowed = new Set((before?.files ?? []).filter((file) => file.kind === "revert").map((file) => file.path));
		const writable: RepoPlan = {
			...plan,
			files: plan.files.filter((file) => file.kind === "revert" && allowed.has(file.path)),
		};
		for (const file of plan.files) {
			if (file.kind === "revert" && !allowed.has(file.path)) changed.push(file.path);
		}
		if (writable.files.length === 0) continue;
		const applied = await applyUndo(writable, { run: turnUndo.run });
		const counts = new Map<string, number>();
		for (const file of plan.files) counts.set(file.kind, (counts.get(file.kind) ?? 0) + 1);
		const conflicts = (counts.get("conflict") ?? 0) + applied.conflicts.length;
		lines.push(
			`되돌림: ${plan.repo} 파일 ${applied.reverted}개, 충돌 ${conflicts}개, 겹침 ${counts.get("overlap") ?? 0}개`,
		);
		if (applied.conflicts.length > 0) {
			lines.push(
				`디렉터리가 있어 남겨 둔 충돌 ${applied.conflicts.length}개: ${applied.conflicts.slice(0, 10).join(", ")}`,
			);
		}
		if (applied.failed !== undefined) {
			failed = true;
			lines.push(
				`되돌리다 멈춤: ${plan.repo} ${applied.failed.path} — ${redact(applied.failed.reason.split("\n")[0] ?? "")}. 이 파일부터는 그대로 두었습니다`,
			);
		}
		for (const note of undoPlanNotes(plan)) lines.push(note);
	}
	if (changed.length > 0) {
		lines.push(`승인 사이에 내용이 바뀌어 남겨 둔 파일 ${changed.length}개: ${changed.slice(0, 10).join(", ")}`);
	}
	for (const note of notes) lines.push(note);
	const opRefs = [...new Set(rows.map((row) => row.opRef))];
	if (lines.length > 0) {
		// A run that stopped on a failing file stays undoable: the next `!undo` plans the same turn again, where the
		// files already put back read as conflicts and only the rest is offered.
		if (!failed) for (const opRef of opRefs) store.markTurnReverted(originKey, opRef, host.deps.clock.now());
		const refs = rows.map((row) => `${row.repo}@refs/ompbot/turns/${row.id}/after`);
		lines.push(`되돌리기 전 상태는 git ref에 남아 있습니다: ${refs.join(", ")}`);
		log.info("undo_applied", { origin: originKey, opRef: opRefs.join(","), files: changed.length });
	}
	return lines.length === 0 ? "되돌리지 못했습니다: 되돌릴 파일이 남지 않았습니다." : lines.join("\n");
}
