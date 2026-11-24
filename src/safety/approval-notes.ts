// The grey lines under approval cards.

/** The mirror's grey line: buttons only (a thread reply here is an ordinary message), the canonical card, the deadline. */
export function mirrorNote(
	cardChannel: string,
	cardUrl: string | undefined,
	expiresAt: number,
	deadline: Intl.DateTimeFormat,
): string {
	const canonical = cardUrl === undefined ? `<#${cardChannel}>` : `<${cardUrl}|#escalation에서 보기>`;
	return `버튼으로 답해 주세요(이 스레드의 글 답장은 승인으로 세지 않음) · 정본 카드: ${canonical} · ⏳ ${deadline.format(expiresAt)}까지 답이 없으면 거부로 처리됩니다`;
}

export function deadlineNote(expiresAt: number, timeoutMs: number, deadline: Intl.DateTimeFormat): string {
	return `⏳ ${deadline.format(expiresAt)}까지 버튼이나 이 스레드 답장이 없으면 거부로 처리됩니다(${Math.round(timeoutMs / 60_000)}분)`;
}
