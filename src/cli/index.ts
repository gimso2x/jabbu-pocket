import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, defaultHomeDir, type JabbuConfig, loadConfig, timezoneOfHome } from "../config";
import { escapeControl, runDoctor } from "../daemon/doctor";
import { callDaemon, callDaemonWhenUp, IpcNoResponse } from "../daemon/ipc";
import { runDaemon } from "../daemon/run";
import { frozenField, readStatusFromDb, renderStatusText, type StatusReport } from "../daemon/status";
import { readVersion } from "../daemon/tools";
import { dispatchEnv, herdrSshArgv, type ProcessRunner, realProcessRunner } from "../dispatch/omp";
import { readConfigText } from "../ops/apply";
import { type BackupResult, DEFAULT_KEEP, runBackup } from "../ops/backup";
import { BackupError } from "../ops/backup-error";
import { clearFreeze, freezePath, readFreeze, writeFreeze } from "../ops/freeze";
import { gateOptionsFromConfig } from "../ops/gates";
import { DEFAULT_SESSION_RETENTION_DAYS, gcSessions } from "../ops/gc";
import { OffsiteError, type OffsiteResult, runOffsite } from "../ops/offsite";
import { testHostLoad, testStatfs } from "../ops/test-host-hooks";
import { APPLY_USAGE, applyCommand } from "./apply";
import { DASHBOARD_USAGE, dashboardCommand } from "./dashboard";
import { DELIVERIES_USAGE, deliveriesCommand } from "./deliveries";
import { DRAIN_USAGE, drainCommand } from "./drain";
import { GATES_USAGE, type GatesCommandDeps, gatesCommand } from "./gates";
import { loadConfigIfPresent } from "./home-config";
import { INIT_USAGE, initCommand } from "./init";
import { LANES_USAGE, lanesCommand } from "./lanes";
import { joinLines, stripExtensionPath } from "./linear-text";
import { MONITORS_USAGE, monitorsCommand } from "./monitors";
import { OMP_USAGE, ompCommand } from "./omp";
import { RESTORE_USAGE, restoreCommand } from "./restore";
import { SKILLS_USAGE, skillsCommand } from "./skills";
import { TASKS_USAGE, tasksCommand } from "./tasks";
import { TRACE_INPUTS_USAGE, traceInputsCommand } from "./trace-inputs";
import { UNITS_USAGE, unitsCommand } from "./units";

/** ssh's own ConnectTimeout is 5 s; the whole check gets a little more. */
const DISPATCH_HOST_CHECK_MS = 10_000;
/** How long `inject` keeps trying while no daemon listens (a restart takes up to about two minutes). */
const INJECT_WAIT_MS = 180_000;

const USAGE = `usage: jabbu-pocket <command>
${INIT_USAGE}${UNITS_USAGE}  daemon                         run the bot (single instance)
  status [--json]                ledger counts, origins, omp version
  doctor                         check home, secrets, omp, omp runtime, bun, Discord auth, backup bundle; then herdr --version and the herdr omp
                                 integration (herdr on), and ssh reach plus the herdr omp integration per dispatchHosts entry (integration
                                 and host lines are warnings and do not change the exit code)
  gc [--dry-run]                 delete previous-epoch session dirs, idle thread origins and deleted-monitor origins older than sessionRetentionDays (default 30)
  backup [--keep N] [--max-bundle-bytes N]    consistent jabbu.db snapshot (VACUUM INTO), quick_check, retention: 14 days (one per day, all of the run's day) + stamp
                                 + sessions/config.json/workspace/scripts bundle (tar.gz, sha256 in the stamp) when they exist; the
                                 bundle source-bytes cap (sum of the sources, not the tar.gz size) defaults to 512MB (config maxBundleBytes, --max-bundle-bytes overrides)
                                 with config offsite {ssh, remoteDir, keep?}, a good backup is then copied off-site
                                 (exit 4 when only the off-site copy failed; the local backup and its stamp stay)
  freeze [--reason <t>]          write <home>/FROZEN: remote dispatch, monitor fires, new work lanes, running lanes' automatic
                                 re-prompts, pending autonomous rows (peer mentions, monitor and lane-directive rows), task
                                 reminders and skill reviews stop within seconds (owner chat turns keep
                                 working); a due 'at' monitor waits and fires once after unfreeze; the 'frozen' gate stays
                                 open until unfreeze
  unfreeze                       remove <home>/FROZEN
${GATES_USAGE}  inject --origin discord/<dm|ch>/ID --as-owner --text <t> [--quoted <q>] [--thread <message id>]
                                 while no daemon listens (a restart) it tries again every 2s for up to 3 minutes
  reload                         running daemon re-reads config.json (also SIGHUP): policy fields apply live,
                                 startup-bound fields are listed as restart_required; an invalid file changes nothing
${DRAIN_USAGE}${DELIVERIES_USAGE}${APPLY_USAGE}${OMP_USAGE}${RESTORE_USAGE}${MONITORS_USAGE}${TASKS_USAGE}${LANES_USAGE}${SKILLS_USAGE}${DASHBOARD_USAGE}${TRACE_INPUTS_USAGE}`;

