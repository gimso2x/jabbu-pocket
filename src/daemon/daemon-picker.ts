// Discord SelectMenu 명령 피커 세션 수명주기·선택 미리보기·확인 적용 오케스트레이터.
import { randomBytes } from "node:crypto";
import type { MessageRef, OutboundMessage } from "../channel/port";
import { errorText } from "../channel/text";
import type { PickerCommandKind } from "../core/mailbox-types";
import { platformOfThreadRef } from "../core/normalize";
import type { OmpSessionDriver } from "../omp/driver";
import {
	PICKER_PAGE_SIZE,
	PICKER_TTL_MS,
	type PickerOp,
	type PickerOption,
	type PickerViewState,
	pickerHeaderLine,
	renderPickerCancelled,
	renderPickerDone,
	renderPickerExpired,
	renderPickerMessage,
} from "../ops/picker";
import type { DaemonContext } from "./daemon-context";
import type { DaemonQuotaGate } from "./daemon-quota";

const MAX_PICKER_SESSIONS = 100;

interface PickerSession extends PickerViewState {
	originKey: string;
	threadRef: string;
	messageRef: MessageRef;
	createdAt: number;
	applying: boolean;
}

export interface PickerActionInput {
	values?: readonly string[] | undefined;
	channel?: string | undefined;
	messageTs?: string | undefined;
	replyEphemeral?: ((text: string) => Promise<void>) | undefined;
}

/** Discord 대화의 `/model`·`/thinking`·`/fast`·`/usage-reset` SelectMenu 피커를 관리한다. */
export class DaemonCommandPicker {
	readonly #ctx: DaemonContext;
	readonly #quota: DaemonQuotaGate;
	readonly #sessions = new Map<string, PickerSession>();

	constructor(ctx: DaemonContext, quota: DaemonQuotaGate) {
		this.#ctx = ctx;
		this.#quota = quota;
	}

	/** 만료된 피커 세션을 정리한다. */
	pruneExpired(now = this.#ctx.clock.now()): void {
		for (const [token, session] of this.#sessions) {
			if (now - session.createdAt >= PICKER_TTL_MS) this.#sessions.delete(token);
		}
	}

