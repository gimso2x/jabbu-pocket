import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { landTask, type TaskLandDeps, type TaskLandResult } from "../src/tasks/land";
import type { TaskRow } from "../src/tasks/ledger";
import {
	buildBlockedCard,
	buildReachedCard,
	buildReviewWaitingCard,
	CANCEL_NOTE,
	cardMessage,
	MERGE_NOTE,
	parseTaskCancelAction,
	RECOMMEND_NOTE,
	taskCancelActionId,
	taskCancelConfirmActionId,
	taskCancelKeepActionId,
	taskMergeActionId,
	taskRecommendActionId,
} from "../src/tasks/notify";
import { GUILD, makeHome, OWNER, type TestHome, WaitingDiscordTransport } from "./helpers/bot-home";
import type { FakeDiscordCall } from "./helpers/discord-fake-transport";
import { daemonTestOptions } from "./helpers/disk";

const CHANNEL = "111111111111111111";
const THREAD = "222222222222222222";
const RECOMMEND = "A안: 캐시를 끄고 다시 측정";
const clock = { now: () => Date.now() };

type Update = Extract<FakeDiscordCall, { method: "editMessage" }>;

let home: TestHome;
let daemon: Daemon;
let transport: WaitingDiscordTransport;
let port: DiscordChannel;
let logs: string[];
let customLand: ((row: TaskRow, deps: TaskLandDeps) => Promise<TaskLandResult>) | undefined;
let landCalls: number;

