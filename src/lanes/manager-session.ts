// The lane session's terminal hand-over surface (`manager-types.ts` re-exports these; moved out to keep the deps
// file within the size ratchet).

/** The mailbox of a lane's origin, seen by the terminal hand-over. */
export interface LaneSessionOps {
	/** The file the running child has open; undefined without a child (never starts one). */
	openFile(originKey: string): Promise<string | undefined>;
	/** Resolves once no turn runs. */
	whenTurnEnds(originKey: string): Promise<void>;
	/** Stops the child (the lane is held and its turn is over). */
	release(originKey: string): Promise<void>;
	/** Whether a child runs now. */
	childRunning(originKey: string): boolean;
}

/** What `jabbu-pocket lanes attach` gets: the file the terminal omp resumes, in the lane's cwd and session dir. */
export type LaneAttachOutcome =
	| { ok: true; sessionFile: string; cwd: string; sessionDir: string }
	| { ok: false; error: string };
