/**
 * The HTML `<form>` of an omp 19.1 `ask` (`extension_ui_request` `method:"form"`) as a small model, and the `data`
 * that answers it. No chat code here. Written from omp's documented wire contract and read-only against its 19.1
 * parser (`html-form/parse.ts` + `data.ts`, `parseFormDialogResponse`); nothing of omp is imported (public stdio
 * contract only). A form the card cannot take (secret or file input, no named control, a name two controls share)
 * parses to `undefined`, which the driver answers `cancelled` (fail-closed).
 */

import { decode, MAX_DEPTH, MAX_HTML, matchTag } from "./form-lex";

export interface FormOption {
	value: string;
	label: string;
	checked: boolean;
	disabled: boolean;
}

/** A radio group (`multi: false`), checkbox group (`multi: true`) or `<select>` (`select: true`). */
export interface ChoiceFormField {
	kind: "choice";
	name: string;
	/** What the card asks: the control's label, the text right before it, its fieldset legend, a lone option, its name. */
	title: string;
	multi: boolean;
	select: boolean;
	/** The group also takes one free-text "Other" answer (radio/checkbox groups of 2+ options with no "Other" of their own). */
	other: boolean;
	required: boolean;
	options: FormOption[];
}

/** A single-line `<input>` or a `<textarea>`. */
export interface TextFormField {
	kind: "text";
	name: string;
	title: string;
	type: string;
	multiline: boolean;
	value: string;
	placeholder: string;
	required: boolean;
	min?: number;
	max?: number;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
}

export type FormField = ChoiceFormField | TextFormField;

export interface FormModel {
	/** Headings and paragraphs of the form that are not a field's question, one per line. */
	intro: string;
	fields: FormField[];
	/** `<input type="hidden">` pairs: omp keeps their values itself. */
	hidden: Array<[name: string, value: string]>;
}

/** The owner's answer to one field: the checked option indices (+ "Other" text) of a choice, or a text field's text. */
export type FormAnswer = { checked: number[]; other?: string } | { text: string };

export type FormValue = string | number | string[];
export type FormSubmission = Record<string, FormValue>;

// --- HTML tree -----------------------------------------------------------------------------------------------------

interface El {
	tag: string;
	attrs: Map<string, string>;
	children: Array<El | string>;
}

const VOID = new Set(["input", "br", "hr", "img", "meta", "link", "source", "wbr", "col", "area", "base"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const SKIPPED = new Set([
	"button",
	"head",
	"iframe",
	"link",
	"meta",
	"noscript",
	"script",
	"style",
	"template",
	"title",
]);
const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "summary"]);
const BLOCK = new Set([
	"address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figure", "figcaption", "footer",
	"header", "li", "main", "nav", "p", "section", "tr", "td", "th", "caption",
]); // biome-ignore format: one tag list
const P_CLOSERS = new Set([...BLOCK, ...HEADING, "fieldset", "ul", "ol", "table", "pre", "form", "hr"]);
const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseTree(html: string): El {
	const root: El = { tag: "#root", attrs: new Map(), children: [] };
	const stack: El[] = [root];
	const gtCache = { gt: -1 };
	const top = () => stack[stack.length - 1] as El;
	let at = 0;
	while (at < html.length) {
		const lt = html.indexOf("<", at);
		if (lt === -1) {
			top().children.push(decode(html.slice(at)));
			break;
		}
		if (lt > at) top().children.push(decode(html.slice(at, lt)));
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			at = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html[lt + 1] === "!" || html[lt + 1] === "?") {
			const end = html.indexOf(">", lt);
			at = end === -1 ? html.length : end + 1;
			continue;
		}
		const match = matchTag(html, lt, gtCache);
		if (match === null) {
			if (gtCache.gt === Number.POSITIVE_INFINITY) {
				// No `>` is left, so no tag can start any more: the rest is text.
				top().children.push(decode(html.slice(lt)));
				break;
			}
			top().children.push("<");
			at = lt + 1;
			continue;
		}
		at = lt + match[0].length;
		const tag = (match[2] as string).toLowerCase();
		if (match[1] === "/") {
			for (let index = stack.length - 1; index > 0; index--) {
				if ((stack[index] as El).tag === tag) {
					stack.length = index;
					break;
				}
			}
			continue;
		}
		const attrs = new Map<string, string>();
		for (const attr of (match[3] as string).matchAll(ATTR)) {
			const name = (attr[1] as string).toLowerCase();
			if (!attrs.has(name)) attrs.set(name, decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
		}
		// Implied end tags the agent leaves out.
		if (P_CLOSERS.has(tag) && top().tag === "p") stack.pop();
		if (tag === "option" || tag === "optgroup") {
			if (top().tag === "option") stack.pop();
		} else if (tag === "li") {
			for (let index = stack.length - 1; index > 0; index--) {
				const open = (stack[index] as El).tag;
				if (open === "ul" || open === "ol") break;
				if (open === "li") {
					stack.length = index;
					break;
				}
			}
		}
		const element: El = { tag, attrs, children: [] };
		top().children.push(element);
		if (VOID.has(tag) || match[3]?.endsWith("/") === true) continue;
		if (RAW_TEXT.has(tag)) {
			const close = new RegExp(`</${tag}\\s*>`, "i").exec(html.slice(at));
			const end = close === null ? html.length : at + close.index;
			element.children.push(decode(html.slice(at, end)));
			at = close === null ? html.length : end + close[0].length;
			continue;
		}
		if (stack.length < MAX_DEPTH) stack.push(element);
	}
	return root;
}

