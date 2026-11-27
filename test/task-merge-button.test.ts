import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon/daemon";
import { DiscordBinding } from "../src/discord/binding";
import { DiscordChannel } from "../src/discord/channel";
import { DiscordCallError } from "../src/discord/transport";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import type { TaskJudgement } from "../src/tasks/checker";
import { acceptanceItems } from "../src/tasks/docs";
import { landTask, type TaskLandResult } from "../src/tasks/land";
import type { TaskRow } from "../src/tasks/ledger";
import {
	buildBlockedCard,
	buildReviewWaitingCard,
	cardMessage,
	parseTaskRecommendActionId,
	taskLandNote,
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
/** What the core landing answers when a test sets it (the real `landTask` otherwise). */
let landAnswer: TaskLandResult | undefined;
/** How often the core landing was asked. */
let landCalls: number;

beforeEach(async () => {
	home = makeHome("jabbu-merge-button-");
	logs = [];
	landAnswer = undefined;
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
			return landAnswer ?? landTask(row, deps);
		},
		driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
	});
	await daemon.start();
});

afterEach(async () => {
	await daemon.stop();
	home.remove();
});

const judged = (recommend: string) =>
	({
		blockedReason: "DB 경로를 정해야 함",
		decision: { question: "어느 경로?", recommend, impact: "재시작 필요" },
		current: "S2",
	}) as unknown as TaskJudgement;

/** The ledger row's card as the bot posts it in the task thread: a blocked task's carries 추천대로, any other 머지. */
async function postCard(row: TaskRow): Promise<string> {
	const card =
		row.status === "blocked" ? buildBlockedCard(row, judged(RECOMMEND), OWNER) : buildReviewWaitingCard(row, 24, OWNER);
	const posted = await port.post({ conversationId: CHANNEL, threadId: THREAD }, cardMessage(card, port));
	return posted.messageId;
}

/** A registered [TASK] in `status`, its thread `threadRef`, and the id of its card posted in that thread. */
async function seedTask(status: TaskRow["status"], threadRef = `${CHANNEL}:${THREAD}`) {
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
	return { taskId: row.taskId, cardTs: await postCard(tasks.require(row.taskId)) };
}

let interactionSeq = 0n;
function pressButton(customId: string, cardId: string): Promise<void> {
	interactionSeq += 1n;
	return transport.emitInteraction({
		id: String(800_000_000_000_000_000n + interactionSeq),
		application_id: "600000000000000000",
		type: 3,
		token: `token-${interactionSeq}`,
		channel_id: THREAD,
		guild_id: GUILD,
		member: { user: { id: OWNER } },
		data: { custom_id: customId, component_type: 2 },
		message: { id: cardId, channel_id: THREAD },
	});
}

const click = (taskId: string, cardTs: string): Promise<void> => pressButton(`jabbu:task:merge:${taskId}`, cardTs);

const markerFailure = () => new DiscordCallError("definitive", "discord_http_404:10003 Unknown Channel", 404, 10003);

const markers = () => transport.posts((text: string) => text === "🔘 머지 (버튼)");
const mergeInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim() === "머지해");
const cardEdits = (ts: string): Update[] =>
	transport.calls.filter((c): c is Update => c.method === "editMessage" && c.messageId === ts);
/** The card's embed (header, fields, note) or, for a plain redraw, its content, as one string. */
const cardText = (edit: Update | undefined): string => JSON.stringify(edit?.embeds ?? edit?.content ?? "");

