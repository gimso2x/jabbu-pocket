import { cutCodePointSafe } from "../channel/text";
import type { OmpDialogRequest, OmpDialogResponse } from "../omp/driver";
import {
	defaultAnswer,
	type FormAnswer,
	type FormField,
	type FormModel,
	fieldProblem,
	fieldValue,
	formData,
	isArrayChoice,
} from "../omp/form";
import type { ApprovalBroker, ApprovalOrigin } from "./approval";
import { deadlineOf, endUnanswered, MAX_CARD_BUTTONS, MAX_CHOICE_BUTTONS, optionOf } from "./choice-common";

type FormRequest = Extract<OmpDialogRequest, { method: "form" }>;
type ChoiceField = Extract<FormField, { kind: "choice" }>;

const FALLBACK = "기본값(미리 선택된 값)";
const YES = /^(예|네|응|ㅇㅇ|ㅇ|좋아|yes|y|ok|확인|켬|on)$/i;
const NO = /^(아니오|아니요|아니|ㄴㄴ|no|n|끔|off)$/i;
const INTRO_MAX = 500;

/** One card button: the field it answers and the answer a click gives it. */
interface FormButton {
	label: string;
	field: number;
	answer: FormAnswer;
}

/** Option indices the owner can pick (a disabled option is not offered, as in omp's own dialog). */
const liveOptions = (field: ChoiceField): number[] =>
	field.options.flatMap((option, index) => (option.disabled ? [] : [index]));

const labelOf = (field: ChoiceField, option: number): string => field.options[option]?.label ?? "";

/** A lone checkbox: asked as yes/no, not as a list. */
const isToggle = (field: ChoiceField): boolean => field.multi && !isArrayChoice(field);

/** The default a field opens with, if it has one: a preselected option, a prefilled text. */
function hasDefault(field: FormField): boolean {
	if (field.kind === "text") return field.value !== "";
	return field.options.some((option) => option.checked && !option.disabled);
}

/**
 * Buttons of the card, drawn once so a click's index means the same button for the card's whole life: yes/no for a lone
 * checkbox, one per option for a single choice of at most `MAX_CHOICE_BUTTONS` options while the card stays within
 * `MAX_CARD_BUTTONS`. Everything else is answered by reply.
 */
function formButtons(model: FormModel): FormButton[] {
	const many = model.fields.length > 1;
	const buttons: FormButton[] = [];
	model.fields.forEach((field, index) => {
		if (field.kind !== "choice") return;
		const prefix = many ? `${index + 1}. ` : "";
		const live = liveOptions(field);
		if (live.length === 0) return;
		if (isToggle(field)) {
			if (buttons.length + 2 > MAX_CARD_BUTTONS) return;
			buttons.push({ label: `${prefix}예`, field: index, answer: { checked: live.slice(0, 1) } });
			buttons.push({ label: `${prefix}아니오`, field: index, answer: { checked: [] } });
			return;
		}
		if (field.multi || live.length > MAX_CHOICE_BUTTONS || buttons.length + live.length > MAX_CARD_BUTTONS) return;
		for (const option of live)
			buttons.push({ label: `${prefix}${labelOf(field, option)}`, field: index, answer: { checked: [option] } });
	});
	return buttons;
}

/** What an answer reads as on the card. */
function answerLabel(field: FormField, answer: FormAnswer): string {
	if ("text" in answer)
		return answer.text.trim() === "" ? "(빈 답)" : cutCodePointSafe(answer.text.replace(/\s+/g, " "), 60);
	if (field.kind !== "choice") return "(빈 답)";
	if (isToggle(field)) return answer.checked.length > 0 ? "예" : "아니오";
	const labels = answer.checked.map((option) => labelOf(field, option));
	if (answer.other?.trim()) labels.push(`기타: ${answer.other.trim()}`);
	return labels.join(", ") || "(없음)";
}

