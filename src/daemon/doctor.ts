import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, HOME_MODE, type JabbuConfig, loadConfig, readDiscordToken, SECRET_MODE } from "../config";
import { DiscordRest } from "../discord/rest";
import { checkOmpRuntime } from "../omp/runtime-check";
import { CODE_ROLLBACK_JOURNAL, type CodeRollbackJournal, readCodeRollbackJournal } from "../ops/apply";
import { BUNDLE_SOURCES, readStamp } from "../ops/backup";
import { BACKUP_MAX_AGE_MS } from "../ops/gates";
import { OWNER_NOTES_MAX_BYTES, PERSONA_MAX_BYTES, SOUL_MAX_BYTES } from "../safety/prompt";
import { checkCoreDumpLimit } from "./core-dump";
import { listOmpModels, readJudgeRole } from "./doctor-omp";
import { readVersion } from "./tools";

/** Config errors that only concern the token files; doctor reports those per file and keeps going. */
const isTokenFileError = (error: unknown): error is ConfigError =>
	error instanceof ConfigError &&
	(error.code === "secret_missing" ||
		error.code === "secret_permissions" ||
		(error.code === "config_invalid" && error.message.includes("field=channels.discord.botTokenFile")));

/** `\uXXXX` for every control and format character, so a value read from a file cannot start a new doctor line. */
export const escapeControl = (text: string): string =>
	text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const octal = (mode: number): string => `0${mode.toString(8)}`;

type Report = (ok: boolean, name: string, detail: string) => void;

/**
 * `channels.discord` set: the token file's mode, then the token against `GET /users/@me` (bot id and name) and
 * `GET /gateway/bot` (gateway URL). Only ids, names and URLs are printed. Off: no line at all.
 */
export async function checkDiscord(
	config: JabbuConfig,
	report: Report,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const discord = config.channels.discord;
	if (discord === undefined) return;
	const tokenMissing = `missing: ${discord.botTokenFile} (put the bot token there, mode 0600)`;
	let token: string;
	try {
		const mode = modeOf(discord.botTokenFile);
		report(mode === SECRET_MODE, "discord token", `mode=${octal(mode)} expected=${octal(SECRET_MODE)}`);
		if (mode !== SECRET_MODE) return;
		token = readDiscordToken(config);
	} catch (error) {
		report(false, "discord token", error instanceof ConfigError ? error.code : tokenMissing);
		return;
	}
	const rest = new DiscordRest({ token, fetchImpl });
	try {
		const user = await rest.getCurrentUser();
		report(true, "discord users/@me", escapeControl(`bot_user_id=${user.id} username=${user.username ?? "?"}`));
	} catch (error) {
		report(false, "discord users/@me", escapeControl(error instanceof Error ? error.message : String(error)));
	}
	try {
		const gateway = await rest.getGatewayBot();
		report(true, "discord gateway/bot", escapeControl(`url=${gateway.url}`));
	} catch (error) {
		report(false, "discord gateway/bot", escapeControl(error instanceof Error ? error.message : String(error)));
	}
}

/**
 * The `backup bundle` line. The bundle carries the conversation memory and operator files (sessions/, config.json,
 * workspace/, scripts/); a home that only backs up the ledger is half protected, so the stamp must name a bundle that
 * still exists and is fresh. A ledger-only home has no bundle sources at all — `runBackup` correctly writes no bundle
 * there, so that stamp passes.
 */
export function checkBackupBundle(homeDir: string, report: Report, warn: (name: string, detail: string) => void): void {
	const stamp = readStamp(join(homeDir, "backups"));
	const bundleSources = BUNDLE_SOURCES.filter((name) => existsSync(join(homeDir, name)));
	if (stamp === undefined && !existsSync(join(homeDir, "jabbu.db"))) {
		// The daemon has never started: there is nothing to back up yet, and its first start makes the first backup.
		warn("backup bundle", "stamp=missing (first install: the daemon makes the first backup when it starts)");
	} else if (stamp === undefined) {
		report(false, "backup bundle", "stamp=missing (run jabbu-pocket backup once and enable jabbu-backup.timer)");
	} else if (stamp.bundle === undefined && bundleSources.length > 0) {
		report(false, "backup bundle", "bundle=none (run jabbu-pocket backup again)");
	} else if (stamp.bundle === undefined) {
		report(true, "backup bundle", "sources=none (ledger-only home)");
	} else if (!existsSync(join(homeDir, "backups", stamp.bundle))) {
		report(false, "backup bundle", `bundle=${escapeControl(stamp.bundle)} missing`);
	} else {
		const hours = (Date.now() - stamp.ts.getTime()) / 3_600_000;
		report(
			hours <= BACKUP_MAX_AGE_MS / 3_600_000,
			"backup bundle",
			`bundle=${escapeControl(stamp.bundle)} hours=${hours.toFixed(1)}`,
		);
	}
}

