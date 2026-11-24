export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	/** The command ran past `timeoutMs` and its process group was killed (`code` is then 124). */
	timedOut?: boolean;
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	/**
	 * Limit for the whole command: past it the process group gets SIGTERM, then SIGKILL after `killGraceMs`, and the
	 * result is a failure. No default: each caller names the limit its command needs.
	 */
	timeoutMs?: number;
	/** SIGTERM to SIGKILL wait after a timeout (default `KILL_GRACE_MS`). */
	killGraceMs?: number;
}

export type Runner = (cmd: string[], options?: RunOptions) => Promise<RunResult>;
