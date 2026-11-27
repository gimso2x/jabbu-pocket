import { LANE_MODEL_TIERS } from "../model-tiers";

/** The `taskSpec` argument of `jabbu_dispatch`: a new [TASK] registration or a resume. */
export const TASK_SPEC_SCHEMA = {
	type: "object",
	description:
		"여러 단계·하루 넘는 작업의 [TASK] 상태 문서 등록. 신규: title·risk·goal·acceptance·repo 필수(+scope·exclusions·falsePasses·background·tier·tierReason·tierConfidence·worker·branch·base). falsePasses는 수락기준을 채워도 실패로 볼 통과 방식(테스트 빼기·실경로 대신 목업 등)으로, spec.md '# 이렇게 통과하면 실패'에 들어가 워커·리뷰·QA가 읽는다. 재개: {id}(기본: 처음 등록한 모델로 뜬다). tier(·tierReason)나 worker를 함께 주면 그 모델로 바꿔 재개하고 인계 브리프(마지막 PROGRESS·이전 워커 화면 80줄·spec 경로)를 새 워커 첫 입력에 넣는다. host가 있으면 그 호스트에, 없으면 로컬에 워크트리를 만든다",
	properties: {
		id: { type: "string", description: "재개할 TASKID(T-YYYYMMDD-NN). 이것만 준다" },
		title: { type: "string" },
		risk: { type: "string", enum: ["L0", "L1", "L2", "L3", "L4"] },
		goal: { type: "string" },
		scope: { type: "array", items: { type: "string" } },
		exclusions: { type: "array", items: { type: "string" } },
		falsePasses: { type: "array", items: { type: "string" } },
		acceptance: {
			type: "array",
			items: { type: "string" },
			description: "수락기준 문구(등록 뒤 바꿀 수 없음)",
		},
		repo: { type: "string", description: "대상 호스트의 git 저장소 절대경로" },
		branch: {
			type: "string",
			description:
				"워커 브랜치 이름(신규 등록에서만). 생략하면 task/<TASKID>. 그 호스트 설정의 branchRules가 이 저장소에 맞는 규칙이면 필수이고 규칙의 pattern에 맞아야 한다(거부 메시지에 형식 예가 나온다)",
		},
		base: {
			type: "string",
			description:
				"워크트리가 갈라질 기준 ref(신규 등록에서만): origin/master 같은 원격 ref(먼저 fetch), 로컬 브랜치, 40자 커밋 해시. 생략하면 그 저장소 branchRules의 base, 그것도 없으면 메인 checkout의 HEAD. 워크트리 브랜치는 upstream을 추적하지 않는다",
		},
		background: { type: "string" },
		assumptions: {
			type: "string",
			description: "오너 대신 정한 해석 한 줄(접수 카드의 [가정]). 없으면 생략",
		},
		tier: {
			type: "string",
			enum: [...LANE_MODEL_TIERS],
			description:
				"워커 모델 등급(config lanes.models). 생략하면 위험 등급으로 정한다(L0·L1 low, L2 middle, L3 이상 high) — 이유가 있을 때만 준다. high: 설계·디버깅·넓은 변경, middle: 일반 구현, low: 기계적 수선 묶음. L3 이상은 항상 high. 재개에서 주면 그 등급으로 바꿔 재개",
		},
		tierReason: {
			type: "string",
			description: "그 등급을 고른 이유 한 줄(카드에 보임). 신규 등록과 등급을 바꾸는 재개에서",
		},
		tierConfidence: {
			type: "number",
			minimum: 0,
			maximum: 1,
			description: "그 등급 판정의 확신도 0~1(judge conf가 있을 때). 신규 등록에서만",
		},
		worker: {
			type: "string",
			enum: ["agy"],
			description:
				"agy(gemini, 무료 시범): L0·L1 로컬, 동시 1개. 품질 미검증. 조건 밖이면 omp 등급 워커로 뜬다. 신규 등록과 워커를 바꾸는 재개에서",
		},
	},
	additionalProperties: false,
} as const;
