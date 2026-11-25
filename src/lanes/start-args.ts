import { LANE_MODEL_TIERS, type LaneModelTier, type LaneModelTiers } from "../model-tiers";
import { parseTierConfidence } from "../tasks/docs";
import { LaneInputError } from "./manager-constants";
import { parseExternalPrInput } from "./pr";
import { parseLaneScope } from "./scope";
import { workflowChoice } from "./workflow";
import { parseLaneAcceptance, parseLaneRisk } from "./worktree";

/**
 * `LaneManager.start`'s arguments, validated (`LaneInputError` on the first bad one); a reservation runs it too, so it
 * fails when stored. `tiers`: the configured lane model tiers.
 */
export function parseStartArgs(
	input: {
		risk?: unknown;
		acceptance?: unknown;
		scope?: unknown;
		model?: unknown;
		tierConfidence?: unknown;
		tierReason?: unknown;
		externalPr?: unknown;
		workflow?: unknown;
	},
	tiers: LaneModelTiers | undefined,
) {
	const risk = parseLaneRisk(input.risk);
	if (!risk.ok) throw new LaneInputError(risk.problem);
	const acceptance = parseLaneAcceptance(input.acceptance);
	if (!acceptance.ok) throw new LaneInputError(acceptance.problem);
	const scope = parseLaneScope(input.scope);
	if (!scope.ok) throw new LaneInputError(scope.problem);
	const requestedTier = laneTier(input.model, tiers ?? {});
	const tierConfidence = parseTierConfidence(input.tierConfidence);
	if (tierConfidence === null) throw new LaneInputError("tierConfidence는 0 이상 1 이하의 숫자여야 합니다.");
	if (input.tierReason !== undefined && typeof input.tierReason !== "string")
		throw new LaneInputError("tierReason은 문자열이어야 합니다.");
	const externalPr = parseExternalPrInput(input.externalPr);
	if (!externalPr.ok) throw new LaneInputError(externalPr.problem);
	const workflow = workflowChoice(input.workflow);
	return {
		workflow,
		externalPrInput: externalPr.value,
		risk: risk.value,
		acceptance: acceptance.value,
		scope: scope.value,
		requestedTier,
		tierConfidence,
		tierReason: input.tierReason,
	};
}

/** The tier the starter asked for, checked against the configured ones; undefined when none was asked for. */
function laneTier(tier: unknown, tiers: LaneModelTiers): LaneModelTier | undefined {
	if (tier === undefined) return undefined;
	const configured = LANE_MODEL_TIERS.filter((name) => tiers[name] !== undefined);
	if (typeof tier === "string" && Object.hasOwn(tiers, tier) && tiers[tier as LaneModelTier] !== undefined) {
		return tier as LaneModelTier;
	}
	throw new LaneInputError(
		configured.length === 0
			? "레인 모델 등급이 설정돼 있지 않습니다(config lanes.models). model 없이 시작하세요."
			: `레인 모델 등급은 ${configured.join("·")} 중 하나입니다: ${String(tier)}`,
	);
}
