import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Fake `agy -p --input-format stream-json --output-format stream-json` for `AgyPrintDriver` tests, speaking the wire
 * measured on agy 1.5.17 (T-20261126-08 S0). Driven by env plus prompt markers:
 * - FAKE_AGY_LOG: argv, env, pid, every stdin line and the exit are appended there as JSON lines.
 * - `--conversation <id>`: an id starting `fake-` resumes; any other warns `conversation "<id>" not found` on stderr and
 *   opens a new conversation, like agy. `init` (with the conversation id) is written before any input.
 * - "@tool": a run_command tool step ACTIVE then DONE (output `hi`) before the answer; "@denied": the step ends ERROR
 *   with agy's deny message.
 * - "@error": the turn's `result` is status ERROR (`model exploded`); the child goes on.
 * - "@quota": `result` status ERROR with agy's 429 executor error text; "@notice": a text delta carrying agy's quota
 *   retry notice, then the turn hangs. Both keep the child running (the driver must end it).
 * - "@hold": a text delta `working`, then the turn waits for SIGUSR1 (answers `HELD`).
 * - "@close-stdin": after answering, the child closes its stdin but stays alive (keep-alive timer), so the driver's
 *   next stdin write hits EPIPE: the stdin-closed path of `#send`.
 * - anything else: `REPLY<n>:<last line of the prompt>` in two text deltas (n = turns of this process).
 * SIGTERM writes a `stream input cancelled` ERROR result and exits 1; stdin closing exits 0.
 */

const LOG = process.env.FAKE_AGY_LOG;
const log = (entry: Record<string, unknown>): void => {
	if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const { AGY_CLI_DISABLE_AUTO_UPDATE, SSH_TTY, OMP_WIKI_NOTE_DISABLE, SLACK_BOT_TOKEN } = process.env;
log({ kind: "argv", argv: args, pid: process.pid });
log({ kind: "env", env: { AGY_CLI_DISABLE_AUTO_UPDATE, SSH_TTY, OMP_WIKI_NOTE_DISABLE, SLACK_BOT_TOKEN } });
if (args.at(-1) !== "-p=" || flag("--input-format") !== "stream-json" || flag("--output-format") !== "stream-json") {
	process.stderr.write("error: fake agy wants stream-json in and out with -p= last\n");
	process.exit(2);
}
if (flag("--model") === "@crash-init") {
	process.stderr.write("boot failed\n");
	process.exit(1);
}

const wanted = flag("--conversation");
let conversation = `fake-${randomUUID()}`;
if (wanted?.startsWith("fake-")) conversation = wanted;
else if (wanted !== undefined) process.stderr.write(`warning: conversation "${wanted}" not found\n`);
let turns = 0;
let step = 0;
let held: (() => void) | undefined;
/** Set by "@close-stdin": stdin is closed but the child stays alive, so the driver's next write hits EPIPE. */
let stdinClosedAlive = false;
const out = (event: string, body: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify({ event, [event]: { conversation_id: conversation, ...body } })}\n`);
};
const stepUpdate = (body: Record<string, unknown>): void => out("step_update", { step_index: step++, ...body });
const usage = { input_tokens: 100, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 40, total_tokens: 107 };
const result = (status: string, response: string, error?: string): void =>
	out("result", { status, response, ...(error === undefined ? {} : { error }), num_turns: turns });
process.stdout.write(
	`${JSON.stringify({ event: "init", conversation_id: conversation, init: { model: flag("--model") } })}\n`,
);

function answer(text: string): void {
	const half = Math.ceil(text.length / 2);
	stepUpdate({ state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(0, half) });
	stepUpdate({ state: "DONE", step_type: "agent_response", text_delta: text.slice(half), usage });
	result("SUCCESS", text);
}

function turn(content: string): void {
	turns += 1;
	stepUpdate({ state: "DONE", step_type: "user_input" });
	stepUpdate({ state: "DONE", step_type: "brand_new_step" });
	if (content.includes("@error")) {
		result("ERROR", "", "model exploded");
		return;
	}
	if (content.includes("@empty-res")) {
		stepUpdate({ state: "ACTIVE", step_type: "agent_response", text_delta: "STREAMED" });
		stepUpdate({ state: "DONE", step_type: "agent_response", text_delta: "-OK", usage });
		result("SUCCESS", "");
		return;
	}
	if (content.includes("@end-quota")) {
		answer(
			"작업 중\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.\n",
		);
		return;
	}
	if (content.includes("@quota")) {
		const detail = "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h7m20s.";
		result("ERROR", "", `generating and executing: transport error (ResourceExhausted, HTTP 429): ${detail}`);
		return;
	}
	if (content.includes("@notice")) {
		const notice = "⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached.\n";
		stepUpdate({ state: "ACTIVE", step_type: "agent_response", text_delta: notice });
		return;
	}
	if (content.includes("@tool") || content.includes("@denied")) {
		const tool = { step_type: "tool", tool_name: "run_command" };
		const parameters = { CommandLine: "echo hi" };
		const index = step;
		stepUpdate({ ...tool, state: "ACTIVE", tool_info: { name: "run_command", parameters } });
		step = index;
		const message = "Permission denied for unsandboxed(git push). Matches user-configured deny rule.";
		if (content.includes("@denied"))
			stepUpdate({ ...tool, state: "ERROR", tool_info: { parameters, error: { type: "TOOL_ERROR", message } } });
		else stepUpdate({ ...tool, state: "DONE", tool_info: { parameters, output: "hi" } });
	}
	if (content.includes("@hold")) {
		stepUpdate({ state: "ACTIVE", step_type: "agent_response", text_delta: "working" });
		held = () => answer("HELD");
		return;
	}
	if (content.includes("@longline-nl")) {
		process.stdout.write(`${"x".repeat(2 * 1024 * 1024)}\n`);
		return;
	}
	if (content.includes("@longline")) {
		// A line past the RPC frame cap that never ends: the driver must cap it, not buffer it forever.
		process.stdout.write("x".repeat(2 * 1024 * 1024));
		return;
	}
	answer(`REPLY${turns}:${content.split("\n").at(-1)}`);
}

process.on("SIGUSR1", () => {
	const release = held;
	held = undefined;
	release?.();
});
process.on("SIGTERM", () => {
	result("ERROR", "", "stream input cancelled: context canceled");
	log({ kind: "exit", pid: process.pid, signal: "SIGTERM" });
	process.exit(1);
});

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	log({ kind: "in", pid: process.pid, line });
	const message = JSON.parse(line) as { event?: string; message?: { content?: string } };
	if (message.event !== "user") return;
	const content = message.message?.content ?? "";
	turn(content);
	if (content.includes("@close-stdin")) {
		stdinClosedAlive = true;
		// Close fd 0 at the OS level: Bun's stdin.destroy() only stops the stream, the pipe stays open.
		closeSync(0);
		// Liveness handle, not a sleep: the child must stay up with stdin closed so the next write hits EPIPE.
		setInterval(() => {}, 1000);
	}
});
lines.on("close", () => {
	if (stdinClosedAlive) return;
	log({ kind: "exit", pid: process.pid, signal: null });
	process.exit(0);
});
