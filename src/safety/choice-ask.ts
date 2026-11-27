import { cutCodePointSafe } from "../channel/text";
import type { OmpAskQuestion } from "../omp/driver";
import { MAX_CARD_BUTTONS, MAX_CHOICE_BUTTONS, optionOf } from "./choice-common";
import type { ChoiceEvent } from "./choice-types";

export interface AskAnswer {
	selectedOptions: string[];
	customInput?: string;
}

const ASK_TEXT_LIMIT = 2850;

/** `1. label` lines of a numbered option list; the recommended one is marked. */
export function numbered(labels: readonly string[], recommended?: number): string {
	return labels.map((label, index) => `${index + 1}. ${label}${index === recommended ? " (추천)" : ""}`).join("\n");
}

/**
 * Buttons of an `ask` card, with the question each one answers: drawn once per card, so a click's index means the
 * same button for the card's whole life. Single-select questions with at most `MAX_CHOICE_BUTTONS` options get
 * buttons while the card stays within `MAX_CARD_BUTTONS`; the rest are answered by number.
 */
export function askButtons(
	questions: readonly OmpAskQuestion[],
): Array<{ label: string; question: number; option: number }> {
	const many = questions.length > 1;
	const buttons: Array<{ label: string; question: number; option: number }> = [];
	questions.forEach((question, q) => {
		if (question.multi === true || question.options.length > MAX_CHOICE_BUTTONS) return;
		if (buttons.length + question.options.length > MAX_CARD_BUTTONS) return;
		question.options.forEach((option, o) => {
			buttons.push({ label: many ? `${q + 1}. ${option.label}` : option.label, question: q, option: o });
		});
	});
	return buttons;
}

export function answerLine(answer: AskAnswer): string {
	return (
		[...answer.selectedOptions, ...(answer.customInput === undefined ? [] : [answer.customInput])].join(", ") ||
		"(빈 답)"
	);
}

/**
 * The `ask` card body: one block per question, answered ones show their answer. When all blocks exceed `limit`, keeps
 * whole question blocks in a sliding window anchored on the first unanswered question and reports remaining count.
 */
export function askText(
	questions: readonly OmpAskQuestion[],
	answers: ReadonlyArray<AskAnswer | undefined>,
	buttoned: ReadonlySet<number>,
	limit = ASK_TEXT_LIMIT,
): string {
	const blocks = questions.map((question, q) => {
		const head = `*${q + 1}. ${question.header === undefined ? "" : `[${question.header}] `}${question.question}*`;
		const answer = answers[q];
		if (answer !== undefined) return `${head}\n→ ${answerLine(answer)}`;
		const labels = question.options.map((option) =>
			option.description === undefined ? option.label : `${option.label} — ${option.description}`,
		);
		const how =
			question.multi === true
				? "번호를 쉼표로 답장해 주세요(예: 1,3)"
				: buttoned.has(q)
					? "버튼을 누르거나 번호로 답장해 주세요"
					: "번호로 답장해 주세요";
		return `${head}\n${numbered(labels, question.recommended)}\n${how}`;
	});
	const header = `❓ 질문 ${questions.length}개 — 답하지 않은 첫 질문부터 답장이 채워집니다`;
	const full = `${header}\n${blocks.join("\n\n")}`;
	if (full.length <= limit || blocks.length === 0) return full;

	const fitWindow = (start: number): { end: number; text: string } => {
		const prefix = start > 0 ? `${header}\n✅ 1~${start}번 답변 완료` : header;
		const footer = (endIdx: number) =>
			endIdx < blocks.length - 1
				? `\n\n… 외 질문 ${blocks.length - 1 - endIdx}개 (앞 질문에 답하면 이어서 표시됩니다)`
				: "";
		let out = prefix;
		let end = start - 1;
		for (let i = start; i < blocks.length; i++) {
			const sep = i === start ? "\n" : "\n\n";
			const candidate = `${out}${sep}${blocks[i]}`;
			if (candidate.length + footer(i).length > limit) break;
			out = candidate;
			end = i;
		}
		if (end < start) {
			const tail = footer(start);
			const avail = Math.max(1, limit - prefix.length - 1 - tail.length);
			out = `${prefix}\n${cutCodePointSafe(blocks[start] ?? "", avail)}`;
			end = start;
		}
		return { end, text: `${out}${footer(end)}` };
	};

	const firstOpen = answers.indexOf(undefined);
	const win = fitWindow(0);
	if (firstOpen > 0 && win.end < firstOpen) return fitWindow(firstOpen).text;
	return win.text;
}

/** A text answer to one `ask` question: option numbers/labels, else free text (`customInput`); undefined when the reply is blank and answers nothing. */
function textAnswer(question: OmpAskQuestion, text: string): AskAnswer | undefined {
	const labels = question.options.map((option) => option.label);
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	if (question.multi === true) {
		const parts = trimmed.split(/[,\s]+/).filter((part) => part !== "");
		const picked = parts.map((part) => optionOf(labels, part));
		if (parts.length > 0 && picked.every((index) => index !== undefined)) {
			return { selectedOptions: [...new Set(picked.map((index) => labels[index as number] as string))] };
		}
		return { selectedOptions: [], customInput: trimmed };
	}
	const index = optionOf(labels, trimmed);
	return index === undefined
		? { selectedOptions: [], customInput: trimmed }
		: { selectedOptions: [labels[index] as string] };
}

/** A click answers its question (if still open); a reply answers the first unanswered question. */
export function applyAskEvent(
	questions: readonly OmpAskQuestion[],
	answers: Array<AskAnswer | undefined>,
	buttons: ReadonlyArray<{ question: number; option: number }>,
	event: ChoiceEvent,
): void {
	if (event.kind === "choice") {
		const button = buttons[event.index];
		const label = button === undefined ? undefined : questions[button.question]?.options[button.option]?.label;
		if (button !== undefined && label !== undefined && answers[button.question] === undefined) {
			answers[button.question] = { selectedOptions: [label] };
		}
		return;
	}
	const first = answers.indexOf(undefined);
	const question = questions[first];
	if (question === undefined) return;
	const answer = textAnswer(question, event.text);
	if (answer !== undefined) answers[first] = answer;
}