/** Share of an injected file's cap from which doctor warns that it is about to be cut. */
const INJECTED_WARN_RATIO = 0.9;

/**
 * `warn` lines for the workspace files the floors prompt injects (`persona.md`, `soul.md`, `owner.md`) at or over 90%
 * of their cap, or past it (then their tail is cut off). Sizes are of the symlink target; a missing file says nothing.
 */
export function checkInjectedFiles(homeDir: string, warn: (name: string, detail: string) => void): void {
	const caps: ReadonlyArray<[string, number]> = [
		["persona.md", PERSONA_MAX_BYTES],
		["soul.md", SOUL_MAX_BYTES],
		["owner.md", OWNER_NOTES_MAX_BYTES],
	];
	for (const [name, cap] of caps) {
		let size: number;
		try {
			const stat = statSync(join(homeDir, "workspace", name));
			if (!stat.isFile()) {
				warn(`injected ${name}`, `${stat.isDirectory() ? "EISDIR: " : ""}not a regular file`);
				continue;
			}
			size = stat.size;
		} catch {
			continue;
		}
		const percent = Math.floor((size / cap) * 100);
		if (size > cap) {
			warn(`injected ${name}`, `${size}/${cap} bytes (${percent}%): over the cap, injected with its tail cut off`);
		} else if (size >= cap * INJECTED_WARN_RATIO) {
			warn(`injected ${name}`, `${size}/${cap} bytes (${percent}%): near the cap, trim it before it is cut off`);
		}
	}
}

/**
 * The `code rollback` line: a `detach` code rollback left the checkout on head.last-good (journal in the absolute git
 * dir), so the owner learns how to come back. Nothing when there is no journal or `repoDir` is not a git checkout.
 */
