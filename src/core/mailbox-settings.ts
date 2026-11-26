import type { Logger } from "../log";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { OmpDriverError, type OmpSessionDriver } from "../omp/driver";
import type { Store } from "../store/db";
import type { OriginRow } from "../store/db-rows";
import type { MailboxHost, PickerCommandKind } from "./mailbox-types";
import { COMMAND_TEXT, type CommandKind, type ParsedCommand } from "./types";

const PICKER_KINDS: ReadonlySet<CommandKind> = new Set(["model", "thinking", "fast", "usage-reset"]);

/** Whether `kind` opens an interactive SelectMenu picker when invoked without arguments. */
export function isPickerCommand(kind: CommandKind): kind is PickerCommandKind {
	return PICKER_KINDS.has(kind);
}

/** Cursor key prefix for per-origin `/fast-jabbu` choice (`"on"` | `"off"`). */
export const FAST_CURSOR_PREFIX = "origin_fast:";

/** Parses `/fast-jabbu <arg>` into boolean, or `undefined` when invalid. */
export function parseFastArg(arg: string): boolean | undefined {
	const normalized = arg.trim().toLowerCase();
	if (
		normalized === "on" ||
		normalized === "true" ||
		normalized === "1" ||
		normalized === "enable" ||
		normalized === "켜기" ||
		normalized === "켜"
	) {
		return true;
	}
	if (
		normalized === "off" ||
		normalized === "false" ||
		normalized === "0" ||
		normalized === "disable" ||
		normalized === "끄기" ||
		normalized === "꺼"
	) {
		return false;
	}
	return undefined;
}

/** Effective `/fast-jabbu` setting for `originKey`, inheriting from parent channel for threads (`/t/`). */
export function effectiveFastSetting(store: Store, originKey: string): boolean | undefined {
	const own = store.getCursor(`${FAST_CURSOR_PREFIX}${originKey}`);
	if (own === "on") return true;
	if (own === "off") return false;
	const threadMark = originKey.indexOf("/t/");
	if (threadMark === -1) return undefined;
	const parent = store.getCursor(`${FAST_CURSOR_PREFIX}${originKey.slice(0, threadMark)}`);
	if (parent === "on") return true;
	if (parent === "off") return false;
	return undefined;
}

/** Re-applies persisted `/fast-jabbu` setting when opening a session; failures only warn. */
export async function applyFastSetting(
	driver: OmpSessionDriver,
	store: Store,
	originKey: string,
	log: Logger,
): Promise<void> {
	if (driver.setFastMode === undefined) return;
	const fast = effectiveFastSetting(store, originKey);
	if (fast === undefined) return;
	try {
		await driver.setFastMode(fast);
	} catch (error) {
		log.warn("fast_apply_failed", { origin: originKey, fast, error: String(error) });
	}
}

/** Effective chat-chosen model/thinking, inheriting from parent channel on threads (`/t/`). */
export function effectiveOriginSettings(
	store: Store,
	originKey: string,
	origin: OriginRow,
): { model: string | null; thinking: string | null } {
	if (originKey.startsWith(MONITOR_ORIGIN_PREFIX)) {
		const monitor = store.monitors.getMonitor(originKey.slice(MONITOR_ORIGIN_PREFIX.length));
		return { model: monitor?.model ?? origin.model, thinking: monitor?.thinking ?? origin.thinking };
	}
	const threadMark = originKey.indexOf("/t/");
	if (threadMark === -1 || (origin.model !== null && origin.thinking !== null)) {
		return { model: origin.model, thinking: origin.thinking };
	}
	const parent = store.getOrigin(originKey.slice(0, threadMark));
	if (parent === undefined) return { model: origin.model, thinking: origin.thinking };
	return { model: origin.model ?? parent.model, thinking: origin.thinking ?? parent.thinking };
}

/** Switches a restored session away from a vanished model to the chat-chosen or config default fallback. */
export async function healStaleSessionModel(input: {
	driver: OmpSessionDriver;
	store: Store;
	originKey: string;
	origin: OriginRow;
	defaultModel: string | undefined;
	log: Logger;
	models?: string[] | undefined;
}): Promise<{ outcome: "noop" | "replaced" | "no_fallback"; activeModel: string | undefined }> {
	const { driver, store, originKey, origin, defaultModel, log, models } = input;
	const active = (await driver.state()).model;
	if (active === undefined) return { outcome: "noop", activeModel: undefined };
	const listed = models ?? (await driver.availableModels());
	if (listed.includes(active)) return { outcome: "noop", activeModel: active };
	const inherited = effectiveOriginSettings(store, originKey, origin).model;
	const fallback =
		inherited !== null && listed.includes(inherited)
			? inherited
			: defaultModel !== undefined && listed.includes(defaultModel)
				? defaultModel
				: undefined;
	if (fallback === undefined) {
		log.warn("model_stale_no_fallback", { origin: originKey, model: active });
		return { outcome: "no_fallback", activeModel: active };
	}
	await driver.setModel(fallback);
	log.warn("model_stale_replaced", { origin: originKey, from: active, to: fallback });
	return { outcome: "replaced", activeModel: fallback };
}