function descendants(el: El, match: (child: El) => boolean, into: El[] = []): El[] {
	for (const child of el.children) {
		if (typeof child === "string") continue;
		if (match(child)) into.push(child);
		descendants(child, match, into);
	}
	return into;
}

const isControl = (el: El) => el.tag === "input" || el.tag === "select" || el.tag === "textarea";
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Visible text of an element: no controls, no skipped tags; a block boundary reads as a space. */
function textOf(el: El): string {
	let out = "";
	for (const child of el.children) {
		if (typeof child === "string") out += child;
		else if (!SKIPPED.has(child.tag) && !isControl(child) && child.tag !== "svg") {
			out +=
				BLOCK.has(child.tag) || HEADING.has(child.tag) || child.tag === "br" ? ` ${textOf(child)} ` : textOf(child);
		}
	}
	return squash(out);
}

const numberAttr = (el: El, name: string): number | undefined => {
	const raw = el.attrs.get(name);
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
};

// --- Form model ----------------------------------------------------------------------------------------------------

interface FieldMeta {
	own: string;
	caption: string;
	section: string;
}

class FormBuilder {
	readonly fields: FormField[] = [];
	readonly hidden: Array<[string, string]> = [];
	readonly parts: string[] = [];
	unsupported = false;
	readonly #meta = new Map<FormField, FieldMeta>();
	readonly #groups = new Map<string, ChoiceFormField>();
	readonly #labelFor = new Map<string, El>();
	#inline = "";
	#caption = "";
	#section = "";
	#fieldsetDepth = 0;

	constructor(readonly root: El) {}

	build(): FormModel {
		const ids = new Set(descendants(this.root, isControl).flatMap((control) => control.attrs.get("id") ?? []));
		for (const label of descendants(this.root, (el) => el.tag === "label")) {
			const target = label.attrs.get("for");
			if (target !== undefined && ids.has(target) && !this.#labelFor.has(target)) this.#labelFor.set(target, label);
		}
		this.#children(this.root);
		this.#flush();
		const questions = new Set<string>();
		for (const field of this.fields) {
			if (field.kind === "choice" && !field.select && field.options.length >= 2) {
				field.other = !field.options.some((option) => /^\s*other\b/i.test(option.label));
			}
			const meta = this.#meta.get(field) as FieldMeta;
			const lone = field.kind === "choice" && field.options.length === 1 ? (field.options[0] as FormOption).label : "";
			field.title = meta.own || meta.caption || meta.section || lone || field.name;
			questions.add(field.title);
		}
		const intro = this.parts.filter((part) => !questions.has(part)).join("\n");
		return { intro, fields: this.fields, hidden: this.hidden };
	}

	#children(el: El): void {
		for (const child of el.children) this.#walk(child);
	}

	#flush(): void {
		const text = squash(this.#inline);
		this.#inline = "";
		if (text === "") return;
		this.parts.push(text);
		this.#caption = text;
	}