export function checkCodeRollbackJournal(repoDir: string, warn: (name: string, detail: string) => void): void {
	// qa-z #62: without git on PATH the spawn throws ENOENT and would kill the whole doctor run before the discord
	// check; a host without git has no checkout to report on anyway.
	if (Bun.which("git") === null) return;
	const gitDir = Bun.spawnSync(["git", "-C", repoDir, "rev-parse", "--absolute-git-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (gitDir.exitCode !== 0) return;
	const path = join(gitDir.stdout.toString().trim(), CODE_ROLLBACK_JOURNAL);
	let journal: CodeRollbackJournal | undefined;
	try {
		journal = readCodeRollbackJournal(gitDir.stdout.toString().trim());
	} catch (error) {
		warn(
			"code rollback",
			`${path} unreadable (${error instanceof Error ? error.message : String(error)}): check the checkout, then bun src/main.ts apply --clear-rollback`,
		);
		return;
	}
	if (journal === undefined) return;
	warn(
		"code rollback",
		`${escapeControl(journal.lastGood.slice(0, 7))}로 되돌린 상태(원인 ${escapeControl(journal.head.slice(0, 7))}, apply ${escapeControl(journal.stamp)}), 복귀: git checkout main && git pull --ff-only && bun src/main.ts apply`,
	);
}

/** The network calls `runDoctor` makes; tests pass fakes so the report never reaches Discord. */
export interface DoctorNetwork {
	fetchImpl?: typeof fetch;
}

/**
 * Prints one `ok`/`fail` line per check (`warn` lines never count as failures). Only paths, modes, token *prefixes* and public ids are printed; token values
 * never leave the config readers. Returns 0 when every check passed. With `repoDir` (the checkout the daemon runs),
 * a code rollback journal there is a warning.
 */
export async function runDoctor(
	homeDir: string,
	write: (line: string) => void,
	repoDir?: string,
	{ fetchImpl = fetch }: DoctorNetwork = {},
): Promise<number> {
	let failures = 0;
	const report = (ok: boolean, name: string, detail: string): void => {
		if (!ok) failures += 1;
		write(`${ok ? "ok" : "fail"} ${name}: ${escapeControl(detail)}`);
	};
	const warn = (name: string, detail: string): void => write(`warn ${name}: ${escapeControl(detail)}`);

	let config: JabbuConfig | undefined;
	try {
		if (!statSync(homeDir).isDirectory()) report(false, "home", `${homeDir} is not a directory`);
		else {
			const homeMode = modeOf(homeDir);
			report(homeMode === HOME_MODE, "home", `${homeDir} mode=${octal(homeMode)} expected=${octal(HOME_MODE)}`);
		}
	} catch {
		report(false, "home", `${homeDir} missing (no home yet: run the \`init\` command first)`);
	}
	// A token file problem is reported on its own `secret …` line below, so it must not hide every later check: the
	// config is loaded again without the token files and the report goes on.
	try {
		config = loadConfig(homeDir);
		report(true, "config", config.configPath);
	} catch (error) {
		let failure: unknown = error;
		if (isTokenFileError(error)) {
			try {
				config = loadConfig(homeDir, { checkTokens: false });
				report(true, "config", config.configPath);
			} catch (retry) {
				failure = retry;
			}
		}
		if (config === undefined) report(false, "config", failure instanceof ConfigError ? failure.message : "unreadable");
	}
	if (config) {
		try {
			accessSync(config.ompExecutable, constants.X_OK);
			const version = await readVersion([config.ompExecutable, "--version"]);
			report(version !== "unknown", "omp", `${config.ompExecutable} ${version}`);
		} catch {
			report(
				false,
				"omp",
				`${config.ompExecutable} not executable (set "ompExecutable" in ${config.configPath} to the output of: command -v omp)`,
			);
		}

		// The same check the RPC driver runs before every spawn, so an executable that does not answer `--version` as
		// omp fails here instead of on the first DM. Skipped when omp is missing (reported above) and for agent "agy",
		// which never spawns omp; a directory or an unreadable file is a failed line, not an exception.
		if ((config.agent ?? "omp") === "omp" && existsSync(config.ompExecutable)) {
			const problem = await checkOmpRuntime(config.ompExecutable);
			report(
				problem === undefined,
				"omp runtime",
				problem === undefined ? `executable=${config.ompExecutable}` : `${problem.code} ${problem.message}`,
			);
			const models = await listOmpModels(config.ompExecutable, 30_000, config.ompProfile);
			report(
				Array.isArray(models) && models.length > 0,
				"omp models",
				Array.isArray(models)
					? models.length > 0
						? `available=${models.length}`
						: "available=0 (run: omp login, or set a provider API key, as the account that runs jabbu)"
					: models,
			);
			// The configured default model is what the first turn asks for: a typo passes the count above and
			// fails only at the first turn (or a `model_stale_no_fallback` warn at session restore).
			if (config.model !== undefined && Array.isArray(models) && models.length > 0) {
				const listed = models.includes(config.model);
				report(
					listed,
					"omp model",
					listed
						? config.model
						: `${config.model} is not among the ${models.length} models omp lists (check "model" in ${config.configPath})`,
				);
			}
			// A missing judge role fails at runtime (worker-tier calls, auto review), so it is a `warn` here: the role is
			// the owner's to set and a warning never counts as a failed check. An unreadable answer is its own line: only
			// the missing role is actionable.
			const judge = await readJudgeRole(config.ompExecutable, config.ompConfigOverlay, 30_000, config.ompProfile);
			if ("model" in judge) report(true, "omp judge", `${judge.model}`);
			else if ("missing" in judge)
				warn(
					"omp judge",
					`modelRoles.judge is empty (set it in omp: /models → Roles → Judge, or modelRoles.judge in ${config.ompConfigOverlay ?? "the omp config"})`,
				);
			else warn("omp judge", `확인 불가 (${judge.unreadable})`);
		}

		// agent "agy": the Antigravity CLI must exist, and its Google login must be on disk (presence only).
		if (config.agent === "agy") {
			const given = config.agyExecutable ?? "agy";
			try {
				const executable = given.includes("/") ? given : (Bun.which(given) ?? "");
				if (executable === "") throw new Error("not on PATH");
				accessSync(executable, constants.X_OK);
				const version = await readVersion([executable, "--version"]);
				report(version !== "unknown", "agy", `${executable} ${version}`);
			} catch {
				report(false, "agy", `${given} not executable`);
			}
			const credentials = join(homedir(), ".gemini", "oauth_creds.json");
			const present = existsSync(credentials);
			report(present, "agy auth", present ? `${credentials} present` : `no ${credentials} (run: agy, then sign in)`);
		}
	}
	// The version beside the path is that bun's own answer; the bun running this report is named only when it differs.
	const bunPath = Bun.which("bun");
	const pathBunVersion = bunPath === null ? undefined : await readVersion([bunPath, "--version"]);
	report(
		bunPath !== null,
		"bun",
		bunPath === null
			? `not on PATH (running ${Bun.version})`
			: `${bunPath} ${pathBunVersion}${pathBunVersion === Bun.version ? "" : ` (running ${Bun.version})`}`,
	);

	checkBackupBundle(homeDir, report, warn);
	checkInjectedFiles(homeDir, warn);
	checkCoreDumpLimit(join(process.env.HOME || homedir(), ".config", "systemd", "user"), warn);
	if (repoDir !== undefined) checkCodeRollbackJournal(repoDir, warn);

	if (config) await checkDiscord(config, report, fetchImpl);
	return failures === 0 ? 0 : 1;
}
