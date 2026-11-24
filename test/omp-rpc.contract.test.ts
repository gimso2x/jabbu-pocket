import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryText, type OmpEvent, type OmpFinal } from "../src/omp/driver";
import { RpcOmpDriver } from "../src/omp/rpc-driver";
import type { ApprovalBroker } from "../src/safety/approval";
import { answerDialog } from "../src/safety/choice";
import type { ChoiceEvent, ChoiceResult } from "../src/safety/choice-types";
import { pickE2eModel } from "./helpers/omp-model";

/**
 * Contract test against a REAL `omp --mode rpc` child. Costs tokens, so it only
 * runs with OMPBOT_E2E_OMP=1 and uses a model the omp actually offers (pin with
 * OMPBOT_E2E_OMP_PROVIDER / OMPBOT_E2E_OMP_MODEL; a pin omp does not offer skips).
 */
const enabled = process.env.OMPBOT_E2E_OMP === "1";
if (!enabled)
	console.log("[skip] omp-rpc.contract.test.ts: set OMPBOT_E2E_OMP=1 to run against a real omp (costs tokens)");

const OMP_EXECUTABLE = process.env.OMPBOT_OMP_EXECUTABLE ?? Bun.which("omp") ?? "omp";
const TURN_TIMEOUT_MS = 120_000;
// Real-process integration test: this timer is only a failure deadline on an awaited event/final, never a wait for time to pass.
const INTERACTIVE_UI_METHODS = ["select", "confirm", "input", "editor", "ask", "form"];
// omp 19.1 sends the `ask` tool as one `form` request, so the form test below needs a 19.1+ omp.
const OMP_VERSION = enabled ? Bun.spawnSync([OMP_EXECUTABLE, "--version"]).stdout.toString() : "";

// Model is picked from what the real omp offers (no tokens), so a stale default skips instead of dispatch-failing.
const picked = enabled ? await pickE2eModel(OMP_EXECUTABLE) : undefined;
if (enabled && picked?.model === undefined)
	console.log(`[skip] omp-rpc.contract.test.ts: ${picked?.reason ?? "no model offered"}`);
const model = picked?.model;
const PROVIDER = model === undefined ? undefined : model.slice(0, model.indexOf("/"));
const MODEL = model === undefined ? undefined : model.slice(model.indexOf("/") + 1);

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise: guarded, resolve, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
	promise.then(
		(value) => {
			clearTimeout(timer);
			resolve(value);
		},
		(error) => {
			clearTimeout(timer);
			reject(error);
		},
	);
	return guarded;
}

/** Records every event/final of one driver so waits can be armed before the triggering action. */
class Recorder {
	readonly events: OmpEvent[] = [];
	readonly finals = new Map<string, OmpFinal>();
	readonly #finalWaiters = new Map<string, (final: OmpFinal) => void>();
	readonly #eventWaiters = new Set<{ match: (event: OmpEvent) => boolean; resolve: (event: OmpEvent) => void }>();

	constructor(readonly driver: RpcOmpDriver) {
		driver.onEvent((event) => {
			this.events.push(event);
			for (const waiter of this.#eventWaiters) {
				if (waiter.match(event)) {
					this.#eventWaiters.delete(waiter);
					waiter.resolve(event);
				}
			}
		});
		driver.onFinal((final) => {
			this.finals.set(final.opRef, final);
			this.#finalWaiters.get(final.opRef)?.(final);
		});
	}

	/** Arm BEFORE the action that triggers the event. */
	armEvent(match: (event: OmpEvent) => boolean, what: string): Promise<OmpEvent> {
		const { promise, resolve } = Promise.withResolvers<OmpEvent>();
		this.#eventWaiters.add({ match, resolve });
		return withTimeout(promise, TURN_TIMEOUT_MS, what);
	}

	final(opRef: string): Promise<OmpFinal> {
		const known = this.finals.get(opRef);
		if (known) return Promise.resolve(known);
		const { promise, resolve } = Promise.withResolvers<OmpFinal>();
		this.#finalWaiters.set(opRef, resolve);
		return withTimeout(promise, TURN_TIMEOUT_MS, `final of ${opRef}`);
	}
}