	#walk(node: El | string): void {
		if (typeof node === "string") {
			this.#inline += node;
			return;
		}
		const { tag } = node;
		if (SKIPPED.has(tag)) return;
		switch (tag) {
			case "br":
				this.#inline += " ";
				return;
			case "hr":
			case "img":
			case "svg":
				this.#flush();
				return;
			case "input":
			case "select":
			case "textarea":
				this.#control(node, "");
				return;
			case "label": {
				const target = node.attrs.get("for");
				if (target !== undefined && this.#labelFor.get(target) === node) return;
				const controls = descendants(node, isControl);
				if (controls.length === 0) {
					this.#children(node);
					return;
				}
				this.#flush();
				const text = textOf(node);
				for (const control of controls) this.#control(control, text);
				return;
			}
			case "fieldset": {
				this.#flush();
				const legend = node.children.find((child): child is El => typeof child !== "string" && child.tag === "legend");
				if (this.#fieldsetDepth === 0) {
					this.#section = legend === undefined ? "" : textOf(legend);
					if (this.#section !== "") this.parts.push(this.#section);
				} else if (legend !== undefined) {
					const heading = textOf(legend);
					if (heading !== "") this.parts.push(heading);
					this.#caption = heading;
				}
				this.#fieldsetDepth++;
				for (const child of node.children) if (child !== legend) this.#walk(child);
				this.#flush();
				this.#fieldsetDepth--;
				if (this.#fieldsetDepth === 0) this.#section = "";
				return;
			}
			case "legend":
				this.#flush();
				this.#children(node);
				this.#flush();
				return;
			case "ul":
			case "ol": {
				this.#flush();
				if (descendants(node, isControl).length > 0) {
					this.#children(node);
					this.#flush();
					return;
				}
				const items = node.children.flatMap((item) =>
					typeof item !== "string" && item.tag === "li" && textOf(item) !== "" ? [`- ${textOf(item)}`] : [],
				);
				if (items.length > 0) this.parts.push(items.join("\n"));
				this.#caption = "";
				return;
			}
			case "pre": {
				this.#flush();
				const text = textOf(node);
				if (text !== "") this.parts.push(text);
				this.#caption = "";
				return;
			}
		}
		if (HEADING.has(tag) || BLOCK.has(tag)) {
			this.#flush();
			this.#children(node);
			this.#flush();
			return;
		}
		this.#children(node);
	}

	#detachedLabel(control: El): string {
		const id = control.attrs.get("id");
		const label = id === undefined ? undefined : this.#labelFor.get(id);
		if (label !== undefined) return textOf(label);
		return squash(control.attrs.get("aria-label") ?? control.attrs.get("title") ?? "");
	}

	#add<T extends FormField>(field: T, own: string): T {
		this.fields.push(field);
		this.#meta.set(field, { own, caption: this.#caption, section: this.#section });
		this.#caption = "";
		return field;
	}

	#control(control: El, wrapping: string): void {
		this.#flush();
		const own = wrapping !== "" ? wrapping : this.#detachedLabel(control);
		const name = control.attrs.get("name") ?? "";
		const required = control.attrs.has("required");
		if (control.tag === "select") {
			if (name === "") return;
			const multi = control.attrs.has("multiple");
			const options: FormOption[] = descendants(control, (el) => el.tag === "option").map((option) => {
				const text = textOf(option);
				return {
					value: option.attrs.get("value") ?? text,
					label: text,
					checked: option.attrs.has("selected"),
					disabled: option.attrs.has("disabled"),
				};
			});
			// A single select always has a selection: the first enabled option unless one is marked.
			const first = options.find((option) => !option.disabled);
			if (!multi && first !== undefined && !options.some((option) => option.checked)) first.checked = true;
			this.#add({ kind: "choice", name, title: "", multi, select: true, other: false, required, options }, own);
			return;
		}
		if (control.tag === "textarea") {
			if (name === "") return;
			const text = control.children.join("").replace(/^\r?\n/, "");
			this.#add(
				{
					kind: "text",
					name,
					title: "",
					type: "textarea",
					multiline: true,
					value: text,
					placeholder: control.attrs.get("placeholder") ?? "",
					required,
					minLength: numberAttr(control, "minlength"),
					maxLength: numberAttr(control, "maxlength"),
				},
				own,
			);
			return;
		}
		const type = (control.attrs.get("type") ?? "text").toLowerCase();
		if (type === "password" || type === "file") {
			this.unsupported = true;
			return;
		}
		if (["button", "image", "reset", "submit"].includes(type) || name === "") return;
		const value = control.attrs.get("value");
		if (type === "hidden") {
			this.hidden.push([name, value ?? ""]);
			return;
		}
		if (type === "radio" || type === "checkbox") {
			const option: FormOption = {
				value: value ?? "on",
				label: own !== "" ? own : (value ?? name),
				checked: control.attrs.has("checked"),
				disabled: control.attrs.has("disabled"),
			};
			const key = `${type}\0${name}`;
			const group = this.#groups.get(key);
			if (group !== undefined) {
				group.options.push(option);
				group.required ||= required;
				return;
			}
			const field = this.#add(
				{
					kind: "choice",
					name,
					title: "",
					multi: type === "checkbox",
					select: false,
					other: false,
					required,
					options: [option],
				},
				"",
			);
			this.#groups.set(key, field);
			return;
		}
		this.#add(
			{
				kind: "text",
				name,
				title: "",
				type,
				multiline: false,
				value: value ?? "",
				placeholder: control.attrs.get("placeholder") ?? "",
				required,
				min: numberAttr(control, "min"),
				max: numberAttr(control, "max"),
				pattern: control.attrs.get("pattern"),
				minLength: numberAttr(control, "minlength"),
				maxLength: numberAttr(control, "maxlength"),
			},
			own || squash(name.replace(/[_-]+/g, " ")),
		);
	}
}

