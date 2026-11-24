// Names a shell would damage if it ever saw them unquoted. Each one carries one class of metacharacter; the consumer
// test proves that quoting keeps them whole by checking that the commands they embed never ran.
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Space, single quote, command substitution, a `;`-separated command and a trailing comment. Pasted into a shell line
 * unquoted it makes `substitution-ran` (the `$(touch …)`) and `suffix-ran` (the command after `;`).
 */
export const HOSTILE_PATH = "omp 'q' $(touch substitution-ran); touch suffix-ran; #x";
/** Backslash, double quote, a backtick command and `$HOME`. Unquoted, the backtick makes `backtick-ran`. */
export const HOSTILE_QUOTED = 'back\\slash "double" `touch backtick-ran` $HOME';
/** A newline and a tab: a value that would split one line of a unit file or a log into two. */
export const HOSTILE_CONTROL = "line\nbreak\ttab";

/** What a shell that interpreted the names above leaves behind in its working directory. */
export const SHELL_SIDE_EFFECT_FILES: readonly string[] = ["substitution-ran", "suffix-ran", "backtick-ran"];

/** Which of `SHELL_SIDE_EFFECT_FILES` exist in `dir`; an empty array means no shell ever ran their commands there. */
export function shellSideEffects(dir: string): string[] {
	return SHELL_SIDE_EFFECT_FILES.filter((name) => existsSync(join(dir, name)));
}
