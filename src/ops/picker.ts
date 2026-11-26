// Discord SelectMenu 명령 피커(`/model`, `/thinking`, `/fast`, `/usage-reset`)의 액션 ID 및 메시지 렌더러.
import type { ActionSelectMenu } from "../channel/components";
import type { ActionButton, OutboundMessage } from "../channel/port";
import type { PickerCommandKind } from "../core/mailbox-types";
import { COMMAND_TEXT } from "../core/types";

export const PICKER_ACTION_PREFIX = "jabbu:picker:";
export const PICKER_PAGE_SIZE = 25;
export const PICKER_TTL_MS = 10 * 60_000;

export type PickerOp = "sel" | "ok" | "cancel" | "prev" | "next";

export interface PickerOption {
	value: string;
	label: string;
	description?: string;
}

export interface PickerViewState {
	token: string;
	kind: PickerCommandKind;
	currentValue?: string | undefined;
	currentLabel: string;
	options: readonly PickerOption[];
	selectedValue?: string | undefined;
	page: number;
	busy?: boolean | undefined;
}

const PICKER_ID_RE = /^jabbu:picker:(sel|ok|cancel|prev|next):([A-Za-z0-9_-]{1,64})$/;

/** 피커 컴포넌트 `custom_id`를 조립한다. */
export function pickerActionId(op: PickerOp, token: string): string {
	return `${PICKER_ACTION_PREFIX}${op}:${token}`;
}

/** `custom_id`를 피커 액션과 세션 토큰으로 파싱한다. */
export function parsePickerActionId(actionId: string): { op: PickerOp; token: string } | undefined {
	const match = PICKER_ID_RE.exec(actionId);
	if (match?.[1] === undefined || match[2] === undefined) return undefined;
	return { op: match[1] as PickerOp, token: match[2] };
}

/** 명령 종류별 제목과 현재 상태 줄을 만든다. */
export function pickerHeaderLine(kind: PickerCommandKind, currentLabel: string): string {
	switch (kind) {
		case "model":
			return `🔀 모델 선택\n현재 모델: ${currentLabel}`;
		case "thinking":
			return `🧠 thinking 선택\n현재 thinking: ${currentLabel}`;
		case "fast":
			return `⚡ fast 모드 선택\n현재 fast 모드: ${currentLabel}`;
		case "usage-reset":
			return `🔄 사용량·쿼터 초기화\n현재 상태: ${currentLabel}`;
	}
}

function placeholderOf(kind: PickerCommandKind): string {
	switch (kind) {
		case "model":
			return "변경할 모델을 고르세요";
		case "thinking":
			return "thinking 수준을 고르세요";
		case "fast":
			return "fast 모드를 고르세요";
		case "usage-reset":
			return "초기화할 대상을 고르세요";
	}
}

/** 현재 선택·페이지 상태에 맞는 SelectMenu + 확인/취소 버튼 메시지를 그린다. */
export function renderPickerMessage(state: PickerViewState): OutboundMessage {
	const pageCount = Math.max(1, Math.ceil(state.options.length / PICKER_PAGE_SIZE));
	const page = Math.max(0, Math.min(state.page, pageCount - 1));
	const start = page * PICKER_PAGE_SIZE;
	const slice = state.options.slice(start, start + PICKER_PAGE_SIZE);
	const picked =
		state.selectedValue === undefined ? undefined : state.options.find((opt) => opt.value === state.selectedValue);
	const defaultValue = state.selectedValue ?? state.currentValue;

	const lines = [pickerHeaderLine(state.kind, state.currentLabel)];
	if (pageCount > 1) lines.push(`페이지 ${page + 1}/${pageCount} · 총 ${state.options.length}개`);
	lines.push(
		picked === undefined
			? "아래 메뉴에서 항목을 고른 뒤 **확인**을 누르세요."
			: `선택한 항목: **${picked.label}** — **확인**을 누르면 적용됩니다.`,
	);
	if (state.busy === true) {
		lines.push("⏳ 작업 중에는 바꿀 수 없습니다. 끝난 뒤 **확인**을 다시 누르세요.");
	}

	const selectMenus: ActionSelectMenu[] = [
		{
			actionId: pickerActionId("sel", state.token),
			placeholder: picked === undefined ? placeholderOf(state.kind) : picked.label,
			options: slice.map((opt, idx) => ({
				label: opt.label,
				value: String(start + idx),
				...(opt.description === undefined ? {} : { description: opt.description }),
				...(defaultValue !== undefined && opt.value === defaultValue ? { default: true } : {}),
			})),
		},
	];

	const buttons: ActionButton[] = [
		...(pageCount > 1
			? [
					{ actionId: pickerActionId("prev", state.token), label: "◀ 이전", disabled: page === 0 },
					{ actionId: pickerActionId("next", state.token), label: "다음 ▶", disabled: page >= pageCount - 1 },
				]
			: []),
		{
			actionId: pickerActionId("ok", state.token),
			label: "확인",
			style: "primary",
			disabled: picked === undefined,
		},
		{ actionId: pickerActionId("cancel", state.token), label: "취소", style: "danger" },
	];

	return {
		text: lines.join("\n"),
		selectMenus,
		buttons,
		buttonsNote: `10분 안에 선택·확인하세요 · 직접 입력: \`${COMMAND_TEXT[state.kind]} <값>\``,
	};
}

/** 피커 적용 완료 메시지(컴포넌트 제거). */
export function renderPickerDone(text: string): OutboundMessage {
	return { text, buttons: [], selectMenus: [] };
}

/** 피커 취소 메시지(컴포넌트 제거). */
export function renderPickerCancelled(headerLine?: string): OutboundMessage {
	return {
		text: headerLine === undefined ? "✖️ 선택을 취소했습니다." : `✖️ 선택을 취소했습니다.\n${headerLine}`,
		buttons: [],
		selectMenus: [],
	};
}

/** 피커 만료·재시작으로 세션을 잃었을 때 컴포넌트를 치우는 안내 메시지. */
export function renderPickerExpired(): OutboundMessage {
	return { text: "⌛ 선택 시간이 만료되었습니다. 명령을 다시 보내세요.", buttons: [], selectMenus: [] };
}
