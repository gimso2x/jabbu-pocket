import { classifyFailure, formatResetHint } from "./failure-kind";

/** Classifies `reason` and builds the owner-facing guidance tail after `[turn failed] <reason> — `. */
export function ownerFailureTail(reason: string): string {
	const { kind, limitScope, resetAt } = classifyFailure(reason);
	switch (kind) {
		case "provider_limit": {
			const reset = resetAt === undefined ? "" : `${formatResetHint(resetAt)} `;
			if (limitScope === "rate_limited") {
				return reset === ""
					? "일시적 요청 속도 제한입니다. 잠시 뒤 다시 보내 주세요"
					: `일시적 요청 속도 제한입니다. ${reset}다시 보내 주세요`;
			}
			return `공급자 한도입니다. ${reset}다시 보내거나 다른 모델로 \`/model-jabbu\``;
		}
		case "context_overflow":
			return "대화가 너무 길어 이어갈 수 없습니다. `/new-jabbu`(또는 `/compact-jabbu`) 뒤 다시 보내 주세요";
		case "auth":
			return "봇 계정 인증 문제입니다. 다시 보내도 같습니다 — 오너가 로그인·키를 확인해야 합니다";
		case "model_rejected":
			return "설정한 모델을 공급자가 거부했습니다. `/model-jabbu`로 다른 모델로 바꾼 뒤 다시 보내 주세요";
		case "tool_history_rejected":
			return "세션의 도구 호출 기록이 어긋나 이어갈 수 없습니다. `/new-jabbu`로 새 세션을 연 뒤 다시 보내 주세요";
		case "transient":
		case "unknown":
			return "다시 보내 주세요";
	}
}

/** Builds the trailing guidance sentence (leading space included) for `toolFreeClosureNotice`. */
export function toolFreeFailureTail(reason: string): string {
	const { kind, limitScope, resetAt } = classifyFailure(reason);
	switch (kind) {
		case "provider_limit": {
			const reset = resetAt === undefined ? "" : `${formatResetHint(resetAt)} `;
			if (limitScope === "rate_limited") {
				return reset === ""
					? " 일시적 요청 속도 제한입니다. 잠시 뒤 다시 보내 주세요."
					: ` 일시적 요청 속도 제한입니다. ${reset}다시 보내 주세요.`;
			}
			return ` 공급자 한도입니다. ${reset}여유가 회복된 뒤 다시 보내거나 \`/model-jabbu\`로 모델을 바꾸세요.`;
		}
		case "model_rejected":
			return " 설정한 모델을 공급자가 거부했습니다. `/model-jabbu`로 다른 모델로 바꾼 뒤 다시 보내 주세요.";
		case "tool_history_rejected":
			return " 세션의 도구 호출 기록이 어긋났습니다. `/new-jabbu`로 새 세션을 연 뒤 다시 보내 주세요.";
		case "context_overflow":
			return " 대화가 너무 길어 이어갈 수 없습니다. `/new-jabbu`(또는 `/compact-jabbu`) 뒤 다시 보내 주세요.";
		case "auth":
			return " 봇 계정 인증 문제입니다. 로그인·키를 확인한 뒤 다시 보내 주세요.";
		case "transient":
		case "unknown":
			return " 다시 실행하려면 새로 보내 주세요.";
	}
}
