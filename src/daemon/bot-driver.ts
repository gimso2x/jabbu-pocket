import { dirname, join } from "node:path";
import type { JabbuConfig } from "../config";
import type { DriverFactory } from "../core/mailbox";
import type { MailboxClock } from "../core/types";
import { realProcessRunner } from "../dispatch/omp";
import { isTaskOrigin } from "../lanes/status";
import type { Logger } from "../log";
import type { AgyAccountPool } from "../omp/agy-account-pool";
import { AgyOmpDriver } from "../omp/agy-driver";
import type { OmpDialogAnswerer, OmpSessionDriver } from "../omp/driver";
import { buildChildEnv, withOmpProfile } from "../omp/env";
import { RpcOmpDriver } from "../omp/rpc-driver";
import { usageLimitsBlock } from "../omp/usage-json";
import { recordSpawnPrompt } from "../ops/cache-miss-cause";
import { allSessionFiles, conversationSessionFiles, renderUsage, summarizeSessionFiles } from "../ops/usage";
import type { HostToolDef } from "../safety/host-tools";
import { type FloorsSurface, spawnSystemPrompt } from "../safety/prompt";
import type { TaskRpcEnv } from "./daemon-task-resume";

export interface BotDriverFactoryDeps {
	getConfig: () => JabbuConfig;
	secretsDir: string;
	personaFiles: {
		persona: string;
		soul: string;
		owner: string;
		secrets: { secretsDir: string; configFile: string };
	};
	onPersonaError: (error: unknown, path: string) => void;
	clock: MailboxClock;
	log: Logger;
	agyModel?: string;
	ompModel: { provider?: string; model?: string };
	agyPool?: AgyAccountPool;
	cwdFor: (originKey: string) => string;
	peerTouched: (originKey: string) => boolean;
	floorsSurfaceFor: (originKey: string) => FloorsSurface;
	hostToolsFor: (originKey: string) => HostToolDef[];
	answerDialogsFor: (originKey: string) => OmpDialogAnswerer | undefined;
	rotationContextFor: (originKey: string) => string | null;
	botRpcEnv: (ompProfile: string | undefined) => TaskRpcEnv;
	taskDriver: (originKey: string, sessionDir: string, rpcEnv: TaskRpcEnv) => OmpSessionDriver;
}

/** Builds the per-origin driver factory (`AgyOmpDriver` or `RpcOmpDriver`) used by the daemon. */
export function createBotDriverFactory(deps: BotDriverFactoryDeps): DriverFactory {
	return (origin: string, sessionDir: string): OmpSessionDriver => {
		const config = deps.getConfig();
		if (isTaskOrigin(origin)) return deps.taskDriver(origin, sessionDir, deps.botRpcEnv(config.ompProfile)); // the row picks it
		const omp = config.agent !== "agy";
		const overlayConfig = config.ompConfigOverlay;
		const answerDialog = omp ? deps.answerDialogsFor(origin) : undefined;
		const systemPrompt = spawnSystemPrompt({
			secretsDir: deps.secretsDir,
			originKey: origin,
			sessionDir,
			files: deps.personaFiles,
			onPersonaError: deps.onPersonaError,
			herdr: config.herdr !== undefined,
			ownerDialogs: answerDialog !== undefined,
			peerTouched: omp && deps.peerTouched(origin),
			surface: deps.floorsSurfaceFor(origin),
			hostTools: omp,
			now: deps.clock.now(),
			log: deps.log,
		});
		if (omp) recordSpawnPromptHash(deps.log, sessionDir, systemPrompt);
		return config.agent === "agy"
			? new AgyOmpDriver({
					agyExecutable: config.agyExecutable ?? "agy",
					cwd: deps.cwdFor(origin),
					sessionDir,
					...(deps.agyModel === undefined ? {} : { model: deps.agyModel }),
					...(config.thinking === undefined ? {} : { thinking: config.thinking }),
					systemPrompt,
					mcpServers: () => deps.getConfig().agyMcpServers,
					...(deps.agyPool === undefined ? {} : { accounts: deps.agyPool }),
					rotationContext: () => deps.rotationContextFor(origin),
					timezone: config.timezone,
					now: () => deps.clock.now(),
					log: deps.log,
					originKey: origin,
					inboundRoot: join(config.homeDir, "media", "inbound"),
				})
			: new RpcOmpDriver({
					ompExecutable: config.ompExecutable,
					cwd: deps.cwdFor(origin),
					sessionDir,
					...deps.ompModel,
					...(config.thinking === undefined ? {} : { thinking: config.thinking }),
					...deps.botRpcEnv(config.ompProfile),
					...(overlayConfig === undefined ? {} : { overlayConfig }),
					extraArgs: ["--append-system-prompt", systemPrompt],
					hostTools: deps.hostToolsFor(origin),
					answerDialog,
					log: deps.log,
				});
	};
}

/** The spawn prompt's hash goes to the session dir (`child_restart` cache misses compare it); a failed write only warns. */
function recordSpawnPromptHash(log: Logger, sessionDir: string, prompt: string): void {
	try {
		recordSpawnPrompt(sessionDir, prompt);
	} catch (error) {
		log.warn("spawn_prompt_hash_failed", { sessionDir, error: String(error) });
	}
}

/** Formats `/usage-jabbu` for either `agy` (not metered) or `omp` session files + limits. */
export async function readBotUsageSummary(
	config: JabbuConfig,
	sessionDir: string,
	sessionsRoot: string,
): Promise<string> {
	if (config.agent === "agy") return `${config.agent} 세션은 집계하지 않습니다`;
	const [conversation, overall, limits] = await Promise.all([
		summarizeSessionFiles(conversationSessionFiles(dirname(sessionDir))),
		summarizeSessionFiles(allSessionFiles(sessionsRoot)),
		usageLimitsBlock({
			executable: config.ompExecutable,
			...(config.ompProfile === undefined ? {} : { profile: config.ompProfile }),
			...(config.ompConfigOverlay === undefined ? {} : { overlayConfig: config.ompConfigOverlay }),
			env: buildChildEnv({}, withOmpProfile(process.env, config.ompProfile)),
			run: realProcessRunner,
		}),
	]);
	return `${renderUsage(conversation, overall)}\n\n${limits}`;
}