describe("TASK merge button", () => {
	test("a click on a review task's card: one 🔘 marker and one owner '머지해' in the task thread; the card keeps header and fields, loses the button", async () => {
		const { taskId, cardTs } = await seedTask("review");
		await click(taskId, cardTs);
		expect(markers()).toHaveLength(1);
		expect(markers()[0]).toMatchObject({ channelId: THREAD });
		const inbound = mergeInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({ threadRef: `${CHANNEL}:${THREAD}` });
		const last = cardEdits(cardTs).at(-1);
		const embed = last?.embeds?.[0] as { title?: string; fields?: unknown[] } | undefined;
		expect(embed?.title).toBe("🔍 머지 대기 · 로그 회전");
		expect(embed?.fields?.length).toBeGreaterThan(0);
		expect(last?.components).toEqual([]);
		// The core could not land it (no worktree): the note says so before "머지해" went in.
		expect(cardText(last)).toMatch(/▶ 머지 요청됨 · \d\d:\d\d — 코어가 넘김: worktree 없음: /);
		expect(logs.some((l) => l.includes("event=action_ignored"))).toBe(false);
	});

	test("two clicks on the same card without awaiting the first: one inbound, the second is a logged duplicate", async () => {
		const { taskId, cardTs } = await seedTask("review");
		await Promise.all([click(taskId, cardTs), click(taskId, cardTs)]);
		expect(markers()).toHaveLength(1);
		expect(mergeInbounds()).toHaveLength(1);
		expect(logs.filter((l) => l.includes("event=task_merge_ignored") && l.includes("reason=duplicate"))).toHaveLength(
			1,
		);
	});

	test("a task not in review and a task that does not exist: no inbound, task_merge_ignored, the card loses its button", async () => {
		const working = await seedTask("working");
		await click(working.taskId, working.cardTs);
		expect(cardText(cardEdits(working.cardTs).at(-1))).toContain("이미 처리됐거나 머지할 상태가 아님 (working)");
		const missingCard = await postCard(daemon.store.tasks.require(working.taskId));
		await click("T-20991231-99", missingCard);
		expect(cardEdits(missingCard).at(-1)).toMatchObject({
			content: "⚠️ 이 TASK를 찾을 수 없음 (T-20991231-99)",
			components: [],
		});
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=task_merge_ignored"))).toHaveLength(2);
	});

	test("a thread ref that does not parse: no inbound, task_merge_inject_rejected, the card says the request did not go in", async () => {
		const { taskId, cardTs } = await seedTask("review", "not-a-thread");
		await click(taskId, cardTs);
		expect(markers()).toHaveLength(0);
		expect(mergeInbounds()).toHaveLength(0);
		expect(logs.some((l) => l.includes("event=task_merge_inject_rejected") && l.includes("reason=bad_thread"))).toBe(
			true,
		);
		expect(cardText(cardEdits(cardTs).at(-1))).toContain("⚠️ 머지 요청을 넣지 못함");
	});

	test("the marker post fails: no inbound, task_merge_inject_rejected, the card note turns into the reply hint", async () => {
		const { taskId, cardTs } = await seedTask("review");
		transport.failNext.createMessage = [markerFailure()];
		await click(taskId, cardTs);
		expect(mergeInbounds()).toHaveLength(0);
		const rejected = logs.filter((l) => l.includes("event=task_merge_inject_rejected"));
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toContain("reason=error");
		expect(rejected[0]).not.toContain("marker=");
		const edits = cardEdits(cardTs);
		expect(cardText(edits[0])).toMatch(/▶ 머지 요청됨/);
		expect(cardText(edits.at(-1))).toContain("⚠️ 머지 요청을 넣지 못함");
	});
});

describe("TASK merge button: PR 착지 결과(pr 모드)는 카드 노트만 바꾼다", () => {
	const URL = "https://github.com/acme/widgets/pull/7";
	const answers: Array<[string, TaskLandResult]> = [
		["pr-open", { state: "pr-open", url: URL }],
		["rework", { state: "rework", reason: "CI 실패: test" }],
	];

	test.each(answers)(
		"%s: 스레드에 카드·마커·'머지해'를 더 올리지 않고 카드 노트가 결과 문구로 바뀌며 버튼은 빠진다",
		async (_name, answer) => {
			landAnswer = answer;
			const { taskId, cardTs } = await seedTask("review");
			const postsBefore = transport.calls.filter((c) => c.method === "createMessage").length;
			await click(taskId, cardTs);
			expect(transport.calls.filter((c) => c.method === "createMessage")).toHaveLength(postsBefore);
			expect(markers()).toHaveLength(0);
			expect(mergeInbounds()).toHaveLength(0);
			const last = cardEdits(cardTs).at(-1);
			expect(last?.components).toEqual([]);
			expect(cardText(last)).toContain(taskLandNote(answer));
			expect(cardText(last)).not.toMatch(/ff merge|push origin/);
			expect(cardText(last)).toContain("🔍 머지 대기 · 로그 회전");
		},
	);
});

