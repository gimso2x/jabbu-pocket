import type { OmpAskQuestion, OmpDialogRequest } from "./driver";
import { parseForm } from "./form";
import { isRecord } from "./type-guards";

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** One `ask` question from the wire, or undefined when its shape is not omp's. */
function parseAskQuestion(value: unknown): OmpAskQuestion | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") return undefined;
	if (!Array.isArray(value.options)) return undefined;
	const options: OmpAskQuestion["options"] = [];
	for (const option of value.options) {
		if (!isRecord(option) || typeof option.label !== "string") return undefined;
		const description = optionalString(option.description);
		options.push(description === undefined ? { label: option.label } : { label: option.label, description });
	}
	const header = optionalString(value.header);
	const recommended = typeof value.recommended === "number" ? value.recommended : undefined;
	return {
		id: value.id,
		question: value.question,
		options,
		...(header === undefined ? {} : { header }),
		...(value.multi === true ? { multi: true } : {}),
		...(recommended === undefined ? {} : { recommended }),
	};
}

/** The optional row descriptions and checkbox state of a select frame with `rowCount` rows; malformed parts are left out. */
function selectExtras(
	frame: Record<string, unknown>,
	rowCount: number,
): Pick<Extract<OmpDialogRequest, { method: "select" }>, "descriptions" | "checkedIndices" | "markableCount"> {
	const extras: ReturnType<typeof selectExtras> = {};
	const { optionDetails, checkedIndices, markableCount } = frame;
	if (Array.isArray(optionDetails)) {
		const descriptions = optionDetails.slice(0, rowCount).map((detail) => {
			const text = isRecord(detail) ? optionalString(detail.description) : undefined;
			return text === undefined || text.trim() === "" ? undefined : text;
		});
		if (descriptions.some((text) => text !== undefined)) extras.descriptions = descriptions;
	}
	if (Array.isArray(checkedIndices)) {
		extras.checkedIndices = checkedIndices.filter(
			(index): index is number => Number.isInteger(index) && index >= 0 && index < rowCount,
		);
	}
	if (typeof markableCount === "number" && Number.isInteger(markableCount) && markableCount >= 0) {
		extras.markableCount = Math.min(markableCount, rowCount);
	}
	return extras;
}

/** A dialog frame as an `OmpDialogRequest`; undefined when a required field is missing (it is then cancelled). */
export function parseDialogRequest(frame: Record<string, unknown>): OmpDialogRequest | undefined {
	const { id, title } = frame;
	if (typeof id !== "string") return undefined;
	const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
	const withTimeout = timeout === undefined ? {} : { timeout };
	switch (frame.method) {
		case "select":
			if (typeof title !== "string" || !Array.isArray(frame.options)) return undefined;
			if (!frame.options.every((option) => typeof option === "string")) return undefined;
			return {
				method: "select",
				id,
				title,
				options: frame.options as string[],
				...withTimeout,
				...(typeof frame.selectionMarker === "string" ? { selectionMarker: frame.selectionMarker } : {}),
				...selectExtras(frame, frame.options.length),
			};
		case "confirm":
			if (typeof title !== "string" || typeof frame.message !== "string") return undefined;
			return { method: "confirm", id, title, message: frame.message, ...withTimeout };
		case "input": {
			if (typeof title !== "string") return undefined;
			const placeholder = optionalString(frame.placeholder);
			return {
				method: "input",
				id,
				title,
				...(placeholder === undefined ? {} : { placeholder }),
				...withTimeout,
				...(frame.secret === true ? { secret: true } : {}),
			};
		}
		case "editor": {
			if (typeof title !== "string") return undefined;
			const prefill = optionalString(frame.prefill);
			return { method: "editor", id, title, ...(prefill === undefined ? {} : { prefill }) };
		}
		case "ask": {
			if (!Array.isArray(frame.questions) || frame.questions.length === 0) return undefined;
			const questions = frame.questions.map(parseAskQuestion);
			if (questions.some((question) => question === undefined)) return undefined;
			return { method: "ask", id, questions: questions as OmpAskQuestion[], ...withTimeout };
		}
		case "form": {
			// A form the card cannot take (secret/file input, no named control) stays undefined and is cancelled.
			const form = typeof frame.html === "string" ? parseForm(frame.html) : undefined;
			return form === undefined ? undefined : { method: "form", id, form, ...withTimeout };
		}
		default:
			return undefined;
	}
}
