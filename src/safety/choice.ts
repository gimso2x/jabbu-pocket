import { cutCodePointSafe } from "../channel/text";
import type { OmpDialogRequest, OmpDialogResponse } from "../omp/driver";
import type { ApprovalBroker, ApprovalOrigin } from "./approval";
import { type AskAnswer, answerLine, applyAskEvent, askAcceptsText, askButtons, askText, numbered } from "./choice-ask";
import { CANCELLED_LINE, deadlineOf, endUnanswered, MAX_CHOICE_BUTTONS, optionOf } from "./choice-common";
import { ASK_FALLBACK, ASK_TIMEOUT_LINE } from "./choice-types";
import { answerForm } from "./form-choice";

const REPLY_HINT = "버튼을 누르거나 이 스레드에 답장해 주세요";
const OPTION_ONLY_HINT = "↪ 번호나 선택지 이름으로 답해 주세요";
/**
 * omp's free-text row of a select (`askChoice`), fixed wording; picking it makes omp open an `input` next. Only this
 * exact last row counts: a model-made label that merely ends the same way must not make the card take free text.
 */
const OTHER_ROW = "Other (type your own)";
/** Splits a select row `label — description`: the button shows the label, the card text lists the whole row. */
const DESCRIPTION_SEP = " — ";
const YES = /^(예|네|응|ㅇㅇ|ㅇ|좋아|yes|y|ok|확인)$/i;

/** A multi-select row's marker: its checkbox state, or "▶" for an action row (Done, Other) past `markableCount`. */
function checkMarkOf(request: Extract<OmpDialogRequest, { method: "select" }>, index: number): string {
	if (index >= (request.markableCount ?? request.options.length)) return "▶";
	return request.checkedIndices?.includes(index) === true ? "☑" : "☐";
}

async function answerSelect(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "select" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const { options } = request;
	if (options.length === 0) return { cancelled: true };
	const asButtons = options.length <= MAX_CHOICE_BUTTONS;
	// omp's select rows carry no description field; a row written with DESCRIPTION_SEP brings its own.
	const heads = options.map((option) => {
		const at = option.indexOf(DESCRIPTION_SEP);
		return at > 0 ? option.slice(0, at) : option;
	});
	const multi = request.selectionMarker === "checkbox";
	const rows = options.map((option, index) => {
		const description = request.descriptions?.[index];
		const row = description === undefined ? option : `${option}${DESCRIPTION_SEP}${description}`;
		return multi && request.checkedIndices !== undefined ? `${checkMarkOf(request, index)} ${row}` : row;
	});
	const described = rows.some((row, index) => row !== heads[index]);
	const text = asButtons
		? `❓ ${request.title}\n${described ? `${numbered(rows)}\n` : ""}${REPLY_HINT}`
		: `❓ ${request.title}\n${numbered(rows)}\n번호로 이 스레드에 답장해 주세요`;
	// omp's own "other" row is its last row. Without one (a tool approval) or in a multi-select (omp marks its rows
	// "checkbox"; a required one has no "Done" row to tell it by) a text naming no option is not an answer: the card
	// refuses it and stays open. A blank text never picks "Other": omp would reopen its input loop on it.
	const other = !multi && options.at(-1) === OTHER_ROW ? OTHER_ROW : undefined;
	const card = await broker.choose(
		origin,
		{
			text,
			buttons: asButtons ? heads : [],
			fallback: "취소",
			timeoutMs: deadlineOf(request),
			acceptsText: (reply: string) =>
				other === undefined ? (optionOf(options, reply) ?? optionOf(heads, reply)) !== undefined : reply.trim() !== "",
			rejectHint: OPTION_ONLY_HINT,
		},
		{ signal },
	);
	const result = await card.next();
	if (result.kind === "timeout" || result.kind === "cancelled") return endUnanswered(card, result.kind, "취소");
	const reply = result.kind === "text" ? result.text.trim() : "";
	const index = result.kind === "choice" ? result.index : (optionOf(options, reply) ?? optionOf(heads, reply));
	const picked = index === undefined ? undefined : options[index];
	if (picked === undefined && other !== undefined) {
		// Text outside the options: pick the "other" row, and answer the `input` omp opens next with the text itself.
		broker.holdInput(origin.originKey, origin.opRef, reply);
		await card.close(`✅ 선택: 기타 — ${cutCodePointSafe(reply.replace(/\s+/g, " "), 40)}`, other);
		return { value: other };
	}
	const value = picked ?? reply;
	await card.close(`✅ 선택: ${value}`, value);
	return { value };
}

async function answerConfirm(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "confirm" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const card = await broker.choose(
		origin,
		{
			text: `❓ ${request.title}\n${request.message}\n${REPLY_HINT}`,
			buttons: ["예", "아니오"],
			// omp reads a timed-out (or withdrawn) confirm as `false`: the owner sees that outcome, not a cancel.
			fallback: "아니오",
			timeoutMs: deadlineOf(request),
		},
		{ signal },
	);
	const result = await card.next();
	if (result.kind === "timeout" || result.kind === "cancelled") return endUnanswered(card, result.kind, "아니오");
	// Anything but a clear yes is a no (fail-closed).
	const confirmed = result.kind === "choice" ? result.index === 0 : YES.test(result.text.trim());
	const label = confirmed ? "예" : "아니오";
	await card.close(`✅ 선택: ${label}`, label);
	return { confirmed };
}

