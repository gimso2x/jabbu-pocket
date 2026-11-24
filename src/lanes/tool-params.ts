export function stringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
	return value;
}

/** The `jabbu_lane_progress` parameters that make a `needsOwner` question reversible. */
export const SILENCE_PROPERTIES = {
	recommend: {
		type: "string",
		description:
			"With needsOwner and reversible: the one-line option to go on with when the owner does not answer in time",
	},
	reversible: {
		type: "boolean",
		description:
			"With needsOwner: true only when going on with `recommend` can be undone cheaply (nothing destructive, nothing sent out). Both set: the core tells the lane to go on with `recommend` once the owner stayed silent for the configured minutes",
	},
} as const;

/** The `recommend` and `reversible` a tool call carried, in the shape `LaneManager.progress` takes. */
export const silenceParams = (params: Record<string, unknown>): { recommend?: string; reversible: boolean } => ({
	reversible: params.reversible === true,
	...(typeof params.recommend === "string" ? { recommend: params.recommend } : {}),
});