describe("TASK merge button: 막힌 PR 착지는 다시 시도 버튼을 남긴다", () => {
	const stopped = (taskId: string, state: "blocked" | "held" | "active" | "rework") =>
		daemon.store.tasks.setLand(taskId, {
			mode: "pr",
			state,
			requestedBy: "owner",
			sha: "a".repeat(40),
			baseBranch: "main",
			reason: "누출 검사 실패",
			prLand: { branch: "task/x" },
		});
	const buttons = (edit: Update | undefined): string => JSON.stringify(edit?.components ?? []);

	test.each(["blocked", "held"] as const)(
		"PR %s 기록으로 끝난 클릭: 카드에 머지(PR 다시 올리기) 버튼이 남고 두 번째 클릭이 착지를 다시 부른다",
		async (state) => {
			landAnswer = { state: "blocked", reason: "누출 검사 실패" };
			const { taskId, cardTs } = await seedTask("review");
			stopped(taskId, state);
			await click(taskId, cardTs);
			const last = cardEdits(cardTs).at(-1);
			expect(buttons(last)).toContain(`jabbu:task:merge:${taskId}`);
			expect(buttons(last)).toContain("PR 다시 올리기");
			expect(cardText(last)).toContain(taskLandNote(landAnswer));
			expect(landCalls).toBe(1);
			await click(taskId, cardTs);
			expect(landCalls).toBe(2);
			expect(buttons(cardEdits(cardTs).at(-1))).toContain("PR 다시 올리기");
			expect(logs.some((l) => l.includes("event=task_merge_ignored") && l.includes("reason=duplicate"))).toBe(false);
			expect(markers()).toHaveLength(0);
		},
	);

	test("한 번 더 막힌 뒤 landed로 끝나면 버튼이 빠진다", async () => {
		landAnswer = { state: "blocked", reason: "누출 검사 실패" };
		const { taskId, cardTs } = await seedTask("review");
		stopped(taskId, "blocked");
		await click(taskId, cardTs);
		landAnswer = { state: "pr-open", url: "https://github.com/acme/widgets/pull/7" };
		stopped(taskId, "active");
		await click(taskId, cardTs);
		expect(landCalls).toBe(2);
		expect(buttons(cardEdits(cardTs).at(-1))).toBe("[]");
	});

	test.each([
		["ff blocked(PR 기록 없음)", { state: "blocked", reason: "dirty" }, undefined],
		["pr-open", { state: "pr-open", url: "https://github.com/acme/widgets/pull/7" }, "active"],
		["rework", { state: "rework", reason: "CI 실패" }, "rework"],
		["handoff", { state: "handoff", reason: "원격" }, undefined],
		["landed", { state: "landed", baseBranch: "main", sha: "a".repeat(40), notes: [] }, "active"],
	] as const)("%s: 버튼이 없고 같은 카드를 두 번 누르면 두 번째는 무시된다", async (_name, answer, record) => {
		landAnswer = answer as TaskLandResult;
		const { taskId, cardTs } = await seedTask("review");
		if (record !== undefined) stopped(taskId, record);
		await click(taskId, cardTs);
		expect(buttons(cardEdits(cardTs).at(-1))).toBe("[]");
		await click(taskId, cardTs);
		expect(landCalls).toBe(1);
	});

	test("잘못된 상태(working)의 클릭에는 버튼이 없다", async () => {
		const { taskId, cardTs } = await seedTask("working");
		stopped(taskId, "blocked");
		await click(taskId, cardTs);
		expect(buttons(cardEdits(cardTs).at(-1))).toBe("[]");
		expect(landCalls).toBe(0);
	});
});

