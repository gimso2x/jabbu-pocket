/** The model tiers a lane may start on (`lanes.models`). */
export const LANE_MODEL_TIERS = ["high", "middle", "low"] as const;
export type LaneModelTier = (typeof LANE_MODEL_TIERS)[number];
export type LaneModelTiers = Partial<Record<LaneModelTier, string>>;
