import { accessSync, chmodSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultHomeDir, HOME_MODE, SECRET_MODE, workspaceOverlapsHome } from "../config";
import { remoteShellQuote } from "../dispatch/omp";
import { lstatSafe } from "./home-config";

export const INIT_USAGE = `  init [--platform discord] --owner <Discord user id> --app-id <application id> [--omp <abs path>] [--workspace <dir>] | --help
                                 create the home (0700), secrets/ (0700), the workspace and a minimal config.json (0600);
                                 --omp defaults to omp on PATH, --workspace to <home>/workspace; never writes tokens and
                                 never touches an existing config.json (exit 2)
`;

const SNOWFLAKE = /^[0-9]{17,20}$/;
const CONTROL_CHARS = /\p{Cc}/u;
const hasControlChars = (value?: string): boolean => value !== undefined && CONTROL_CHARS.test(value);

function fail(message: string): number {
	process.stderr.write(`init: ${message}\n${INIT_USAGE}`);
	return 2;
}

/** `jabbu-pocket init`: every argument is checked before anything is created, so a refused run leaves no trace. */
export function initCommand(args: string[], env: Record<string, string | undefined>): number {
	let values: Partial<Record<"owner" | "omp" | "workspace" | "platform" | "app-id", string>> & { help?: boolean };
	try {
		({ values } = parseArgs({
			args,
			options: {
				owner: { type: "string" },
				platform: { type: "string" },
				"app-id": { type: "string" },
				omp: { type: "string" },
				workspace: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (values.help === true) {
		process.stdout.write(INIT_USAGE);
		return 0;
	}
	if ((values.platform ?? "discord") !== "discord") return fail("--platform must be discord");
	if (values.owner === undefined || !SNOWFLAKE.test(values.owner))
		return fail("--owner must be a Discord id (17-20 digits)");
	if (values["app-id"] === undefined || !SNOWFLAKE.test(values["app-id"]))
		return fail("--app-id must be a Discord id (17-20 digits)");
	// An empty value would resolve to the current directory; leave the option out to get the default instead.
	if (values.omp === "") return fail("--omp is empty; leave it out to use omp on PATH");
	if (values.omp !== undefined && !isAbsolute(values.omp)) return fail("--omp must be an absolute path");
	if (values.workspace === "") return fail("--workspace is empty; leave it out to use <home>/workspace");
	const omp = values.omp === undefined ? Bun.which("omp", { PATH: env.PATH ?? "" }) : resolve(values.omp);
	if (omp === null) return fail("omp not found on PATH; pass --omp <absolute path to omp>");
	if (hasControlChars(values.omp) || hasControlChars(omp)) return fail("--omp contains control characters");
	if (!existsSync(omp)) return fail(`--omp ${omp} does not exist`);
	if (!statSync(omp).isFile()) return fail(`--omp ${omp} is a directory, not the omp executable`);
	try {
		accessSync(omp, constants.X_OK);
	} catch {
		return fail(`--omp ${omp} is not executable`);
	}

	const homeDir = resolve(defaultHomeDir(env));
	if (hasControlChars(env.JABBU_HOME) || hasControlChars(homeDir)) return fail("home contains control characters");
	const configPath = join(homeDir, "config.json");
	if (lstatSafe(configPath) !== undefined) return fail(`${configPath} already exists; nothing changed`);
	const workspaceDir = resolve(values.workspace ?? join(homeDir, "workspace"));
	if (hasControlChars(values.workspace) || hasControlChars(workspaceDir))
		return fail("--workspace contains control chars");
	const secretsDir = join(homeDir, "secrets");
	if (workspaceOverlapsHome(homeDir, workspaceDir))
		return fail(`--workspace ${workspaceDir} is the home, config.json or inside secrets/; pick another directory`);
	// mkdir fails halfway (raw EEXIST/ENOTDIR, a bare home left behind) when a file or dangling link sits in the path.
	for (const [label, dir] of [
		["home", homeDir],
		["home", secretsDir],
		["--workspace", workspaceDir],
	] as const) {
		let existing = dir;
		while (lstatSafe(existing) === undefined && dirname(existing) !== existing) existing = dirname(existing);
		if (statSync(existing, { throwIfNoEntry: false })?.isDirectory() !== true)
			return fail(`${label} ${dir}: ${existing} is not a directory`);
	}
	// chmod follows links: a home or secrets/ that is a symlink (or not a directory) would change a path outside.
	for (const dir of [homeDir, secretsDir]) {
		const st = lstatSafe(dir);
		if (st !== undefined && (st.isSymbolicLink() || !st.isDirectory()))
			return fail(`home ${dir} is a symlink or not a directory; nothing changed`);
	}
	mkdirSync(homeDir, { recursive: true, mode: HOME_MODE });
	chmodSync(homeDir, HOME_MODE);
	mkdirSync(secretsDir, { recursive: true, mode: HOME_MODE });
	chmodSync(secretsDir, HOME_MODE);
	mkdirSync(workspaceDir, { recursive: true });
	chmodSync(workspaceDir, HOME_MODE);
	const config = {
		schemaVersion: 1,
		channels: {
			discord: {
				ownerUserId: values.owner,
				botTokenFile: "secrets/discord-bot-token",
				applicationId: values["app-id"],
			},
		},
		ompExecutable: omp,
		workspaceDir,
		sessionRetentionDays: 30,
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: SECRET_MODE, flag: "wx" });
	chmodSync(configPath, SECRET_MODE);

	const homePrefix = env.JABBU_HOME ? `JABBU_HOME=${remoteShellQuote(homeDir)} ` : "";
	process.stdout.write(
		`init_done home=${homeDir} config=${configPath} workspace=${workspaceDir}\n` +
			"next: put the Discord bot token into a file (never into chat or shell history), then run doctor:\n" +
			"  umask 077\n" +
			`  cat > ${remoteShellQuote(join(secretsDir, "discord-bot-token"))}   # paste the bot token then Ctrl-D\n` +
			`  ${homePrefix}bun src/main.ts doctor\n`,
	);
	return 0;
}
