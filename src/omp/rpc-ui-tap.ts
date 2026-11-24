import type { OmpDialogAnswerer, OmpDialogRequest, OmpDialogResponse, OmpEvent } from "./driver";
import { parseDialogRequest } from "./rpc-dialog";
import { isRecord } from "./type-guards";

/**
 * omp's `extension_ui_request` dialogs and local slash commands, read from the decoded frames of one child.
 *
 * Owner dialogs (`DIALOG_METHODS`) go to `answer` when one is given; without it, or when it returns `undefined`,
 * throws, or the frame does not parse, the dialog is answered `cancelled` (fail-closed). omp's `method:"cancel"`
 * (its own timeout or an aborted turn) aborts the waiting answer, and nothing is written for that dialog afterwards.
 * A method that is neither an owner dialog nor a fire-and-forget notice (`NOTICE_METHODS`) — e.g. omp 19.1's HTML
 * `form` — is answered `cancelled` too, so a request kind ompbot does not know never leaves omp waiting for a reply.
 *
 * `localCommand` hears about a prompt omp handled as a local slash command: its `prompt` response says
 * `agentInvoked: false` and no `prompt_result` follows. The text is the `command_output` frames written since the
 * previous `prompt` response — omp writes a command's output before answering the prompt that ran it — joined by
 * newlines, "" when there were none.
 */
export class ExtensionUiTap {
	readonly #emit: (event: OmpEvent) => void;
	readonly #reply: (frame: Record<string, unknown>) => void;
	readonly #answer: OmpDialogAnswerer | undefined;
	readonly #localCommand: ((id: string, output: string) => void) | undefined;
	readonly #waiting = new Map<string, AbortController>();
	readonly #commandOutput: string[] = [];

	constructor(
		emit: (event: OmpEvent) => void,
		reply: (frame: Record<string, unknown>) => void,
		answer?: OmpDialogAnswerer,
		localCommand?: (id: string, output: string) => void,
	) {
		this.#emit = emit;
		this.#reply = reply;
		this.#answer = answer;
		this.#localCommand = localCommand;
	}

	frame(frame: Record<string, unknown>): void {
		if (frame.type === "command_output") {
			if (typeof frame.text === "string") this.#commandOutput.push(frame.text);
			return;
		}
		if (frame.type === "response") {
			if (frame.command !== "prompt") return;
			const output = this.#commandOutput.splice(0).join("\n");
			const local = frame.success === true && isRecord(frame.data) && frame.data.agentInvoked === false;
			if (local && typeof frame.id === "string") this.#localCommand?.(frame.id, output);
			return;
		}
		if (frame.type !== "extension_ui_request") return;
		this.#emit({ type: "extension_ui_request", method: frame.method, id: frame.id });
		if (frame.method === "cancel" && typeof frame.targetId === "string") {
			this.#waiting.get(frame.targetId)?.abort();
			this.#waiting.delete(frame.targetId);
			return;
		}
		if (typeof frame.method !== "string" || NOTICE_METHODS.has(frame.method)) return;
		if (!DIALOG_METHODS.has(frame.method)) {
			if (typeof frame.id === "string") this.#reply({ type: "extension_ui_response", id: frame.id, cancelled: true });
			return;
		}
		const answer = this.#answer;
		const request = answer === undefined ? undefined : parseDialogRequest(frame);
		if (answer === undefined || request === undefined) {
			this.#reply({ type: "extension_ui_response", id: frame.id, cancelled: true });
			return;
		}
		const controller = new AbortController();
		this.#waiting.set(request.id, controller);
		void answerDialog(answer, request, controller.signal).then((response) => {
			if (controller.signal.aborted) return; // omp already settled it; a late answer must not land
			this.#waiting.delete(request.id);
			this.#reply({ type: "extension_ui_response", id: request.id, ...response });
		});
	}

	/** An owner dialog is waiting for its answer: the session is paused on the owner, not silent. */
	get open(): boolean {
		return this.#waiting.size > 0;
	}

	/** The child is gone: nobody reads an answer anymore, so close the cards still waiting. */
	close(): void {
		for (const controller of this.#waiting.values()) controller.abort();
		this.#waiting.clear();
	}
}

/** The answerer's response, or `cancelled` when it has none or throws (fail-closed). */
async function answerDialog(
	answer: OmpDialogAnswerer,
	request: OmpDialogRequest,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	try {
		return (await answer(request, signal)) ?? { cancelled: true };
	} catch {
		return { cancelled: true };
	}
}

/** Dialogs only a person can answer: the owner through `answerDialog`, else cancelled at once instead of hanging the turn. */
const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor", "ask", "form"]);

/** omp's UI requests that expect no `extension_ui_response`; every other unknown method is cancelled. */
const NOTICE_METHODS: ReadonlySet<string> = new Set([
	"notify",
	"setStatus",
	"setTitle",
	"setWidget",
	"set_editor_text",
	"open_url",
]);