/** The fields `renderStatusText` and `--json` readers rely on; a reply without them is not a status report. */
function isStatusReport(value: unknown): value is StatusReport {
	if (typeof value !== "object" || value === null) return false;
	const report = value as Partial<Record<keyof StatusReport, unknown>>;
	const isObject = (field: unknown): boolean => typeof field === "object" && field !== null;
	return (
		typeof report.ompVersion === "string" &&
		typeof report.timezone === "string" &&
		typeof report.daemonRunning === "boolean" &&
		Array.isArray(report.origins) &&
		isObject(report.ledger) &&
		isObject(report.inbound) &&
		isObject(report.monitors) &&
		Array.isArray(report.openGates)
	);
}

function isStatusResponse(value: unknown): value is { ok: true; status: StatusReport } {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		value.ok === true &&
		"status" in value &&
		isStatusReport(value.status)
	);
}

function gcCommand(args: string[], homeDir: string): number {
	const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" } } });
	const dryRun = values["dry-run"] === true;
	const result = gcSessions({
		homeDir,
		retentionDays: loadConfigIfPresent(homeDir)?.sessionRetentionDays ?? DEFAULT_SESSION_RETENTION_DAYS,
		now: Date.now(),
		dryRun,
	});
	const verb = dryRun ? "would_remove" : "removed";
	for (const path of result.removed) process.stdout.write(`gc ${verb} path=${path}\n`);
	for (const key of result.threadOriginsRemoved) {
		process.stdout.write(`gc thread_${verb} origin=${key}\n`);
	}
	for (const key of result.monitorOriginsRemoved) {
		process.stdout.write(`gc monitor_${verb} origin=${key}\n`);
	}
	for (const path of result.laneArtifactsRemoved) process.stdout.write(`gc lane_artifacts_${verb} path=${path}\n`);
	process.stdout.write(
		`gc_done ${verb}=${result.removed.length} retained=${result.retained.length} threads=${result.threadOriginsRemoved.length} monitors=${result.monitorOriginsRemoved.length} lane_artifacts=${result.laneArtifactsRemoved.length} inbound=${result.ledgerRemoved.inbound} deliveries=${result.ledgerRemoved.deliveries} delivery_posts=${result.ledgerRemoved.deliveryPosts} monitor_events=${result.ledgerRemoved.monitorEvents}\n`,
	);
	return 0;
}

const firstLine = (text: string | undefined): string => text?.trim().split("\n")[0]?.trim() ?? "";

/**
 * Reach check per `dispatchHosts` entry, run together: one `ok`/`fail <ssh's first stderr line>` line each, in config
 * order, each followed by that host's herdr omp integration line.
 */
async function checkDispatchHosts(config: JabbuConfig, run: ProcessRunner): Promise<string[]> {
	const perHost = await Promise.all(
		Object.entries(config.dispatchHosts ?? {}).map(async ([key, host]) => {
			// config only warns about a control character in a host name; on a doctor line it must not start a new line.
			const name = escapeControl(key);
			const [result, integration] = await Promise.all([
				run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", host.ssh, "true"], {
					timeoutMs: DISPATCH_HOST_CHECK_MS,
					env: dispatchEnv(process.env),
				}),
				checkHerdrIntegration(herdrSshArgv(host.ssh, host.herdrBin ?? "herdr", ["integration", "status"]), run),
			]);
			const integrationLine = `${integration.ok ? "ok" : "fail"} herdr omp integration on ${name}: ${integration.detail}`;
			if (result.code === 0 && !result.timedOut) return [`ok dispatch host ${name}: ssh ${host.ssh}`, integrationLine];
			const reason = result.timedOut
				? "timed out"
				: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
			return [`fail dispatch host ${name}: ${reason} (warning only)`, integrationLine];
		}),
	);
	return perHost.flat();
}