async function answerText(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "input" | "editor" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	if (request.method === "input" && request.secret === true) {
		const card = await broker.choose(
			origin,
			{
				text: `🔒 ${request.title}\n비밀값은 채팅에 쓰지 마세요 — 이 입력은 취소합니다`,
				buttons: [],
				fallback: "취소",
			},
			{ signal },
		);
		await card.close(CANCELLED_LINE);
		return { cancelled: true };
	}
	const hint = request.method === "input" ? request.placeholder : request.prefill && "(편집할 기존 내용 있음)";
	const card = await broker.choose(
		origin,
		{
			text: `❓ ${request.title}${hint === undefined || hint === "" ? "" : `\n${hint}`}\n이 스레드에 답장해 주세요`,
			buttons: [],
			fallback: "취소",
			timeoutMs: deadlineOf(request),
		},
		{ signal },
	);
	for (;;) {
		const result = await card.next();
		if (result.kind === "timeout" || result.kind === "cancelled") return endUnanswered(card, result.kind, "취소");
		if (result.kind !== "text") continue; // no buttons on this card; a stale click is not an answer
		await card.close("✅ 답장을 받았습니다", result.text);
		return { value: result.text };
	}
}

async function answerAsk(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "ask" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const { questions } = request;
	const answers: Array<AskAnswer | undefined> = questions.map(() => undefined);
	const buttons = askButtons(questions);
	const labels = buttons.map((button) => button.label);
	const buttoned = new Set(buttons.map((button) => button.question));
	const recommended = buttons.flatMap((button, index) =>
		questions[button.question]?.recommended === button.option ? [index] : [],
	);
	const card = await broker.choose(
		origin,
		{
			text: askText(questions, answers, buttoned),
			buttons: labels,
			recommended,
			fallback: ASK_FALLBACK,
			timeoutMs: deadlineOf(request),
			acceptsText: (reply: string) => askAcceptsText(questions, answers, reply),
			rejectHint: OPTION_ONLY_HINT,
		},
		{ signal },
	);
	const toResponse = (): OmpDialogResponse => ({
		answers: questions.map((question, q) => {
			const answer = answers[q] ?? { selectedOptions: [] };
			return {
				id: question.id,
				selectedOptions: answer.selectedOptions,
				...(answer.customInput === undefined ? {} : { customInput: answer.customInput }),
			};
		}),
	});
	const summary = () =>
		questions.map((_question, q) => `${q + 1}) ${answerLine(answers[q] ?? { selectedOptions: [] })}`).join(" · ");
	for (;;) {
		const result = await card.next();
		if (result.kind === "cancelled") return endUnanswered(card, "cancelled", ASK_FALLBACK);
		if (result.kind === "timeout") {
			const untouched = answers.every((answer) => answer === undefined);
			const autoPicked: Array<{ question: string; chosen: string }> = [];
			// omp's own fallback, so the card says what omp picks.
			questions.forEach((question, q) => {
				if (answers[q] !== undefined) return;
				// Clamped into the option range, as omp's `timedOutAskDialogResult` does.
				const pick = Math.min(Math.max(question.recommended ?? 0, 0), question.options.length - 1);
				const label = question.options[pick]?.label;
				answers[q] = { selectedOptions: label === undefined ? [] : [label] };
				if (label !== undefined) autoPicked.push({ question: question.question, chosen: label });
			});
			broker.recordAutoChoices(origin, autoPicked);
			// Nothing answered: omp fills every question itself and marks the result `timedOut` for the model.
			// Partly answered: the owner's answers go back as they are, the rest as omp would fill them.
			await card.close(`${ASK_TIMEOUT_LINE} — ${summary()}`, untouched ? undefined : summary());
			return untouched ? { cancelled: true, timedOut: true } : toResponse();
		}
		applyAskEvent(questions, answers, buttons, result);
		if (answers.every((answer) => answer !== undefined)) {
			await card.close(`✅ 답: ${summary()}`, summary());
			return toResponse();
		}
		await card.update(askText(questions, answers, buttoned), labels);
	}
}

/**
 * Puts one omp dialog to the owner as a choice card in `origin`'s conversation and returns the omp response.
 * select/confirm get buttons (a numbered list past `MAX_CHOICE_BUTTONS`), input/editor take a reply, ask gets one
 * block per question, a form (omp 19.1 ask) gets `answerForm`'s own card; a secret input is cancelled at once, since a secret must never be typed into chat.
 */
export function answerDialog(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: OmpDialogRequest,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	// A text held behind an "Other" row answers the very next plain `input`, and nothing else.
	const held =
		request.method === "input" && request.secret !== true
			? broker.takeInput(origin.originKey, origin.opRef)
			: undefined;
	if (held !== undefined) return Promise.resolve({ value: held });
	broker.dropInput(origin.originKey, `next_dialog_${request.method}`);
	switch (request.method) {
		case "select":
			return answerSelect(broker, origin, request, signal);
		case "confirm":
			return answerConfirm(broker, origin, request, signal);
		case "input":
		case "editor":
			return answerText(broker, origin, request, signal);
		case "ask":
			return answerAsk(broker, origin, request, signal);
		case "form":
			return answerForm(broker, origin, request, signal);
	}
}