describe("blocked card: 추천대로 button", () => {
	const row = {
		taskId: "T-20261109-07",
		title: "로그 회전",
		agent: "t-20261109-07",
		host: null,
		branch: "task/T-20261109-07",
	} as unknown as TaskRow;
	test("a recommendation gives primary 추천대로 and danger 취소 buttons; without recommendation only 취소 appears", () => {
		const card = buildBlockedCard(row, judged("A안: /var/lib xoxb-TEST-0"), OWNER, "https://board/x");
		expect(card.buttons).toEqual([
			{
				actionId: "jabbu:task:recommend:T-20261109-07",
				label: "추천대로",
				value: "A안: /var/lib [REDACTED]",
				style: "primary",
			},
			{
				actionId: "jabbu:task:cancel:T-20261109-07",
				label: "취소",
				value: "blocked:A안: /var/lib [REDACTED]",
				style: "danger",
			},
		]);
		expect(card.note).toBe(
			"추천대로 = 위 추천 그대로 진행 · 다른 결정은 이 스레드에 답장 · 취소 = 작업 중단(워크트리·브랜치 보존) · 작업 보드: https://board/x",
		);
		expect(parseTaskRecommendActionId("jabbu:task:recommend:T-20261109-07")).toBe("T-20261109-07");
		expect(parseTaskRecommendActionId("jabbu:task:merge:T-20261109-07")).toBeUndefined();
		const without = buildBlockedCard(row, judged(""), OWNER);
		expect(without.buttons).toEqual([
			{
				actionId: "jabbu:task:cancel:T-20261109-07",
				label: "취소",
				value: "blocked:",
				style: "danger",
			},
		]);
		expect(without.note).toBe("취소 = 작업 중단(워크트리·브랜치 보존)");
	});

	test("a block that already had its retry prompt says so at the end of the reason line", () => {
		const card = buildBlockedCard(row, judged(""), OWNER, undefined, true);
		expect(card.text.split("\n")).toContain("*사유*: DB 경로를 정해야 함 (재도전 1회 뒤)");
		expect(card.body?.split("\n")[0]).toBe("*사유*: DB 경로를 정해야 함 (재도전 1회 뒤)");
		expect(buildBlockedCard(row, judged(""), OWNER).text).not.toContain("재도전");
	});

	test("the blocked card text is byte for byte what it was before the button", () => {
		expect(buildBlockedCard(row, judged("A안: /var/lib"), OWNER, "https://board/x").text).toBe(
			`🚧 멈춤 · 로그 회전 — 결정이 필요합니다. (local/t-20261109-07 · T-20261109-07) {{mention:${OWNER}}}\n\n*사유*: DB 경로를 정해야 함\n*질문*: 어느 경로?\n*추천*: A안: /var/lib\n*영향*: 재시작 필요\n*지금 단계*: S2\n*답하는 법*: 이 스레드에 결정을 적어 주시면 그 답을 담당 에이전트에 넘겨 재개합니다.\n\n작업 보드\nhttps://board/x`,
		);
		expect(buildBlockedCard(row, judged(""), OWNER).text).toBe(
			`🚧 멈춤 · 로그 회전 — 결정이 필요합니다. (local/t-20261109-07 · T-20261109-07) {{mention:${OWNER}}}\n\n*사유*: DB 경로를 정해야 함\n*질문*: 어느 경로?\n*영향*: 재시작 필요\n*지금 단계*: S2\n*답하는 법*: 이 스레드에 결정을 적어 주시면 그 답을 담당 에이전트에 넘겨 재개합니다.`,
		);
	});
});