/**
 * `herdr integration status` (one `<agent>: <state> (…)` line per agent): the `omp:` line must say `current`, or the
 * agent_status herdr reports for omp workers (blocked, idle…) never changes. A miss is a warning: the detail ends in
 * the install command and `(warning only)`.
 */
async function checkHerdrIntegration(cmd: string[], run: ProcessRunner): Promise<{ ok: boolean; detail: string }> {
	const result = await run(cmd, { timeoutMs: DISPATCH_HOST_CHECK_MS, env: dispatchEnv(process.env) });
	const fix = "— herdr integration install omp (warning only)";
	if (result.code !== 0 || result.timedOut) {
		const reason = result.timedOut
			? "timed out"
			: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
		return { ok: false, detail: `integration status failed: ${reason} ${fix}` };
	}
	const omp = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("omp:"));
	if (omp === undefined) return { ok: false, detail: `no omp line ${fix}` };
	const summary = stripExtensionPath(omp);
	return /^omp:\s*current\b/.test(omp) ? { ok: true, detail: summary } : { ok: false, detail: `${summary} ${fix}` };
}

/** Local herdr (config `herdr` on): `<bin> --version` must answer; the line carries its first output line or why not. */
async function checkLocalHerdr(herdr: { bin?: string }, run: ProcessRunner): Promise<{ ok: boolean; line: string }> {
	const bin = herdr.bin ?? "herdr";
	const result = await run([bin, "--version"], { timeoutMs: DISPATCH_HOST_CHECK_MS, env: dispatchEnv(process.env) });
	if (result.code === 0 && !result.timedOut)
		return { ok: true, line: `ok herdr: ${bin} ${firstLine(result.stdout)}`.trim() };
	const reason = result.timedOut
		? "timed out"
		: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
	return { ok: false, line: `fail herdr: ${bin} ${reason}` };
}

/**
 * `jabbu-pocket doctor`: the doctor checks, then (herdr on) the local herdr version and its omp integration, then per dispatch
 * host one reach line and one omp integration line. A host may be switched off on purpose (a laptop), so its lines are
 * warnings and never change the exit code; an unreadable config was reported above. A local herdr that does not answer
 * while `herdr` is on is a failure (exit 1): dispatch and the [TASK] sweep need it. A missing omp integration is a
 * warning everywhere: herdr still runs the agents, only their waiting state goes unseen.
 */
export async function doctorCommand(
	homeDir: string,
	write: (line: string) => void,
	deps: { doctor?: typeof runDoctor; run?: ProcessRunner } = {},
): Promise<number> {
	// This checkout (src/cli/index.ts → repo root) holds the daemon's code and any code rollback journal.
	const code = await (deps.doctor ?? runDoctor)(homeDir, write, resolve(import.meta.dir, "..", ".."));
	let config: JabbuConfig | undefined;
	try {
		// runDoctor already reports a broken token file; reading it again here would end the herdr and dispatch checks.
		config = loadConfigIfPresent(homeDir, { checkTokens: false });
	} catch {
		return code;
	}
	if (config === undefined) return code;
	const run = deps.run ?? realProcessRunner;
	let exit = code;
	if (config.herdr !== undefined) {
		const herdr = await checkLocalHerdr(config.herdr, run);
		write(herdr.line);
		if (!herdr.ok && exit === 0) exit = 1;
		const integration = await checkHerdrIntegration([config.herdr.bin ?? "herdr", "integration", "status"], run);
		write(`${integration.ok ? "ok" : "fail"} herdr omp integration: ${integration.detail}`);
	}
	for (const line of await checkDispatchHosts(config, run)) write(line);
	return exit;
}

