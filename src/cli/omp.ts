import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { type JabbuConfig, loadConfig } from "../config";
import { countOmpModels } from "../daemon/doctor-omp";
import { botRpcEnv, splitModel } from "../daemon/run";
import { dispatchEnv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import type { OmpFinal } from "../omp/driver";
import { buildChildEnv, withOmpProfile } from "../omp/env";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { checkOmpRuntime, type OmpRuntimeProblem } from "../omp/runtime-check";
import { lastSyncPath, profileAgentDir, runProfileSync, sourceAgentDir, syncProfile, userHomeOf } from "./omp-sync";

/** Profile-sync helpers, still reachable from `omp.ts` for the other CLI modules that import them here. */
export { profileAgentDir, runProfileSync, sourceAgentDir } from "./omp-sync";

export const OMP_USAGE = `  omp trial [--executable <abs>] trial-run the omp named by --executable (default: config ompExecutable) with the bot's env (runtime check, one RPC
                                 turn, one omp -p; the answer must contain OK); exit 0 when all three pass, else the failed
                                 stage and the log tail, exit 1. Run it after every omp update
  omp status                     global omp version, ompExecutable, the profile dir, last sync and pending changes, and
                                 whether that omp reads the login (models --json > 0, bot env); exit 1 when that check fails
  omp sync [--init]              copy the owner's omp agent dir into the bot profile (config ompProfile): RULES.md,
                                 extensions/, skills/, models.yml, mcp.json mirrored, config.yml with its agent-dir paths
                                 rewritten, agent.db(-shm,-wal) as symlinks to the owner's login, managed-skills/ added
                                 and updated (the bot's own kept); --init also copies the mnemopi memory once
`;

/** The trial prompt of `omp trial` (RPC turn and `omp -p`): the answer must contain `OK`. */
export const TRIAL_PROMPT = "정확히 OK 라고만 답해(다른 글자 없이)";
const TRIAL_TIMEOUT_MS = 120_000;
const FAIL_TAIL_LINES = 20;

export interface TrialResult {
	ok: boolean;
	detail: string;
}

export interface OmpCliDeps {
	homeDir: string;
	/** The bot's config (ompProfile, model, ompExecutable); absent when the home has no config.json. */
	config?: JabbuConfig;
	/** Parent env: HOME, PATH, PI_CODING_AGENT_DIR. */
	env: Record<string, string | undefined>;
	/** `--version` and the `omp -p` trial. */
	run: ProcessRunner;
	/** Trial ①: the `--version` check the RPC driver runs before every spawn. */
	runtimeCheck: (cliPath: string) => Promise<OmpRuntimeProblem | undefined>;
	/** Trial ②: one RPC turn through the driver the daemon uses. */
	rpcTrial: (input: { cliPath: string; cwd: string; profile?: string; model?: string }) => Promise<TrialResult>;
	/** `models --json` count with the bot env (number) or why it could not be read (string). */
	countModels: (cliPath: string, profile: string | undefined) => Promise<number | string>;
	out: (line: string) => void;
	now: () => number;
}

const tail = (text: string): string => text.trimEnd().split("\n").slice(-FAIL_TAIL_LINES).join("\n");

/** `jabbu-pocket omp trial`: the omp named by `--executable`, else config `ompExecutable`, with the bot's env: runtime check, one RPC turn, one `omp -p`. */
async function ompTrial(deps: OmpCliDeps, executable: string | undefined): Promise<number> {
	if (deps.config === undefined) {
		deps.out(`omp trial failed: no config.json in ${deps.homeDir} (ompExecutable unknown)`);
		return 1;
	}
	const cliPath = executable ?? deps.config.ompExecutable;
	const profile = deps.config.ompProfile;
	const model = deps.config.model;
	const fail = (stage: string, detail: string): number => {
		deps.out(`omp trial failed: ${stage} (${cliPath})`);
		if (detail.trim() !== "") deps.out(tail(detail));
		return 1;
	};

	const problem = await deps.runtimeCheck(cliPath);
	if (problem !== undefined) return fail("runtime", `${problem.code} ${problem.message}`);
	deps.out("omp_trial stage=runtime ok=true");

	const cwd = mkdtempSync(join(tmpdir(), "jabbu-omp-trial-"));
	try {
		const rpc = await deps.rpcTrial({
			cliPath,
			cwd,
			...(profile === undefined ? {} : { profile }),
			...(model === undefined ? {} : { model }),
		});
		if (!rpc.ok) return fail("rpc", rpc.detail);
		deps.out("omp_trial stage=rpc ok=true");

		const print = await deps.run(
			[cliPath, "-p", "--no-title", ...(model === undefined ? [] : ["--model", model]), TRIAL_PROMPT],
			{ cwd, timeoutMs: TRIAL_TIMEOUT_MS, env: withOmpProfile(dispatchEnv(deps.env), profile) },
		);
		const printed = `${print.stdout}\n${print.stderr ?? ""}`;
		if (print.timedOut) return fail("print", `timeout after ${TRIAL_TIMEOUT_MS / 1000}s\n${printed}`);
		if (print.code !== 0) return fail("print", `exit=${print.code ?? "killed"}\n${printed}`);
		if (!print.stdout.includes("OK") && !print.stdout.includes("네"))
			return fail("print", `no OK in the answer\n${printed}`);
		deps.out("omp_trial stage=print ok=true");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
	deps.out(`omp_trial ok executable=${cliPath}`);
	return 0;
}

/** `jabbu-pocket omp status`; exit 1 when the omp of `ompExecutable` (else the global one) cannot read the login. */
async function ompStatus(deps: OmpCliDeps): Promise<number> {
	const profile = deps.config?.ompProfile;
	const globalOmp = Bun.which("omp", { PATH: deps.env.PATH ?? "" });
	if (globalOmp === null) deps.out("global=none");
	else {
		const result = await deps.run([globalOmp, "--version"], { timeoutMs: 30_000, env: dispatchEnv(deps.env) });
		deps.out(`global=${result.stdout.trim().split("\n")[0] ?? ""} (${globalOmp})`);
	}
	if (deps.config !== undefined) deps.out(`ompExecutable=${deps.config.ompExecutable}`);
	if (profile === undefined) deps.out("profile=none (config ompProfile not set)");
	else {
		const target = profileAgentDir(userHomeOf(deps.env), profile);
		deps.out(`profile=${profile} dir=${target} exists=${existsSync(target) ? "yes" : "no"}`);
		const lastSync = existsSync(lastSyncPath(deps.homeDir))
			? readFileSync(lastSyncPath(deps.homeDir), "utf8").trim()
			: "never";
		let pending: string;
		try {
			pending = String(
				syncProfile({ source: sourceAgentDir(deps.env), target, userHome: userHomeOf(deps.env), dryRun: true }).changed
					.length,
			);
		} catch (error) {
			pending = `unknown (${error instanceof Error ? error.message : String(error)})`;
		}
		deps.out(`last_sync=${lastSync} pending_changes=${pending}`);
	}
	const loginOmp = deps.config?.ompExecutable ?? globalOmp;
	if (loginOmp === null || loginOmp === undefined) {
		deps.out("login fail: no omp (config ompExecutable unset, no omp on PATH)");
		return 1;
	}
	const models = await deps.countModels(loginOmp, profile);
	if (typeof models === "number" && models > 0) {
		deps.out(`login ok models=${models}`);
		return 0;
	}
	deps.out(
		`login fail ${typeof models === "number" ? "models=0 (this omp reads no login: agent.db schema or provider login)" : models}`,
	);
	return 1;
}

// ---------------------------------------------------------------- real trial and command

/** Trial ②: one turn through `RpcOmpDriver` (the daemon's driver, same env), `OK` expected within the deadline. */
async function realRpcTrial(
	input: { cliPath: string; cwd: string; profile?: string; model?: string },
	env: Record<string, string | undefined>,
	timeoutMs = TRIAL_TIMEOUT_MS,
): Promise<TrialResult> {
	const driver = new RpcOmpDriver({
		ompExecutable: input.cliPath,
		cwd: input.cwd,
		sessionDir: join(input.cwd, "session"),
		...splitModel(input.model),
		...botRpcEnv(input.profile, env),
		...(input.profile === undefined ? { baseEnv: env } : {}),
	});
	const final = Promise.withResolvers<OmpFinal>();
	// An exit after the answer (the stop below) rejects nothing anyone still waits on.
	final.promise.catch(() => undefined);
	driver.onFinal((f) => final.resolve(f));
	driver.onExit((info) => final.reject(new Error(`omp exited code=${info.code}: ${info.stderr.slice(-2_000)}`)));
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
	try {
		await Promise.race([driver.start(), deadline.promise]);
		await Promise.race([driver.prompt(TRIAL_PROMPT), deadline.promise]);
		const answer = await Promise.race([final.promise, deadline.promise]);
		if (answer.status !== "completed") return { ok: false, detail: `turn ${answer.status}: ${answer.error ?? ""}` };
		// The round trip is what is on trial; a Korean yes(네) is as good an answer as OK.
		if (!answer.text.includes("OK") && !answer.text.includes("네"))
			return { ok: false, detail: `no OK in the answer: ${answer.text.slice(0, 500)}` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
		await driver.stop().catch(() => undefined);
	}
	return { ok: true, detail: "ok" };
}

function realDeps(homeDir: string, env: Record<string, string | undefined>, out: (line: string) => void): OmpCliDeps {
	const config = existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir, { checkTokens: false }) : undefined;
	return {
		homeDir,
		...(config === undefined ? {} : { config }),
		env,
		run: realProcessRunner,
		runtimeCheck: (cliPath) => checkOmpRuntime(cliPath, buildChildEnv(undefined, env)),
		rpcTrial: (input) => realRpcTrial(input, env),
		countModels: (cliPath, profile) => countOmpModels(cliPath, 30_000, profile, env),
		out,
		now: () => Date.now(),
	};
}

/** `jabbu-pocket omp <sub>`; resolves with the exit code. */
export async function ompCommand(
	args: string[],
	homeDir: string,
	env: Record<string, string | undefined> = process.env,
	deps: OmpCliDeps = realDeps(homeDir, env, (line) => process.stdout.write(`${line}\n`)),
): Promise<number> {
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: { init: { type: "boolean" }, executable: { type: "string" } },
		strict: true,
	});
	const [sub, version, ...extra] = positionals;
	const usage = (): number => {
		process.stderr.write(`usage:\n${OMP_USAGE}`);
		return 2;
	};
	if (extra.length > 0 || (values.init === true && sub !== "sync")) return usage();
	if (values.executable !== undefined && (sub !== "trial" || !isAbsolute(values.executable))) return usage();
	switch (sub) {
		case "trial":
			return version === undefined ? await ompTrial(deps, values.executable) : usage();
		case "status":
			return version === undefined ? await ompStatus(deps) : usage();
		case "sync":
			if (version !== undefined) return usage();
			runProfileSync({
				homeDir: deps.homeDir,
				profile: deps.config?.ompProfile,
				env: deps.env,
				init: values.init === true,
				out: deps.out,
				now: deps.now,
			});
			return 0;
		default:
			return usage();
	}
}