describe("TASK recommend button (막힘 카드 추천대로)", () => {
	const recommendClick = (taskId: string, cardTs: string): Promise<void> =>
		pressButton(`jabbu:task:recommend:${taskId}`, cardTs);
	const recommendMarkers = () => transport.posts((text: string) => text === "🔘 추천대로 (버튼)");
	const recommendInbounds = () => daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("추천대로"));

	test("a click on a blocked task's card: one 🔘 marker and one owner '추천대로 (추천: …)' in the task thread; the card loses its button and keeps the recommendation in its note", async () => {
		const { taskId, cardTs } = await seedTask("blocked");
		await recommendClick(taskId, cardTs);
		expect(recommendMarkers()).toHaveLength(1);
		expect(recommendMarkers()[0]).toMatchObject({ channelId: THREAD });
		const inbound = recommendInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.textRef.trim().startsWith(`추천대로 (추천: ${RECOMMEND})`)).toBe(true);
		expect(inbound[0]).toMatchObject({ threadRef: `${CHANNEL}:${THREAD}` });
		const last = cardEdits(cardTs).at(-1);
		const embed = last?.embeds?.[0] as { title?: string } | undefined;
		expect(embed?.title).toBe("🚧 막힘 · 로그 회전");
		expect(last?.components).toEqual([]);
		expect(cardText(last)).toMatch(/▶ 추천대로 진행 요청됨 · \d\d:\d\d — 추천: A안: 캐시를 끄고 다시 측정/);
		expect(logs.some((l) => l.includes("event=action_ignored"))).toBe(false);
	});

	test("two clicks on the same card without awaiting the first: one inbound, the second is a logged duplicate", async () => {
		const { taskId, cardTs } = await seedTask("blocked");
		await Promise.all([recommendClick(taskId, cardTs), recommendClick(taskId, cardTs)]);
		expect(recommendMarkers()).toHaveLength(1);
		expect(recommendInbounds()).toHaveLength(1);
		expect(
			logs.filter((l) => l.includes("event=task_recommend_ignored") && l.includes("reason=duplicate")),
		).toHaveLength(1);
	});

	test("a task that is not blocked and a task that does not exist: no inbound, the card note says it is already handled", async () => {
		const working = await seedTask("working");
		await recommendClick(working.taskId, working.cardTs);
		expect(cardText(cardEdits(working.cardTs).at(-1))).toContain("이미 처리됐거나 막힌 상태가 아님 (working)");
		const missingCard = await postCard(daemon.store.tasks.require(working.taskId));
		await recommendClick("T-20991231-99", missingCard);
		const missingEdit = cardEdits(missingCard).at(-1);
		expect(missingEdit?.content).toStartWith("이미 처리됐거나");
		expect(missingEdit?.components).toEqual([]);
		expect(recommendMarkers()).toHaveLength(0);
		expect(recommendInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=task_recommend_ignored"))).toHaveLength(2);
	});

	test("a thread ref that does not parse: no inbound, task_recommend_inject_rejected, the card says the recommendation did not go in", async () => {
		const { taskId, cardTs } = await seedTask("blocked", "not-a-thread");
		await recommendClick(taskId, cardTs);
		expect(recommendMarkers()).toHaveLength(0);
		expect(recommendInbounds()).toHaveLength(0);
		expect(
			logs.some((l) => l.includes("event=task_recommend_inject_rejected") && l.includes("reason=bad_thread")),
		).toBe(true);
		expect(cardText(cardEdits(cardTs).at(-1))).toContain("⚠️ 추천을 넣지 못함");
	});

	test("the marker post fails: no inbound, task_recommend_inject_rejected, the card note turns into the reply hint", async () => {
		const { taskId, cardTs } = await seedTask("blocked");
		transport.failNext.createMessage = [markerFailure()];
		await recommendClick(taskId, cardTs);
		expect(recommendInbounds()).toHaveLength(0);
		const rejected = logs.filter((l) => l.includes("event=task_recommend_inject_rejected"));
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toContain("reason=error");
		const edits = cardEdits(cardTs);
		expect(cardText(edits[0])).toMatch(/▶ 추천대로 진행 요청됨/);
		expect(cardText(edits.at(-1))).toContain("⚠️ 추천을 넣지 못함");
	});
});