beforeEach(async () => {
	home = makeHome("jabbu-cancel-button-");
	logs = [];
	customLand = undefined;
	landCalls = 0;
	transport = new WaitingDiscordTransport();
	transport.setChannel({ id: CHANNEL, type: 0, guildId: GUILD });
	transport.setChannel({ id: THREAD, type: 11, parentId: CHANNEL, guildId: GUILD });
	port = new DiscordChannel(transport, { ownerUserId: OWNER });
	const sessions = new FakeSessionStore();
	daemon = new Daemon({
		...daemonTestOptions(),
		config: home.config,
		channels: [new DiscordBinding(port)],
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		ompVersion: "omp-test 0",
		bootId: "boot",
		taskLand: async (row, deps) => {
			landCalls += 1;
			return customLand !== undefined ? customLand(row, deps) : landTask(row, deps);
		},
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

const blockedJudgement = (recommend: string) =>
	({
		blockedReason: "DB 경로를 정해야 함",
		decision: { question: "어느 경로?", recommend, impact: "재시작 필요" },
		current: "S2",
	}) as unknown as TaskJudgement;

const reachedJudgement = () =>
	({
		acChecked: 2,
		summary: ["변경 완료"],
		problems: [],
		integrityWarnings: [],
		checks: [{ id: "AC-1", ok: true, signal: "bun test", detail: "2 pass" }],
		evidence: {},
	}) as unknown as TaskJudgement;

function seedTask(status: TaskRow["status"], threadRef = `${CHANNEL}:${THREAD}`): TaskRow {
	const tasks = daemon.store.tasks;
	const row = tasks.register({
		title: "로그 회전",
		risk: "L2",
		originKey: `discord/ch/${CHANNEL}/t/${THREAD}`,
		threadRef,
		host: null,
		repo: "/r/repo",
		acceptance: acceptanceItems(["하나", "둘"]),
	});
	if (status !== "working") tasks.transition(row.taskId, status, "bot");
	return tasks.require(row.taskId);
}

async function postTaskCard(card: ReturnType<typeof buildBlockedCard>): Promise<string> {
	const posted = await port.post({ conversationId: CHANNEL, threadId: THREAD }, cardMessage(card, port));
	return posted.messageId;
}

let seq = 0n;
function pressButton(customId: string, cardId: string): Promise<void> {
	seq += 1n;
	return transport.emitInteraction({
		id: String(800_000_000_000_000_000n + seq),
		application_id: "600000000000000000",
		type: 3,
		token: `token-${seq}`,
		channel_id: THREAD,
		guild_id: GUILD,
		member: { user: { id: OWNER } },
		data: { custom_id: customId, component_type: 2 },
		message: { id: cardId, channel_id: THREAD },
	});
}

const cardEdits = (ts: string): Update[] =>
	transport.calls.filter((c): c is Update => c.method === "editMessage" && c.messageId === ts);
const cardText = (edit: Update | undefined): string => JSON.stringify(edit?.embeds ?? edit?.content ?? "");
const customIdsOf = (edit: Update | undefined): string[] =>
	(edit?.components ?? []).flatMap((row) =>
		((row as { components?: Array<{ custom_id?: string }> }).components ?? []).flatMap((c) =>
			c.custom_id === undefined ? [] : [c.custom_id],
		),
	);
const buttonStylesOf = (edit: Update | undefined): Array<[string | undefined, number | undefined]> =>
	(edit?.components ?? []).flatMap((row) =>
		((row as { components?: Array<{ label?: string; style?: number }> }).components ?? []).map((c) => [
			c.label,
			c.style,
		]),
	);

describe("task cancel action parser and card builders", () => {
	test("parseTaskCancelAction distinguishes prompt, confirm, keep, and rejects invalid ids", () => {
		expect(parseTaskCancelAction("jabbu:task:cancel:T-20261109-07")).toEqual({
			kind: "prompt",
			taskId: "T-20261109-07",
		});
		expect(parseTaskCancelAction("jabbu:task:cancel-confirm:T-20261109-07")).toEqual({
			kind: "confirm",
			taskId: "T-20261109-07",
		});
		expect(parseTaskCancelAction("jabbu:task:cancel-keep:T-20261109-07")).toEqual({
			kind: "keep",
			taskId: "T-20261109-07",
		});
		expect(parseTaskCancelAction("jabbu:task:cancel:bad")).toBeUndefined();
		expect(parseTaskCancelAction("jabbu:task:cancel-other:T-20261109-07")).toBeUndefined();
		expect(parseTaskCancelAction("jabbu:task:merge:T-20261109-07")).toBeUndefined();
		expect(parseTaskCancelAction("jabbu:task:recommend:T-20261109-07")).toBeUndefined();
	});

	test("all three task cards include a danger 취소 button, redacted origin value, and CANCEL_NOTE", () => {
		const row = {
			taskId: "T-20261109-07",
			title: "로그 회전",
			agent: "t-20261109-07",
			host: null,
			branch: "task/T-20261109-07",
			worktree: "/tmp/wt",
			tier: null,
			workerModel: null,
			tierReason: null,
			acceptance: acceptanceItems(["하나", "둘"]),
		} as unknown as TaskRow;

		const blockedWithRec = buildBlockedCard(row, blockedJudgement("A안 xoxb-TEST-0"), OWNER);
		expect(blockedWithRec.buttons).toEqual([
			{ actionId: taskRecommendActionId(row.taskId), label: "추천대로", value: "A안 [REDACTED]", style: "primary" },
			{ actionId: taskCancelActionId(row.taskId), label: "취소", value: "blocked:A안 [REDACTED]", style: "danger" },
		]);
		expect(blockedWithRec.note).toBe(`${RECOMMEND_NOTE} · ${CANCEL_NOTE}`);

		const blockedWithoutRec = buildBlockedCard(row, blockedJudgement(""), OWNER);
		expect(blockedWithoutRec.buttons).toEqual([
			{ actionId: taskCancelActionId(row.taskId), label: "취소", value: "blocked:", style: "danger" },
		]);
		expect(blockedWithoutRec.note).toBe(CANCEL_NOTE);

		const reachedFf = buildReachedCard(row, reachedJudgement(), OWNER);
		expect(reachedFf.buttons).toEqual([
			{ actionId: taskMergeActionId(row.taskId), label: "머지", value: row.taskId, style: "primary" },
			{ actionId: taskCancelActionId(row.taskId), label: "취소", value: "merge", style: "danger" },
		]);
		expect(reachedFf.note).toBe(`${MERGE_NOTE} · ${CANCEL_NOTE}`);

		const reachedPr = buildReachedCard(row, reachedJudgement(), OWNER, undefined, undefined, undefined, true);
		expect(reachedPr.buttons).toEqual([
			{ actionId: taskMergeActionId(row.taskId), label: "PR 올리기", value: row.taskId, style: "primary" },
			{ actionId: taskCancelActionId(row.taskId), label: "취소", value: "pr", style: "danger" },
		]);
		expect(reachedPr.note).toContain(CANCEL_NOTE);

		const reviewWait = buildReviewWaitingCard(row, 24, OWNER);
		expect(reviewWait.buttons).toEqual([
			{ actionId: taskMergeActionId(row.taskId), label: "머지", value: row.taskId, style: "primary" },
			{ actionId: taskCancelActionId(row.taskId), label: "취소", value: "merge", style: "danger" },
		]);
		expect(reviewWait.note).toBe(`${MERGE_NOTE} · ${CANCEL_NOTE}`);
	});
});

describe("TASK cancel 2-step Discord button flow", () => {
	test("blocked card (with recommendation): 취소 -> 확인 카드 -> 유지 -> 원래 버튼·추천값 복원 -> 추천대로 정상 동작", async () => {
		const row = seedTask("blocked");
		const secretRec = `${RECOMMEND} xoxb-TEST-0`;
		const cardTs = await postTaskCard(buildBlockedCard(row, blockedJudgement(secretRec), OWNER));

		await pressButton(taskCancelActionId(row.taskId), cardTs);
		const confirmEdit = cardEdits(cardTs).at(-1);
		expect(cardText(confirmEdit)).toContain("⚠️ 취소 확인 · 로그 회전");
		expect(buttonStylesOf(confirmEdit)).toEqual([
			["취소 확정", 4],
			["유지", 2],
		]);
		expect(customIdsOf(confirmEdit)).toEqual([
			taskCancelConfirmActionId(row.taskId),
			taskCancelKeepActionId(row.taskId),
		]);
		expect(daemon.store.tasks.require(row.taskId).status).toBe("blocked");

		await pressButton(taskCancelKeepActionId(row.taskId), cardTs);
		const restoredEdit = cardEdits(cardTs).at(-1);
		expect(cardText(restoredEdit)).toContain("🚧 막힘 · 로그 회전");
		expect(customIdsOf(restoredEdit)).toEqual([taskRecommendActionId(row.taskId), taskCancelActionId(row.taskId)]);

		await pressButton(taskRecommendActionId(row.taskId), cardTs);
		const inbound = daemon.store.listInbound().filter((entry) => entry.textRef.trim().startsWith("추천대로"));
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.textRef.trim()).toBe(`추천대로 (추천: ${RECOMMEND} [REDACTED])`);
		expect(cardEdits(cardTs).at(-1)?.components).toEqual([]);
	});

	test("blocked card (without recommendation): 취소 -> 유지 시 취소 버튼만 복원된다", async () => {
		const row = seedTask("blocked");
		const cardTs = await postTaskCard(buildBlockedCard(row, blockedJudgement(""), OWNER));

		await pressButton(taskCancelActionId(row.taskId), cardTs);
		await pressButton(taskCancelKeepActionId(row.taskId), cardTs);
		const restoredEdit = cardEdits(cardTs).at(-1);
		expect(customIdsOf(restoredEdit)).toEqual([taskCancelActionId(row.taskId)]);
		expect(buttonStylesOf(restoredEdit)).toEqual([["취소", 4]]);
	});

	test("blocked card: 취소 -> 취소 확정 시 human 전이·❌ 리액션·버튼 제거가 일어난다", async () => {
		const row = seedTask("blocked");
		const cardTs = await postTaskCard(buildBlockedCard(row, blockedJudgement(RECOMMEND), OWNER));

		await pressButton(taskCancelActionId(row.taskId), cardTs);
		await pressButton(taskCancelConfirmActionId(row.taskId), cardTs);

		const closed = daemon.store.tasks.require(row.taskId);
		expect(closed.status).toBe("cancelled");
		const history = daemon.store.tasks.history(row.taskId);
		expect(history.at(-1)).toMatchObject({
			fromStatus: "blocked",
			toStatus: "cancelled",
			actor: "human",
			reason: "cancel button",
		});
		const reactions = transport.calls.filter((c) => c.method === "addReaction");
		expect(reactions).toContainEqual({
			method: "addReaction",
			channelId: CHANNEL,
			messageId: THREAD,
			emoji: "❌",
		});
		const settledEdit = cardEdits(cardTs).at(-1);
		expect(cardText(settledEdit)).toContain("❌ 취소 · 로그 회전");
		expect(cardText(settledEdit)).toMatch(/❌ 취소됨 · \d\d:\d\d — 워크트리·브랜치는 그대로 남습니다/);
		expect(settledEdit?.components).toEqual([]);
		expect(logs.some((line) => line.includes("event=task_cancel_done") && line.includes("from=blocked"))).toBe(true);
		expect(logs.some((line) => line.includes("event=action_ignored"))).toBe(false);
	});

	test("review cards (PR reached & review waiting): 유지 시 원래 머지/PR 버튼이 복원되고 취소 확정 시 cancelled로 닫힌다", async () => {
		customLand = async () => ({ state: "pr-open", url: "https://github.com/acme/repo/pull/7" });
		const prRow = seedTask("review");
		const prCardTs = await postTaskCard(
			buildReachedCard(prRow, reachedJudgement(), OWNER, undefined, undefined, undefined, true),
		);
		await pressButton(taskCancelActionId(prRow.taskId), prCardTs);
		await pressButton(taskCancelKeepActionId(prRow.taskId), prCardTs);
		const prRestored = cardEdits(prCardTs).at(-1);
		expect(buttonStylesOf(prRestored)).toEqual([
			["PR 올리기", 1],
			["취소", 4],
		]);
		await pressButton(taskMergeActionId(prRow.taskId), prCardTs);
		expect(landCalls).toBe(1);

		const waitRow = seedTask("review");
		const waitCardTs = await postTaskCard(buildReviewWaitingCard(waitRow, 24, OWNER));
		await pressButton(taskCancelActionId(waitRow.taskId), waitCardTs);
		await pressButton(taskCancelConfirmActionId(waitRow.taskId), waitCardTs);
		expect(daemon.store.tasks.require(waitRow.taskId).status).toBe("cancelled");
		expect(daemon.store.tasks.history(waitRow.taskId).at(-1)).toMatchObject({
			fromStatus: "review",
			toStatus: "cancelled",
			actor: "human",
		});
		expect(logs.some((line) => line.includes("event=task_cancel_done") && line.includes("from=review"))).toBe(true);
	});

	test("edge cases: concurrent confirm duplicate, closed/missing task, in-flight landing, and draining daemon", async () => {
		const row1 = seedTask("blocked");
		const card1 = await postTaskCard(buildBlockedCard(row1, blockedJudgement(RECOMMEND), OWNER));
		await pressButton(taskCancelActionId(row1.taskId), card1);
		await Promise.all([
			pressButton(taskCancelConfirmActionId(row1.taskId), card1),
			pressButton(taskCancelConfirmActionId(row1.taskId), card1),
		]);
		expect(logs.filter((l) => l.includes("event=task_cancel_done") && l.includes(row1.taskId))).toHaveLength(1);
		expect(logs.filter((l) => l.includes("event=task_cancel_ignored") && l.includes("reason=duplicate"))).toHaveLength(
			1,
		);

		// Closed (done/cancelled) and missing tasks clear buttons and log ignored.
		const doneRow = seedTask("review");
		const doneCard = await postTaskCard(buildReviewWaitingCard(doneRow, 24, OWNER));
		daemon.store.tasks.transition(doneRow.taskId, "done", "human", "done");
		await pressButton(taskCancelActionId(doneRow.taskId), doneCard);
		expect(cardEdits(doneCard).at(-1)?.components).toEqual([]);
		expect(cardText(cardEdits(doneCard).at(-1))).toContain("이미 닫힌 작업입니다 (done)");

		await pressButton(taskCancelKeepActionId(row1.taskId), card1);
		expect(logs.filter((l) => l.includes("event=task_cancel_keep_ignored"))).toHaveLength(1);

		const missingCard = await postTaskCard(buildReviewWaitingCard(doneRow, 24, OWNER));
		await pressButton(taskCancelConfirmActionId("T-20991231-99"), missingCard);
		expect(cardEdits(missingCard).at(-1)).toMatchObject({
			content: "⚠️ 이 TASK를 찾을 수 없음 (T-20991231-99)",
			components: [],
		});

		// In-flight landing blocks cancel prompt & confirm without disturbing landing.
		let markStarted!: () => void;
		const landStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let finishLand!: (result: TaskLandResult) => void;
		const landWait = new Promise<TaskLandResult>((resolve) => {
			finishLand = resolve;
		});
		customLand = async () => {
			markStarted();
			return landWait;
		};
		const flightRow = seedTask("review");
		const mergeCard = await postTaskCard(buildReachedCard(flightRow, reachedJudgement(), OWNER));
		const otherCard = await postTaskCard(buildReviewWaitingCard(flightRow, 24, OWNER));
		const mergePending = pressButton(taskMergeActionId(flightRow.taskId), mergeCard);
		await landStarted;

		await pressButton(taskCancelActionId(flightRow.taskId), otherCard);
		expect(cardText(cardEdits(otherCard).at(-1))).toContain("이미 착지 중이라 취소할 수 없음");
		expect(cardEdits(otherCard).at(-1)?.components).toEqual([]);
		expect(logs.some((l) => l.includes("event=task_cancel_ignored") && l.includes("reason=in_flight"))).toBe(true);

		finishLand({ state: "pr-open", url: "https://github.com/acme/repo/pull/9" });
		await mergePending;
		expect(cardEdits(mergeCard).at(-1)?.components).toEqual([]);

		// Draining refuses confirm without marking card permanently settled.
		const drainRow = seedTask("blocked");
		const drainCard = await postTaskCard(buildBlockedCard(drainRow, blockedJudgement(""), OWNER));
		await pressButton(taskCancelActionId(drainRow.taskId), drainCard);
		daemon.setDraining(true);
		await pressButton(taskCancelConfirmActionId(drainRow.taskId), drainCard);
		daemon.setDraining(false);
		expect(daemon.store.tasks.require(drainRow.taskId).status).toBe("blocked");
		expect(cardText(cardEdits(drainCard).at(-1))).toContain("재시작 준비 중이라 취소를 받지 않음");
		expect(logs.some((l) => l.includes("event=task_cancel_ignored") && l.includes("reason=draining"))).toBe(true);
	});
});