/** The form of an omp `ask`, or `undefined` when the card cannot answer it (no field, secret/file input, shared name). */
export function parseForm(html: string): FormModel | undefined {
	if (html.length > MAX_HTML) return undefined;
	const tree = parseTree(html);
	const form = descendants(tree, (el) => el.tag === "form")[0];
	const builder = new FormBuilder(form ?? tree);
	const model = builder.build();
	if (builder.unsupported || model.fields.length === 0) return undefined;
	const names = [...model.fields.map((field) => field.name), ...model.hidden.map(([name]) => name)];
	return new Set(names).size === names.length ? model : undefined;
}

// --- Answers -------------------------------------------------------------------------------------------------------

/** omp `isArrayChoice`: a checkbox group or multi-select submits an array; a lone checkbox submits its value or nothing. */
export function isArrayChoice(field: ChoiceFormField): boolean {
	return field.multi && field.options.length > 1;
}

/** The answer a field holds untouched: its `checked`/`selected` options, its prefilled text. */
export function defaultAnswer(field: FormField): FormAnswer {
	if (field.kind === "text") return { text: field.value };
	return { checked: field.options.flatMap((option, index) => (option.checked ? [index] : [])) };
}

/** omp `choiceValue`: the typed "Other" text stands in for a radio's value or joins a group's array; blank is no answer. */
function choiceValue(field: ChoiceFormField, checked: readonly number[], other?: string): FormValue | undefined {
	const typed = field.other ? other?.trim() : undefined;
	const values = field.options.flatMap((option, index) =>
		checked.includes(index) && !option.disabled ? [option.value] : [],
	);
	if (isArrayChoice(field)) return typed ? [...values, typed] : values;
	return typed || values[0];
}

/** omp `textValue`: a number for a non-empty numeric `number`/`range` input, else the text. */
function textValue(field: TextFormField, text: string): FormValue {
	if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
		const number = Number(text);
		if (Number.isFinite(number)) return number;
	}
	return text;
}

/** The value `answer` gives `field`; undefined when a choice contributes nothing (the name is then left out). */
export function fieldValue(field: FormField, answer: FormAnswer): FormValue | undefined {
	if (field.kind === "text") return textValue(field, "text" in answer ? answer.text : "");
	return "checked" in answer ? choiceValue(field, answer.checked, answer.other) : undefined;
}

/** `^(?:pattern)$` as HTML matches `pattern`; undefined for a pattern JS rejects (omp ignores it too). */
function compilePattern(pattern: string): RegExp | undefined {
	try {
		return new RegExp(`^(?:${pattern})$`, "v");
	} catch {
		return undefined;
	}
}

/** Why `value` is no acceptable submission for `field` (omp `fieldError`'s rules, said in Korean), else undefined. */
export function fieldProblem(field: FormField, value: FormValue | undefined): string | undefined {
	if (field.kind === "choice") {
		const empty = value === undefined || (Array.isArray(value) && value.length === 0);
		if (!field.required || !empty) return undefined;
		return isArrayChoice(field) ? "하나 이상 골라 주세요" : "필수 항목입니다";
	}
	const text = value === undefined ? "" : String(value);
	if (text.trim() === "") return field.required ? "필수 항목입니다" : undefined;
	if (field.type === "number" || field.type === "range") {
		const number = Number(text);
		if (!Number.isFinite(number)) return "숫자를 적어 주세요";
		if (field.min !== undefined && number < field.min) return `${field.min} 이상이어야 합니다`;
		if (field.max !== undefined && number > field.max) return `${field.max} 이하여야 합니다`;
	}
	if (field.minLength !== undefined && text.length < field.minLength) return `${field.minLength}자 이상 적어 주세요`;
	if (field.maxLength !== undefined && text.length > field.maxLength)
		return `${field.maxLength}자까지만 적을 수 있습니다`;
	if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "이메일 주소를 적어 주세요";
	if (field.type === "url" && !URL.canParse(text)) return "전체 URL을 적어 주세요";
	if (field.pattern !== undefined && compilePattern(field.pattern)?.test(text) === false)
		return `형식에 맞지 않습니다(${field.pattern})`;
	return undefined;
}

/** Data `answers` (by field name; a field without one keeps its default) submit; hidden pairs lead, as in omp. */
export function formData(model: FormModel, answers: ReadonlyMap<string, FormAnswer>): FormSubmission {
	const data: FormSubmission = Object.create(null);
	for (const [name, value] of model.hidden) data[name] = value;
	for (const field of model.fields) {
		const value = fieldValue(field, answers.get(field.name) ?? defaultAnswer(field));
		if (value !== undefined) data[field.name] = value;
	}
	return data;
}

/** Data the form submits untouched (omp `defaultFormData`). */
export function formDefaults(model: FormModel): FormSubmission {
	return formData(model, new Map());
}
