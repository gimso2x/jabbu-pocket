/** Evidence of a lane's progress report: a worktree file and its content hash (`preserved`: copied to the artifacts). */
export interface LaneFileEvidence {
	file: string;
	sha256: string;
	preserved?: boolean;
}

/** Evidence of a progress report: a successful tool call of the lane session and the hash of its result text. */
export interface LaneToolEvidence {
	toolCallId: string;
	tool: string;
	sha256: string;
}

export type LaneProgressEvidence = LaneFileEvidence | LaneToolEvidence;
