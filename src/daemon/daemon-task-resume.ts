import { join } from "node:path";
import type { TaskDispatchDeps } from "../tasks/dispatch";
import type { TaskLedger, TaskRow } from "../tasks/ledger";
import type { DaemonContext } from "./daemon-context";

/** `resumeTask`'s deps from the daemon's own: the live config, the ledger and the herdr runner of the sweep. */
export function taskResumeDeps(ctx: DaemonContext, ledger: TaskLedger, row: TaskRow): TaskDispatchDeps {
	const { options, store, channels, clock, log } = ctx;
	const config = options.config;
	return {
		ledger,
		originKey: row.originKey,
		threadRef: () => row.threadRef,
		rootText: () => undefined,
		channels,
		now: () => clock.now(),
		timezone: config.timezone,
		workspaceDir: config.workspaceDir,
		...(config.dispatchHosts === undefined ? {} : { dispatchHosts: config.dispatchHosts }),
		...(config.recordsRepo === undefined ? {} : { recordsRepo: config.recordsRepo }),
		...(config.workerOmpArgs === undefined ? {} : { workerOmpArgs: config.workerOmpArgs }),
		secretsDir: join(config.homeDir, "secrets"),
		...(options.herdrRun === undefined ? {} : { run: options.herdrRun }),
		recordPrompt: (input) => store?.recordHerdrPrompt(input),
		log,
	};
}