	/** 인자 없는 명령에 대해 Discord SelectMenu + 확인/취소 피커를 연다. 지원 불가·비Discord면 `false`. */
	async open(info: {
		kind: PickerCommandKind;
		originKey: string;
		threadRef: string;
		busy: boolean;
		ensureDriver: () => Promise<OmpSessionDriver>;
	}): Promise<boolean> {
		if (platformOfThreadRef(info.threadRef) !== "discord") return false;
		const route = this.#ctx.channels.forThreadRef(info.threadRef);
		if (route === undefined) return false;

		const now = this.#ctx.clock.now();
		this.pruneExpired(now);

		const built = await this.#buildInitialState(info);
		if (built === undefined) return false;

		const token = randomBytes(6).toString("hex");
		const view: PickerViewState = {
			token,
			kind: info.kind,
			currentValue: built.currentValue,
			currentLabel: built.currentLabel,
			options: built.options,
			page: built.page,
			...(info.busy ? { busy: true } : {}),
		};
		const messageRef = await route.port.post(route.target, renderPickerMessage(view));
		this.#storeSession({
			...view,
			originKey: info.originKey,
			threadRef: info.threadRef,
			messageRef,
			createdAt: now,
			applying: false,
		});
		return true;
	}

	/** SelectMenu 선택·페이지 이동·확인·취소 클릭을 처리한다. */
	async handleAction(action: { op: PickerOp; token: string }, input: PickerActionInput): Promise<void> {
		const now = this.#ctx.clock.now();
		const session = this.#sessions.get(action.token);
		if (session === undefined || now - session.createdAt >= PICKER_TTL_MS) {
			this.#sessions.delete(action.token);
			await this.#expireOrNotify(input);
			return;
		}
		if (session.applying) return;

		if (action.op === "sel") {
			const rawIdx = input.values?.[0];
			const idx = rawIdx !== undefined && /^\d+$/.test(rawIdx) ? Number(rawIdx) : -1;
			const picked = session.options[idx];
			if (picked === undefined) return;
			session.selectedValue = picked.value;
			await this.#editSession(session, renderPickerMessage(session), input.replyEphemeral);
			return;
		}

		if (action.op === "prev" || action.op === "next") {
			const pageCount = Math.max(1, Math.ceil(session.options.length / PICKER_PAGE_SIZE));
			session.page = action.op === "prev" ? Math.max(0, session.page - 1) : Math.min(pageCount - 1, session.page + 1);
			await this.#editSession(session, renderPickerMessage(session), input.replyEphemeral);
			return;
		}

		if (action.op === "cancel") {
			this.#sessions.delete(action.token);
			await this.#editSession(
				session,
				renderPickerCancelled(pickerHeaderLine(session.kind, session.currentLabel)),
				input.replyEphemeral,
			);
			return;
		}

		if (session.selectedValue === undefined) {
			await input.replyEphemeral?.("먼저 메뉴에서 항목을 선택해 주세요.");
			return;
		}

		session.applying = true;
		try {
			if (session.kind === "usage-reset") {
				const text = await this.#quota.resetUsage(session.selectedValue);
				this.#sessions.delete(action.token);
				await this.#editSession(session, renderPickerDone(text), input.replyEphemeral);
				return;
			}
			const router = this.#ctx.router;
			if (router === undefined) {
				await input.replyEphemeral?.("데몬 라우터가 아직 준비되지 않았습니다.");
				return;
			}
			const res = await router
				.mailbox(session.originKey)
				.applyPickerCommand({ kind: session.kind, arg: session.selectedValue }, session.threadRef);
			if (!res.ok && res.busy === true) {
				session.busy = true;
				await input.replyEphemeral?.(res.text);
				await this.#editSession(session, renderPickerMessage(session), input.replyEphemeral);
				return;
			}
			this.#sessions.delete(action.token);
			await this.#editSession(session, renderPickerDone(res.text), input.replyEphemeral);
		} catch (error) {
			this.#ctx.log.warn("picker_apply_failed", {
				kind: session.kind,
				origin: session.originKey,
				error: errorText(error),
			});
			await input.replyEphemeral?.(`⚠️ 적용하지 못했습니다: ${errorText(error)}`);
		} finally {
			session.applying = false;
		}
	}

	async #buildInitialState(info: {
		kind: PickerCommandKind;
		ensureDriver: () => Promise<OmpSessionDriver>;
	}): Promise<{ currentValue?: string; currentLabel: string; options: PickerOption[]; page: number } | undefined> {
		if (info.kind === "usage-reset") {
			const snap = this.#quota.resetSnapshot();
			const currentLabel =
				snap.holdCount === 0 && snap.liftCount === 0
					? "보류·차단 없음"
					: snap.isAgy
						? `차단 계정 ${snap.holdCount}개`
						: `보류 ${snap.holdCount}개 · 수동 해제 ${snap.liftCount}개`;
			const options: PickerOption[] = [
				{
					value: "all",
					label: "전체 초기화",
					description: snap.isAgy ? "차단된 agy 계정 모두 해제" : "모든 프로바이더 보류 해제 및 대기열 재개",
				},
				...snap.providers.map((item) => ({ value: item.id, label: item.id, description: item.summary })),
				...(!snap.isAgy && snap.liftCount > 0
					? [
							{
								value: "clear-lifts",
								label: "수동 해제(quota lift) 지우기",
								description: `수동 해제 ${snap.liftCount}건 제거 후 재조회`,
							},
						]
					: []),
			];
			return { currentLabel, options, page: 0 };
		}

		const driver = await info.ensureDriver();
		if (info.kind === "model") {
			const [models, state] = await Promise.all([driver.availableModels(), driver.state()]);
			if (models.length === 0) return undefined;
			const current = state.model;
			const idx = current === undefined ? -1 : models.indexOf(current);
			return {
				...(current === undefined ? {} : { currentValue: current }),
				currentLabel: current ?? "(알 수 없음)",
				options: models.map((model) => ({
					value: model,
					label: model,
					...(model === current ? { description: "현재 모델" } : {}),
				})),
				page: idx >= 0 ? Math.floor(idx / PICKER_PAGE_SIZE) : 0,
			};
		}

		if (info.kind === "thinking") {
			const [levels, state] = await Promise.all([driver.thinkingLevels(), driver.state()]);
			if (levels.length === 0) return undefined;
			const currentValue = state.configuredThinking ?? state.thinking;
			const currentLabel =
				state.configuredThinking === undefined
					? (state.thinking ?? "(알 수 없음)")
					: `${state.configuredThinking} (실효 ${state.thinking ?? "알 수 없음"})`;
			return {
				...(currentValue === undefined ? {} : { currentValue }),
				currentLabel,
				options: levels.map((level) => ({
					value: level,
					label: level,
					...(level === currentValue ? { description: "현재 설정" } : {}),
				})),
				page: 0,
			};
		}

		if (driver.setFastMode === undefined) return undefined;
		const state = await driver.state();
		const currentValue = state.fastModeEnabled === undefined ? undefined : state.fastModeEnabled ? "on" : "off";
		const currentLabel =
			state.fastModeEnabled === undefined
				? "(알 수 없음)"
				: state.fastModeEnabled
					? state.fastModeActive === false
						? "켜짐(on · 현재 모델 미적용)"
						: "켜짐(on)"
					: "꺼짐(off)";
		return {
			...(currentValue === undefined ? {} : { currentValue }),
			currentLabel,
			options: [
				{ value: "on", label: "켜기 (on)", description: "fast 모드 활성화" },
				{ value: "off", label: "끄기 (off)", description: "fast 모드 비활성화" },
			],
			page: 0,
		};
	}

	#storeSession(session: PickerSession): void {
		this.#sessions.set(session.token, session);
		if (this.#sessions.size > MAX_PICKER_SESSIONS) {
			const oldest = this.#sessions.keys().next().value;
			if (oldest !== undefined) this.#sessions.delete(oldest);
		}
	}

	async #editSession(
		session: PickerSession,
		msg: OutboundMessage,
		replyEphemeral?: (text: string) => Promise<void>,
	): Promise<void> {
		try {
			await this.#ctx.channels.get("discord").edit(session.messageRef, msg);
		} catch (error) {
			this.#ctx.log.warn("picker_edit_failed", { kind: session.kind, error: errorText(error) });
			await replyEphemeral?.("⚠️ 피커 메시지를 갱신하지 못했습니다.");
		}
	}

	async #expireOrNotify(input: PickerActionInput): Promise<void> {
		if (input.channel !== undefined && input.messageTs !== undefined) {
			const port = this.#ctx.channels.forConversation(input.channel)?.port;
			if (port !== undefined) {
				try {
					await port.edit(
						{ platform: port.platform, conversationId: input.channel, messageId: input.messageTs },
						renderPickerExpired(),
					);
					return;
				} catch {
					// Fallback to ephemeral when the original picker message is gone or cannot be edited.
				}
			}
		}
		await input.replyEphemeral?.("⌛ 선택 시간이 만료되었습니다. 명령을 다시 보내세요.");
	}
}