/** One open field: its question, its defaults, and how to answer it. Only choices speak of numbers. */
function fieldBlock(field: FormField, index: number, buttoned: boolean, warning: string | undefined): string {
	const lines = [`*${index + 1}. ${field.title}${field.required ? " (필수)" : ""}*`];
	const skip = hasDefault(field) ? " · 기본값을 쓰려면 -" : "";
	if (field.kind === "text") {
		if (field.value !== "") lines.push(`(기본값: ${cutCodePointSafe(field.value.replace(/\s+/g, " "), 60)})`);
		const numeric = field.type === "number" || field.type === "range";
		const range =
			numeric && (field.min !== undefined || field.max !== undefined) ? ` (${field.min ?? ""}~${field.max ?? ""})` : "";
		lines.push(`${numeric ? "숫자를" : "답장으로"} 적어 주세요${range}${skip}`);
	} else if (isToggle(field)) {
		const recommend = field.options[0]?.checked === true ? " (추천: 예)" : "";
		lines.push(`${buttoned ? "버튼을 누르거나 " : ""}예/아니오로 답해 주세요${recommend}${skip}`);
	} else {
		const live = liveOptions(field);
		for (const [n, option] of live.entries())
			lines.push(`${n + 1}. ${labelOf(field, option)}${field.options[option]?.checked ? " (추천)" : ""}`);
		const how = isArrayChoice(field)
			? "번호를 쉼표로 답장해 주세요(예: 1,3), 없음은 0"
			: `${buttoned ? "버튼을 누르거나 " : ""}번호로 답장해 주세요`;
		lines.push(`${how}${field.other ? " · 목록에 없는 글은 기타로 받습니다" : ""}${skip}`);
	}
	if (warning !== undefined) lines.push(`⚠️ ${field.title}: ${warning}`);
	return lines.join("\n");
}

function formText(
	model: FormModel,
	answers: ReadonlyArray<FormAnswer | undefined>,
	buttoned: ReadonlySet<number>,
	warnings: ReadonlyMap<number, string>,
): string {
	const intro = model.intro === "" ? "" : `${cutCodePointSafe(model.intro, INTRO_MAX)}\n`;
	const blocks = model.fields.map((field, index) => {
		const answer = answers[index];
		if (answer === undefined) return fieldBlock(field, index, buttoned.has(index), warnings.get(index));
		return `*${index + 1}. ${field.title}*\n→ ${answerLabel(field, answer)}`;
	});
	return `❓ ${intro}항목 ${model.fields.length}개 — 답하지 않은 첫 항목부터 답장이 채워집니다\n${blocks.join("\n\n")}`;
}

/** A reply to a choice field: option numbers or names (a free text where the group takes "Other"), or why it is none. */
function readChoice(field: ChoiceField, text: string): FormAnswer | string {
	const live = liveOptions(field);
	const labels = live.map((option) => labelOf(field, option));
	const values = live.map((option) => field.options[option]?.value ?? "");
	const pick = (part: string): number | string => {
		const found = optionOf(labels, part) ?? optionOf(values, part);
		if (found !== undefined) return live[found] as number;
		return /^\d+$/.test(part) ? `없는 번호입니다(1~${live.length})` : "선택지에 없습니다";
	};
	if (isToggle(field)) {
		if (YES.test(text)) return { checked: live.slice(0, 1) };
		return NO.test(text) ? { checked: [] } : "예 또는 아니오로 답해 주세요";
	}
	if (!isArrayChoice(field)) {
		const index = pick(text);
		if (typeof index === "number") return { checked: [index] };
		return field.other && !/^\d+$/.test(text) ? { checked: [], other: text } : index;
	}
	if (text === "0") return { checked: [] };
	const comma = text.split(/\s*,\s*/).filter((part) => part !== "");
	let parts = text.split(/\s+/).filter((part) => part !== "");
	if (comma.some((part) => typeof pick(part) === "number")) parts = comma;
	const picked = parts.map(pick);
	const bad = picked.find((index): index is string => typeof index === "string");
	if (bad === undefined) return { checked: [...new Set(picked as number[])] };
	return field.other && parts.every((part) => !/^\d+$/.test(part)) ? { checked: [], other: text } : bad;
}

/** A reply as `field`'s answer (`-` keeps the default), or the reason it is none; omp's submit rules are checked here. */
function readAnswer(field: FormField, raw: string): { answer: FormAnswer } | { problem: string } {
	const text = raw.trim();
	let answer: FormAnswer | string;
	if (text === "-") answer = defaultAnswer(field);
	else if (field.kind === "text") answer = { text };
	else answer = text === "" ? "답을 적어 주세요" : readChoice(field, text);
	if (typeof answer === "string") return { problem: answer };
	const problem = fieldProblem(field, fieldValue(field, answer));
	return problem === undefined ? { answer } : { problem };
}

function buttonAnswer(field: FormField, answer: FormAnswer): { answer: FormAnswer } | { problem: string } {
	const problem = fieldProblem(field, fieldValue(field, answer));
	return problem === undefined ? { answer } : { problem };
}

