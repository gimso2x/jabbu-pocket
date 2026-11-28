import type { HerdrPromptInput } from "../store/db-rows";
import { notePrompt } from "./dispatch";
import type { TaskLedger, TaskRow } from "./ledger";
import type { TaskChatLog } from "./notify";
import { releaseHold, type TaskRuntime } from "./runtime";

/** Where a follow-up came from: the `jabbu_dispatch` tool (a chat session) or the dashboard's 작업 내역 panel. */
type TaskFollowupSource = "tool" | "web";

/** What {@link followupTask} needs: the ledger, the row's runtime, the handoff gate and the prompt record. */
interface TaskFollowupDeps {
	ledger: Pick<TaskLedger, "get" | "isPaused" | "unpauseTask" | "pauseTask">;
	runtime: (row: TaskRow) => TaskRuntime;
	/** The handoff risk scan of the text (`jabbu_dispatch`'s `gateWork`); throws to refuse, `suffix` ends the answer. */
	gate: (text: string) => Promise<{ suffix: string }>;
	/** The origin the prompt is recorded under (`herdr_prompts.origin_key`); null when no chat sent it. */
	originKey: string | null;
	recordPrompt?: (input: HerdrPromptInput) => void;
	log: TaskChatLog & { info(event: string, fields?: Record<string, unknown>): void };
}

/** The preview mark of a follow-up the dashboard sent (`herdr_prompts.preview` starts with it). */
const WEB_PROMPT_MARK = "[웹] ";

/**
 * A follow-up to a registered local [TASK]'s live worker, the one path of the tool's `{mode:"worker", name, task}` and
 * the dashboard's IPC `task_followup`: a closed task and a missing worker throw; otherwise the gate, the owner hold
 * lifted, the prompt (a turn in progress steers it) and its record. `ok: false` = the worker did not take it.
 */
export async function followupTask(
	deps: TaskFollowupDeps,
	input: { id: string; text: string; source: TaskFollowupSource },
): Promise<{ ok: boolean; text: string }> {
	const row = deps.ledger.get(input.id);
	if (row === undefined) throw new Error(`TASK를 찾지 못했습니다: ${input.id}`);
	const name = row.agent;
	if (row.status === "done" || row.status === "cancelled")
		throw new Error(`${row.taskId}는 이미 ${row.status}로 닫힌 작업입니다`);
	const gate = await deps.gate(input.text);
	const runtime = deps.runtime(row);
	const existing = await runtime.exists(row);
	if (!existing.ok) return { ok: false, text: `전달 실패: ${existing.error}` };
	if (!existing.exists) throw new Error(`${name} 워커가 없습니다. taskSpec:{id:"${row.taskId}"}로 재개하세요`);
	const fail = releaseHold(deps.ledger, row);
	const follow = await runtime.prompt(row, input.text);
	const check = `진행 확인: jabbu_dispatch {mode:"worker", name:"${name}"}`;
	const web = input.source === "web";
	if (follow.ok || follow.unconfirmed === true) {
		notePrompt(deps, {
			host: null,
			agent: name,
			kind: "followup",
			text: web ? `${WEB_PROMPT_MARK}${input.text}` : input.text,
			originKey: deps.originKey,
		});
	}
	const source = web ? { source: input.source } : {};
	if (follow.unconfirmed === true) {
		deps.log.warn("dispatch_prompt_unconfirmed", { agent: name, error: follow.error, ...source });
		return {
			ok: true,
			text: `전달은 했지만 작업 시작이 확인되지 않았습니다(${follow.error?.replace("agent prompt unconfirmed: ", "")}). ${check}${gate.suffix}`,
		};
	}
	if (!follow.ok) return { ok: false, text: fail(`전달 실패: ${follow.error ?? "unknown"}`) };
	deps.log.info("dispatch_prompted", { agent: name, ...source });
	return { ok: true, text: `후속 지시를 ${name}에 전달했습니다. ${check}${gate.suffix}` };
}