function processesTouching(root: string): Array<{ pid: number; cmdline: string }> {
	const found: Array<{ pid: number; cmdline: string }> = [];
	for (const name of readdirSync("/proc")) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		try {
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
			let cwd = "";
			try {
				cwd = readlinkSync(`/proc/${pid}/cwd`);
			} catch {
				// unreadable cwd
			}
			if (cmdline.includes(root) || cwd.startsWith(root)) found.push({ pid, cmdline });
		} catch {
			// process vanished
		}
	}
	return found;
}

describe.skipIf(!enabled || picked?.model === undefined)("omp rpc contract", () => {
	let root = "";
	let cwd = "";
	let sessionDir = "";
	const drivers: RpcOmpDriver[] = [];
	const recorders: Recorder[] = [];
	const savedEnv: Record<string, string | undefined> = {};
	let nonce1 = "";
	let nonce2 = "";

	function makeDriver(): Recorder {
		const driver = new RpcOmpDriver({
			ompExecutable: OMP_EXECUTABLE,
			cwd,
			sessionDir,
			provider: PROVIDER,
			model: MODEL,
			thinking: "low",
			env: { OMP_WIKI_NOTE_DISABLE: "1" },
		});
		drivers.push(driver);
		const recorder = new Recorder(driver);
		recorders.push(recorder);
		return recorder;
	}

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "ompbot-contract-"));
		cwd = join(root, "workspace");
		sessionDir = join(root, "sessions", "origin-a");
		// Secrets-shaped parent env that MUST NOT reach the child.
		for (const key of ["SLACK_BOT_TOKEN", "OMPBOT_SECRET_PROBE"]) savedEnv[key] = process.env[key];
		process.env.SLACK_BOT_TOKEN = "xoxb-TEST-0";
		process.env.OMPBOT_SECRET_PROBE = "probe";
		nonce1 = `N1${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
		nonce2 = `N2${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
	});

	afterAll(async () => {
		await Promise.allSettled(drivers.map((driver) => driver.stop()));
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		const leftover = processesTouching(root);
		rmSync(root, { recursive: true, force: true });
		expect(leftover).toEqual([]);
	});

	test("protocol: the executable itself starts in RPC mode, offers protocol 2 and accepts the negotiation", async () => {
		// Not a Recorder: (b) and (c) take recorders[0] as the (a) driver. afterAll still stops it via drivers.
		const driver = new RpcOmpDriver({
			ompExecutable: OMP_EXECUTABLE,
			cwd,
			sessionDir: join(root, "sessions", "handshake"),
			env: { OMP_WIKI_NOTE_DISABLE: "1" },
		});
		drivers.push(driver);
		await driver.start(); // rejects with omp_rpc_unsupported when ready or negotiate_protocol is not v2
		const pid = driver.pid ?? 0;
		expect(pid).toBeGreaterThan(0);
		// The ELF is argv[0]; cli.js runs through its shebang, so it is the interpreter's first argument.
		expect(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")).toContain(OMP_EXECUTABLE);
		await driver.stop();
	});

	test(
		"(a) ECHO nonce1 appears in the final text; (f) child env has no SLACK_/OMPBOT_ keys",
		async () => {
			const rec = makeDriver();
			await rec.driver.start();
			await rec.driver.openSession();
			// A fresh real session already holds entries (model_change, thinking_level_change, extension notes).
			expect(typeof (await rec.driver.leafId())).toBe("string");

			const opRef = await rec.driver.prompt(`Reply with exactly: ECHO ${nonce1}`);
			const final = await rec.final(opRef);
			expect(final.status).toBe("completed");
			expect(final.text).toContain(nonce1);

			const pid = rec.driver.pid;
			expect(pid).toBeGreaterThan(0);
			const keys = readFileSync(`/proc/${pid}/environ`, "utf8")
				.split("\0")
				.filter((entry) => entry.length > 0)
				.map((entry) => entry.slice(0, entry.indexOf("=")));
			expect(keys.filter((key) => key.startsWith("SLACK_") || key.startsWith("OMPBOT_"))).toEqual([]);
			expect(keys).toContain("OMP_WIKI_NOTE_DISABLE");
			expect(keys).toContain("PATH");
		},
		TURN_TIMEOUT_MS,
	);

	test(
		"(b) steer after tool_execution_start lands in the same turn's final text",
		async () => {
			const rec = recorders[0];
			if (!rec) throw new Error("(a) did not create a driver");
			const toolStarted = rec.armEvent((event) => event.type === "tool_execution_start", "tool_execution_start");
			const opRef = await rec.driver.prompt(
				"Use the bash tool to run `sleep 20`. When it finishes, follow any extra instruction I sent while it ran, " +
					"and write the exact token from that instruction in your final answer.",
			);
			await toolStarted;
			await rec.driver.steer(`Extra instruction: include the token ${nonce2} in your final answer.`);
			const final = await rec.final(opRef);
			expect(final.status).toBe("completed");
			expect(final.text).toContain(nonce2);
		},
		TURN_TIMEOUT_MS,
	);

	test(
		"(c) stop, start with the same sessionDir, openSession resumes and remembers nonce1",
		async () => {
			const first = recorders[0];
			if (!first) throw new Error("(a) did not create a driver");
			const oldPid = first.driver.pid;
			await first.driver.stop();
			expect(oldPid === undefined ? false : processesTouching(sessionDir).some((p) => p.pid === oldPid)).toBe(false);

			const rec = makeDriver();
			await rec.driver.start();
			const opened = await rec.driver.openSession();
			expect(opened.resumed).toBe(true);
			const opRef = await rec.driver.prompt(
				"Earlier in this conversation I asked you to reply with exactly `ECHO <token>`. What was that token? Reply with only the token.",
			);
			const final = await rec.final(opRef);
			expect(final.text).toContain(nonce1);
		},
		TURN_TIMEOUT_MS,
	);

	test(
		"(d) abort ends the turn as aborted and state is idle",
		async () => {
			const rec = recorders.at(-1);
			if (!rec) throw new Error("no driver");
			const toolStarted = rec.armEvent((event) => event.type === "tool_execution_start", "tool_execution_start");
			const opRef = await rec.driver.prompt("Use the bash tool to run `sleep 60`, then say done.");
			await toolStarted;
			await rec.driver.abort();
			const final = await rec.final(opRef);
			expect(final.status).toBe("aborted");
			const state = await rec.driver.state();
			expect(state.idle).toBe(true);
		},
		TURN_TIMEOUT_MS,
	);

	test(
		"(g) entriesSince(leafId before prompt) = that prompt's user entry .. final assistant entry; unknown since rejects",
		async () => {
			const rec = recorders.at(-1);
			if (!rec) throw new Error("no driver");
			const nonceG = `NG${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
			const before = await rec.driver.leafId();
			expect(before).not.toBeNull();

			const opRef = await rec.driver.prompt(`Reply with exactly: ECHO ${nonceG}`);
			const final = await rec.final(opRef);
			expect(final.status).toBe("completed");

			const slice = await rec.driver.entriesSince(before ?? undefined);
			const messages = slice.entries.filter((entry) => entry.type === "message");
			expect(messages.length).toBeGreaterThanOrEqual(2);
			const first = messages[0];
			const last = messages.at(-1);
			expect(first?.message?.role).toBe("user");
			expect(entryText(first ?? { id: "", type: "" })).toContain(nonceG);
			expect(last?.message?.role).toBe("assistant");
			expect(entryText(last ?? { id: "", type: "" })).toContain(nonceG);
			expect(entryText(last ?? { id: "", type: "" })).toBe(final.text);
			expect(messages.filter((entry) => entry.message?.role === "user")).toHaveLength(1);
			expect(slice.entries.some((entry) => entry.id === before)).toBe(false);
			expect(slice.leafId).toBe(slice.entries.at(-1)?.id ?? null);

			const none = await rec.driver.entriesSince(slice.leafId ?? undefined);
			expect(none.entries).toEqual([]);

			expect(await rec.driver.entriesSince("definitely-not-an-entry-id").catch((e: unknown) => e)).toMatchObject({
				code: "unknown_since",
				rpcCode: "unknown_since",
			});
		},
		TURN_TIMEOUT_MS,
	);

	test(
		"(h) omp 19.1 ask form: a form request is answered by answerForm and omp accepts the data the model then reads",
		async () => {
			const FORM_HTML =
				'<form><label><input type="radio" name="db" value="sqlite" checked> SQLite</label>' +
				'<label><input type="radio" name="db" value="pg"> Postgres</label>' +
				'<label><input type="checkbox" name="tests" value="yes"> Run tests</label>' +
				'<fieldset><legend>Features</legend><label><input type="checkbox" name="features" value="auth"> Auth</label>' +
				'<label><input type="checkbox" name="features" value="cache"> Cache</label></fieldset>' +
				'<label>Replicas <input type="number" name="replicas" min="1" max="5"></label>' +
				'<label>Service name <input name="svc" required></label></form>';
			// The owner's inputs in card order: click Postgres, click yes, reply "1,2", "3", "web".
			const script: ChoiceEvent[] = [
				{ kind: "choice", index: 1 },
				{ kind: "choice", index: 2 },
				{ kind: "text", text: "1,2" },
				{ kind: "text", text: "3" },
				{ kind: "text", text: "web" },
			];
			const broker = {
				choose: async () => ({
					next: async (): Promise<ChoiceResult> => script.shift() ?? { kind: "cancelled" },
					update: async () => undefined,
					close: async () => undefined,
				}),
				holdInput: () => undefined,
				takeInput: () => undefined,
				dropInput: () => undefined,
				recordAutoChoices: () => undefined,
			} as unknown as ApprovalBroker;
			const origin = { originKey: "contract/form", channel: "C1" };
			const seen: Array<{ method: string; response: unknown }> = [];
			const driver = new RpcOmpDriver({
				ompExecutable: OMP_EXECUTABLE,
				cwd,
				sessionDir: join(root, "sessions", "form"),
				provider: PROVIDER,
				model: MODEL,
				thinking: "low",
				env: { OMP_WIKI_NOTE_DISABLE: "1" },
				answerDialog: async (request, signal) => {
					const response = await answerDialog(broker, origin, request, signal);
					seen.push({ method: request.method, response });
					return response;
				},
			});
			drivers.push(driver);
			const rec = new Recorder(driver);
			await driver.start();
			await driver.openSession();
			const opRef = await driver.prompt(
				`Call the ask tool exactly once with this exact html argument, then reply with only the JSON data the tool returned:\n${FORM_HTML}`,
			);
			const final = await rec.final(opRef);
			expect(final.status).toBe("completed");
			expect(seen.map((item) => item.method)).toEqual(["form"]);
			expect(seen[0]?.response).toEqual({
				data: { db: "pg", tests: "yes", features: ["auth", "cache"], replicas: 3, svc: "web" },
			});
			const entry = (await driver.entriesSince()).entries.find(
				(item) => item.message?.role === "toolResult" && (item.message as { toolName?: string }).toolName === "ask",
			);
			// omp took the data (a rejected form comes back as a tool error) and handed the model this JSON.
			const text = entryText(entry ?? { id: "", type: "" });
			expect(text).toStartWith("User answers:");
			console.log(`[omp ${OMP_VERSION.trim()}] ask tool result the model saw: ${text}`);
			expect(JSON.parse(text.slice(text.indexOf("{")))).toEqual({
				db: "pg",
				tests: "yes",
				features: ["auth", "cache"],
				replicas: 3,
				svc: "web",
			});
			expect(final.text).toContain("web");
		},
		TURN_TIMEOUT_MS,
	);

	test("(e) no interactive approval/question UI requests during the whole run", () => {
		const interactive = recorders.flatMap((rec) =>
			rec.events.filter(
				(event) => event.type === "extension_ui_request" && INTERACTIVE_UI_METHODS.includes(String(event.method)),
			),
		);
		expect(interactive).toEqual([]);
	});
});