/** Re-applies chat-chosen model/thinking/fast whenever a child opens the session; invalid choices only warn. */
export async function applyOriginSettings(input: {
	driver: OmpSessionDriver;
	store: Store;
	originKey: string;
	origin: OriginRow;
	defaultModel: string | undefined;
	log: Logger;
}): Promise<string | undefined> {
	const { driver, store, originKey, origin, defaultModel, log } = input;
	const { model, thinking } = effectiveOriginSettings(store, originKey, origin);
	let activeModel: string | undefined;
	const models = await driver.availableModels().catch((error: unknown) => {
		log.warn("models_list_failed", { origin: originKey, error: String(error) });
		return undefined;
	});
	if (model !== null) {
		if (models !== undefined && !models.includes(model)) {
			log.warn("model_apply_unavailable", { origin: originKey, model });
		} else {
			await driver.setModel(model).then(
				(applied) => {
					activeModel = applied;
				},
				(error: unknown) => {
					log.warn("model_apply_failed", { origin: originKey, model, error: String(error) });
				},
			);
		}
	}
	if (thinking !== null) {
		await driver.setThinking(thinking).catch((error: unknown) => {
			log.warn("thinking_apply_failed", { origin: originKey, thinking, error: String(error) });
		});
	}
	await applyFastSetting(driver, store, originKey, log);
	const healed = await healStaleSessionModel({ driver, store, originKey, origin, defaultModel, log, models }).catch(
		(error: unknown) => {
			log.warn("model_heal_failed", { origin: originKey, error: String(error) });
			return undefined;
		},
	);
	return healed?.activeModel ?? activeModel;
}

/** Handles `/fast-jabbu` / `!fast`: displays or toggles fast mode and persists the choice per origin. */
export async function fastCommand(host: MailboxHost, arg: string, threadRef: string): Promise<string> {
	const driver = await host.ensureDriver(threadRef);
	if (driver.setFastMode === undefined) {
		return "이 대화의 에이전트는 fast 모드를 지원하지 않습니다.";
	}
	if (arg === "") {
		const state = await driver.state();
		const current =
			state.fastModeEnabled === undefined
				? "(알 수 없음)"
				: state.fastModeEnabled
					? state.fastModeActive === false
						? "켜짐(on · 현재 모델 미적용)"
						: "켜짐(on)"
					: "꺼짐(off)";
		return [
			`현재 fast 모드: ${current} · 모델 ${state.model ?? "?"}`,
			`바꾸기: \`${COMMAND_TEXT.fast} <on|off>\``,
		].join("\n");
	}
	const enabled = parseFastArg(arg);
	if (enabled === undefined) {
		return `fast 모드 인자가 올바르지 않습니다: ${arg} — \`on\` 또는 \`off\`를 입력하세요.`;
	}
	let applied: { enabled: boolean; active: boolean };
	try {
		applied = await driver.setFastMode(enabled);
	} catch (error) {
		if (error instanceof OmpDriverError && /fast mode is unavailable/i.test(error.message)) {
			return "현재 모델에서는 fast 모드를 켤 수 없습니다.";
		}
		throw error;
	}
	host.deps.store.setCursor(`${FAST_CURSOR_PREFIX}${host.deps.originKey}`, applied.enabled ? "on" : "off");
	host.deps.log.info("fast_set", { origin: host.deps.originKey, enabled: applied.enabled, active: applied.active });
	const label = applied.enabled ? "켰습니다(on)" : "껐습니다(off)";
	const note = applied.enabled && !applied.active ? " (현재 모델에서는 비활성 상태로 대기합니다)" : "";
	return `⚡ fast 모드를 ${label}${note}. 이 대화방의 다음 작업부터 적용됩니다.`;
}

/** Handles `/usage-reset-jabbu` / `!usage-reset`. */
export async function usageResetCommand(host: MailboxHost, arg: string): Promise<string> {
	if (host.deps.usageResetProvider === undefined) return "쿼터·사용량 초기화가 연결되지 않았습니다.";
	return await host.deps.usageResetProvider(arg, host.deps.originKey);
}

/** Applies one confirmed SelectMenu picker choice under the mailbox's serial actor chain. */
export async function runPickerCommand(
	host: MailboxHost,
	command: ParsedCommand,
	runReply: (command: ParsedCommand, opRef: string) => Promise<string>,
	afterModelApply: () => Promise<void>,
): Promise<{ ok: boolean; busy?: boolean; text: string }> {
	if (command.kind !== "usage-reset" && host.turn() !== undefined) {
		return { ok: false, busy: true, text: "⏳ 작업 중에는 바꿀 수 없습니다. 끝난 뒤 다시 확인을 누르세요." };
	}
	const opRef = `picker:${command.kind}:${host.deps.clock.now()}`;
	const text = await runReply(command, opRef);
	if (command.kind === "model") {
		await afterModelApply();
	}
	return { ok: true, text };
}
