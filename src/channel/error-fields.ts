// Log fields of a thrown value: its message and the first stack frames, so a recurring `*_failed` line names the point
// that threw. `errorText` (a plain one-line message) stays in `text.ts`.
/** Frames of an error stack kept in the log; the message line is the `error` field, so frames start after it. */
const ERROR_STACK_FRAMES = 5;

/** Log fields for an error: message + first stack frames, so a recurring `*_failed` line names the throw site. */
export function errorFields(err: unknown): { error: string; stack?: string } {
	if (err instanceof Error) {
		const lines = (err.stack ?? "").split("\n");
		const frames = lines.slice(1, 1 + ERROR_STACK_FRAMES).join("\n");
		return frames === "" ? { error: err.message } : { error: err.message, stack: frames };
	}
	return { error: String(err) };
}