/** Runs the off-site copy and prints its lines; 0 on success, 4 on any off-site failure. */
async function offsiteRun(config: JabbuConfig, homeDir: string, json: boolean): Promise<number> {
	if (config.offsite === undefined) {
		process.stderr.write("offsite: config.json has no offsite {ssh, remoteDir} section\n");
		return 2;
	}
	let result: OffsiteResult;
	try {
		result = await runOffsite({ homeDir, target: config.offsite });
	} catch (error) {
		if (error instanceof OffsiteError) {
			process.stderr.write(`offsite failed: ${error.message}\n`);
			return 4;
		}
		throw error;
	}
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
		return 0;
	}
	for (const file of result.files) {
		process.stdout.write(`offsite ${file.status} file=${file.name} sha256=${file.sha256}\n`);
	}
	for (const name of result.removed) process.stdout.write(`offsite pruned file=${name}\n`);
	process.stdout.write(
		`offsite_done files=${result.files.length} removed=${result.removed.length} stamp=${result.stamp}\n`,
	);
	return 0;
}

async function backupCommand(args: string[], homeDir: string): Promise<number> {
	const { values } = parseArgs({ args, options: { keep: { type: "string" }, "max-bundle-bytes": { type: "string" } } });
	let keep = DEFAULT_KEEP;
	if (values.keep !== undefined) {
		keep = /^\d+$/.test(values.keep) ? Number(values.keep) : Number.NaN;
		if (!Number.isSafeInteger(keep)) {
			process.stderr.write("backup: --keep must be a non-negative integer\n");
			return 2;
		}
	}
	let flagBytes: number | undefined;
	if (values["max-bundle-bytes"] !== undefined) {
		const raw = values["max-bundle-bytes"];
		const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			process.stderr.write("backup: --max-bundle-bytes must be a positive integer\n");
			return 2;
		}
		flagBytes = parsed;
	}
	// The operator lever for homes whose sessions outgrew the 512MB default: config sets it, the flag overrides.
	const config = loadConfigIfPresent(homeDir);
	const maxBundleBytes = flagBytes ?? config?.maxBundleBytes;
	let result: BackupResult;
	try {
		result = runBackup({ homeDir, keep, ...(maxBundleBytes === undefined ? {} : { maxBundleBytes }) });
	} catch (error) {
		if (error instanceof BackupError) {
			process.stderr.write(`backup failed: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
	for (const path of result.removed) process.stdout.write(`backup pruned path=${path}\n`);
	process.stdout.write(
		`backup written file=${result.file} bytes=${result.bytes} sha256=${result.sha256} integrity=ok\n`,
	);
	if (result.bundle !== undefined) {
		process.stdout.write(
			`backup bundle file=${result.bundle} bytes=${result.bundleBytes} sha256=${result.bundleSha256}\n`,
		);
	}
	process.stdout.write(
		`backup_done kept=${result.kept.length} removed=${result.removed.length} stamp=${result.stamp}\n`,
	);
	return config?.offsite === undefined ? 0 : offsiteRun(config, homeDir, false);
}

/** The `JABBU_TEST_HOOKS=1` host readers as gates and status deps; none in production. */
function hostLoadDeps(env: Record<string, string | undefined>): GatesCommandDeps {
	const hostLoad = testHostLoad(env);
	const statfs = testStatfs(env);
	return {
		...(hostLoad === undefined ? {} : { hostLoad }),
		...(statfs === undefined ? {} : { statfs }),
	};
}

async function statusCommand(
	args: string[],
	homeDir: string,
	deps: Pick<GatesCommandDeps, "hostLoad" | "statfs"> = {},
): Promise<number> {
	const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
	const socketPath = join(homeDir, "jabbu.sock");
	let report: StatusReport | undefined;
	try {
		const response = await callDaemon(socketPath, { op: "status" }, 10_000);
		if (isStatusResponse(response)) report = response.status;
	} catch {
		report = undefined; // no daemon answering: fall back to the database file
	}
	if (!report) {
		const dbPath = join(homeDir, "jabbu.db");
		if (!existsSync(dbPath)) {
			process.stderr.write(`status: no daemon at ${socketPath} and no database at ${dbPath}\n`);
			// A home before its first boot can still be frozen: the freeze is a file, not a ledger row.
			const { frozen } = frozenField(homeDir);
			if (values.json === true) process.stdout.write(`${JSON.stringify({ frozen })}\n`);
			else if (frozen !== undefined) {
				process.stdout.write(
					`FROZEN · ${frozen.since} · ${frozen.by}${frozen.reason === "" ? "" : ` · ${frozen.reason}`}\n`,
				);
			}
			return 1;
		}
		// The database is the report; a db-only (recovery) home or broken token files must not hide it.
		let config: ReturnType<typeof loadConfigIfPresent>;
		try {
			config = loadConfigIfPresent(homeDir, { checkTokens: false });
		} catch (error) {
			// A broken config.json hides nothing the ledger can say; `doctor` names the same cause.
			process.stderr.write(`status: config unreadable, version and gate settings unknown: ${String(error)}\n`);
			config = undefined;
		}
		report = readStatusFromDb(
			dbPath,
			config === undefined ? "unknown" : await readVersion([config.ompExecutable, "--version"]),
			config?.timezone ?? timezoneOfHome(homeDir),
			gateOptionsFromConfig(config),
			deps.hostLoad,
			deps.statfs,
		);
	}
	process.stdout.write(`${values.json ? JSON.stringify(report) : renderStatusText(report)}\n`);
	return 0;
}

function freezeCommand(args: string[], homeDir: string): number {
	const { values } = parseArgs({ args, options: { reason: { type: "string" } } });
	if (!existsSync(homeDir) || !statSync(homeDir).isDirectory()) {
		process.stderr.write(`freeze: no home at ${homeDir} (not a directory)\n`);
		return 1;
	}
	const state = writeFreeze(homeDir, {
		...(values.reason === undefined ? {} : { reason: values.reason }),
		by: "cli",
		now: Date.now(),
	});
	process.stdout.write(
		`frozen since=${state.since} by=${state.by}${state.reason === "" ? "" : ` reason=${JSON.stringify(state.reason)}`}\n`,
	);
	return 0;
}

function unfreezeCommand(homeDir: string): number {
	const was = readFreeze(homeDir) !== undefined;
	try {
		clearFreeze(homeDir);
	} catch (error) {
		// Whatever blocks the removal or the unfrozen-at stamp: FROZEN stays, the owner learns the path and errno.
		const { code, path } = error as NodeJS.ErrnoException;
		process.stderr.write(`unfreeze: ${path ?? freezePath(homeDir)}: ${code ?? String(error)}\n`);
		return 1;
	}
	process.stdout.write(was ? "unfrozen\n" : "not frozen\n");
	return 0;
}

async function injectCommand(args: string[], homeDir: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			origin: { type: "string" },
			"as-owner": { type: "boolean" },
			text: { type: "string" },
			quoted: { type: "string" },
			thread: { type: "string" },
		},
	});
	if (!values["as-owner"] || values.origin === undefined || values.text === undefined) {
		process.stderr.write(`inject needs --origin, --as-owner and --text\n${USAGE}`);
		return 2;
	}
	// The daemon posts its marker before it judges the text: a blank text would leave an empty marker behind.
	if (values.text.trim() === "") {
		process.stderr.write("inject: --text is empty; give the message text\n");
		return 2;
	}
	// A detached follow-up started without JABBU_HOME lands on the default home, where no daemon will ever come up:
	// say so now instead of waiting out INJECT_WAIT_MS and failing as if the daemon were restarting.
	if (!existsSync(join(homeDir, "config.json"))) {
		process.stderr.write(`inject: ${homeDir} is not a jabbu home (no config.json); set JABBU_HOME to the bot's home\n`);
		return 1;
	}
	let response: unknown;
	try {
		// A detached follow-up may fire while the daemon restarts: wait for the next one instead of losing the message.
		response = await callDaemonWhenUp(
			join(homeDir, "jabbu.sock"),
			{
				op: "inject",
				origin: values.origin,
				asOwner: true,
				text: values.text,
				quoted: values.quoted,
				thread: values.thread,
			},
			INJECT_WAIT_MS,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof IpcNoResponse) {
			// The request went out: the daemon may already have posted the marker and queued the message.
			process.stderr.write(
				`inject: no daemon answer (${message}) — the request may have been delivered; check the conversation before retrying\n`,
			);
		} else process.stderr.write(`inject: daemon not reachable (${message})\n`);
		return 1;
	}
	if (
		typeof response === "object" &&
		response !== null &&
		"ok" in response &&
		response.ok === true &&
		"nonce" in response &&
		"threadRef" in response
	) {
		process.stdout.write(`${JSON.stringify({ nonce: response.nonce, threadRef: response.threadRef })}\n`);
		return 0;
	}
	const reason =
		typeof response === "object" && response !== null && "error" in response ? String(response.error) : "unknown";
	process.stderr.write(`inject failed: ${reason}\n`);
	return 1;
}

/** `jabbu-pocket reload`: the running daemon re-reads config.json (same as SIGHUP); exit 1 when it kept the old config. */
async function reloadCommand(homeDir: string): Promise<number> {
	let answer: unknown;
	try {
		answer = await callDaemon(join(homeDir, "jabbu.sock"), { op: "reload" }, 10_000);
	} catch (error) {
		process.stderr.write(`reload: daemon not reachable (${error instanceof Error ? error.message : String(error)})\n`);
		return 1;
	}
	if (typeof answer === "object" && answer !== null && "ok" in answer && answer.ok === false) {
		process.stderr.write(`reload failed, config unchanged: ${"error" in answer ? String(answer.error) : "unknown"}\n`);
		return 1;
	}
	const isNames = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((item) => typeof item === "string");
	if (typeof answer !== "object" || answer === null) {
		process.stderr.write("reload: unexpected daemon answer\n");
		return 1;
	}
	const response: { ok?: unknown; changed?: unknown; restartRequired?: unknown; cli?: unknown } = answer;
	if (
		response.ok !== true ||
		!isNames(response.changed) ||
		!isNames(response.restartRequired) ||
		!isNames(response.cli)
	) {
		process.stderr.write("reload: unexpected daemon answer\n");
		return 1;
	}
	const list = (fields: string[]) => (fields.length === 0 ? "-" : fields.join(","));
	process.stdout.write(
		`config_reloaded changed=${list(response.changed)} restart_required=${list(response.restartRequired)} cli=${list(response.cli)}\n`,
	);
	return 0;
}

/** Entry point of `jabbu`; resolves with the process exit code. */
export async function runCli(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
	const [command, ...rest] = argv;
	const homeDir = resolve(defaultHomeDir(env));
	try {
		switch (command) {
			case "init":
				return initCommand(rest, env);
			case "units":
				return unitsCommand(rest, env);
			case "daemon": {
				// Read right before loadConfig validates it: only this text may become config.json.last-good at ready.
				const bootConfigText = readConfigText(homeDir);
				return await runDaemon(loadConfig(homeDir), env, bootConfigText);
			}
			case "status":
				return await statusCommand(rest, homeDir, hostLoadDeps(env));
			case "doctor":
				return await doctorCommand(homeDir, (line) => process.stdout.write(`${line}\n`));
			case "gc":
				return gcCommand(rest, homeDir);
			case "backup":
				return await backupCommand(rest, homeDir);
			case "freeze":
				return freezeCommand(rest, homeDir);
			case "unfreeze":
				return unfreezeCommand(homeDir);
			case "gates":
				return gatesCommand(rest, homeDir, hostLoadDeps(env));
			case "inject":
				return await injectCommand(rest, homeDir);
			case "drain":
				return await drainCommand(rest, homeDir);
			case "deliveries":
				return deliveriesCommand(rest, homeDir);
			case "apply":
				return await applyCommand(rest, homeDir, env);
			case "omp":
				return await ompCommand(rest, homeDir, env);
			case "restore":
				return await restoreCommand(rest, homeDir);
			case "reload":
				return await reloadCommand(homeDir);
			case "monitors":
				return await monitorsCommand(rest, homeDir);
			case "tasks":
				return await tasksCommand(rest, homeDir);
			case "lanes":
				return await lanesCommand(rest, homeDir);
			case "skills":
				return skillsCommand(rest, env);
			case "dashboard":
				return await dashboardCommand(rest, homeDir);
			case "trace-inputs":
				return traceInputsCommand(rest, homeDir, env);
			default:
				process.stderr.write(USAGE);
				return command === undefined || command === "--help" || command === "help" ? 0 : 2;
		}
	} catch (error) {
		// node:util parseArgs (unknown option, missing value, `--days -1`): an argument mistake, so a usage error.
		if (isParseArgsError(error)) {
			process.stderr.write(`${command}: ${joinLines(error.message)} (jabbu-pocket --help)\n`);
			return 2;
		}
		process.stderr.write(`${command}: ${error instanceof ConfigError ? error.message : String(error)}\n`);
		return 1;
	}
}

function isParseArgsError(error: unknown): error is Error {
	return error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS_");
}