/** First field omp would refuse with its answer (else its default), as `title: reason`. */
function firstProblem(model: FormModel, answers: ReadonlyArray<FormAnswer | undefined>): string | undefined {
	for (const [index, field] of model.fields.entries()) {
		const problem = fieldProblem(field, fieldValue(field, answers[index] ?? defaultAnswer(field)));
		if (problem !== undefined) return `${field.title}: ${problem}`;
	}
	return undefined;
}

/**
 * Asks an omp 19.1 `ask` form on one choice card and answers `{ data }` (the shape omp's `parseFormDialogResponse`
 * takes). A click answers its field; a reply answers the first open one. An answer breaking the field's submit rules
 * is not taken: the card shows a `⚠️` line and asks that field again. At the deadline an untouched card answers
 * `cancelled+timedOut` (omp submits the form's defaults itself); a partly answered one fills the rest with the form's
 * defaults, unless a required field would stay empty.
 */
export async function answerForm(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: FormRequest,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const { form } = request;
	// A choice with nothing to pick (all options disabled) is not asked: it keeps its default.
	const answers: Array<FormAnswer | undefined> = form.fields.map((field) =>
		field.kind === "choice" && liveOptions(field).length === 0 ? defaultAnswer(field) : undefined,
	);
	const warnings = new Map<number, string>();
	const buttons = formButtons(form);
	const labels = buttons.map((button) => button.label);
	const buttoned = new Set(buttons.map((button) => button.field));
	// Only what the form itself preselects is recommended; a field without a default shows no recommendation.
	const recommended = buttons.flatMap((button, index) => {
		const field = form.fields[button.field] as ChoiceField;
		const chosen = "checked" in button.answer ? button.answer.checked : [];
		return chosen.length > 0 && chosen.every((option) => field.options[option]?.checked === true) ? [index] : [];
	});
	const text = () => formText(form, answers, buttoned, warnings);
	const summary = () =>
		form.fields
			.map((field, index) => `${index + 1}) ${answerLabel(field, answers[index] ?? defaultAnswer(field))}`)
			.join(" · ");
	const card = await broker.choose(
		origin,
		{ text: text(), buttons: labels, recommended, fallback: FALLBACK, timeoutMs: deadlineOf(request) },
		{ signal },
	);
	let touched = false;
	for (;;) {
		const result = await card.next();
		if (result.kind === "cancelled") return endUnanswered(card, "cancelled", FALLBACK);
		if (result.kind === "timeout") {
			if (!touched) return endUnanswered(card, "timeout", FALLBACK);
			const problem = firstProblem(form, answers);
			if (problem !== undefined) {
				await card.close(`⌛ 시간 초과: ${problem} — 비어 있는 필수 항목이 있어 omp의 기본값 처리에 맡깁니다`);
				return { cancelled: true, timedOut: true };
			}
			const open = form.fields.flatMap((field, index) => (answers[index] === undefined ? [{ field, index }] : []));
			for (const { field, index } of open) answers[index] = defaultAnswer(field);
			broker.recordAutoChoices(
				origin,
				open.map(({ field, index }) => ({
					question: field.title,
					chosen: answerLabel(field, answers[index] as FormAnswer),
				})),
			);
			await card.close(`⌛ 시간 초과: 기본값으로 자동 선택 — ${summary()}`, summary());
			return { data: formData(form, answered(form, answers)) };
		}
		const index = result.kind === "choice" ? (buttons[result.index]?.field ?? -1) : answers.indexOf(undefined);
		const field = form.fields[index];
		if (field === undefined || answers[index] !== undefined) continue; // a stale click answers nothing
		const read =
			result.kind === "choice"
				? buttonAnswer(field, (buttons[result.index] as FormButton).answer)
				: readAnswer(field, result.text);
		if ("problem" in read) {
			warnings.set(index, read.problem);
			await card.update(text(), labels);
			continue;
		}
		answers[index] = read.answer;
		touched = true;
		warnings.delete(index);
		if (answers.every((answer) => answer !== undefined)) {
			const refused = firstProblem(form, answers);
			if (refused !== undefined) {
				await card.close(`🚫 취소됨: ${refused}`);
				return { cancelled: true };
			}
			await card.close(`✅ 답: ${summary()}`, summary());
			return { data: formData(form, answered(form, answers)) };
		}
		await card.update(text(), labels);
	}
}

const answered = (model: FormModel, answers: ReadonlyArray<FormAnswer | undefined>): Map<string, FormAnswer> =>
	new Map(
		model.fields.flatMap((field, i) =>
			answers[i] === undefined ? [] : [[field.name, answers[i] as FormAnswer] as const],
		),
	);
