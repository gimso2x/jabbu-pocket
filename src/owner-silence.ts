import type { JabbuConfig } from "./config";

/** `ownerSilenceFallbackMinutes` when the key is left out. */
export const OWNER_SILENCE_DEFAULT_MINUTES = 30;

/** Minutes an owner question waits before the recommendation goes ahead; 0: the fallback is off. */
export function ownerSilenceFallbackMinutes(config: Pick<JabbuConfig, "ownerSilenceFallbackMinutes">): number {
	return config.ownerSilenceFallbackMinutes ?? OWNER_SILENCE_DEFAULT_MINUTES;
}

/** The prompt a lane or [TASK] gets when its reversible question stayed unanswered for `minutes`. */
export const silencePrompt = (minutes: number, recommend: string): string =>
	`[오너 무응답 ${minutes}분] 추천안(${recommend})으로 범위를 좁혀 진행. 보고에 무응답 진행이라고 적을 것`;

/** The one line the owner thread gets beside that prompt. */
export const silenceNotice = (minutes: number, recommend: string, subject = ""): string =>
	`⏱ 오너 무응답 ${minutes}분 — ${subject}추천안(${recommend})으로 진행합니다.`;

/** The line the thread gets instead when the fallback prompt did not reach the agent (it is not sent again). */
export const silenceFailedNotice = (minutes: number, recommend: string, subject = ""): string =>
	`⚠️ 오너 무응답 ${minutes}분 — ${subject}추천안(${recommend}) 진행 지시를 전달하지 못했습니다.`;
