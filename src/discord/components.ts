// Discord message components: Action Rows of Buttons (type 2) and String SelectMenus (type 3).
import type { ActionSelectMenu } from "../channel/components";
import type { ActionButton } from "../channel/port";
import { cutCodePointSafe } from "../channel/text";
import { DiscordCallError } from "./transport";

/** Buttons per Action Row and max Action Rows per message. */
const ROW_BUTTONS = 5;
const MAX_ACTION_ROWS = 5;
const LABEL_MAX = 80;
const CUSTOM_ID_MAX = 100;
const SELECT_OPTIONS_MAX = 25;
const SELECT_LABEL_MAX = 100;
const SELECT_DESC_MAX = 100;
const SELECT_PLACEHOLDER_MAX = 150;
const BUTTON_STYLE = { primary: 1, danger: 4 } as const;
const DEFAULT_STYLE = 2;

function requireCustomId(actionId: string, kind: string): string {
	if (actionId.length === 0 || actionId.length > CUSTOM_ID_MAX) {
		throw new DiscordCallError(
			"definitive",
			`discord ${kind} custom_id must be 1-${CUSTOM_ID_MAX} characters: ${actionId.slice(0, 40)}… (${actionId.length})`,
		);
	}
	return actionId;
}

/** Action Rows (type 1) of at most five buttons (type 2), validating Discord custom_id and label limits. */
export function buttonRows(buttons: readonly ActionButton[]): unknown[] {
	const rows: unknown[] = [];
	for (let start = 0; start < buttons.length; start += ROW_BUTTONS) {
		rows.push({
			type: 1,
			components: buttons.slice(start, start + ROW_BUTTONS).map((button) => ({
				type: 2,
				style: button.style === undefined ? DEFAULT_STYLE : BUTTON_STYLE[button.style],
				label: cutCodePointSafe(button.label, LABEL_MAX),
				custom_id: requireCustomId(button.actionId, "button"),
				...(button.disabled === true ? { disabled: true } : {}),
			})),
		});
	}
	return rows;
}

/** One Action Row (type 1) per String SelectMenu (type 3), enforcing Discord option/length caps. */
export function selectMenuRows(menus: readonly ActionSelectMenu[]): unknown[] {
	return menus.map((menu) => {
		const customId = requireCustomId(menu.actionId, "select");
		if (menu.options.length === 0) {
			throw new DiscordCallError("definitive", `discord select menu ${customId} must have at least 1 option`);
		}
		const options = menu.options.slice(0, SELECT_OPTIONS_MAX).map((option) => {
			if (option.value.length === 0 || option.value.length > CUSTOM_ID_MAX) {
				throw new DiscordCallError(
					"definitive",
					`discord select option value must be 1-${CUSTOM_ID_MAX} characters: ${option.value.slice(0, 40)}`,
				);
			}
			const label = cutCodePointSafe(option.label, SELECT_LABEL_MAX).trim() || "-";
			const description =
				option.description === undefined ? undefined : cutCodePointSafe(option.description, SELECT_DESC_MAX).trim();
			return {
				label,
				value: option.value,
				...(description === undefined || description === "" ? {} : { description }),
				...(option.default === true ? { default: true } : {}),
			};
		});
		const placeholder =
			menu.placeholder === undefined ? undefined : cutCodePointSafe(menu.placeholder, SELECT_PLACEHOLDER_MAX);
		return {
			type: 1,
			components: [
				{
					type: 3,
					custom_id: customId,
					options,
					...(placeholder === undefined || placeholder === "" ? {} : { placeholder }),
					...(menu.disabled === true ? { disabled: true } : {}),
				},
			],
		};
	});
}

/** Renders SelectMenus above Buttons into Discord Action Rows, rejecting > 5 rows before sending. */
export function componentRows(buttons: readonly ActionButton[], selectMenus: readonly ActionSelectMenu[]): unknown[] {
	const rows = [...selectMenuRows(selectMenus), ...buttonRows(buttons)];
	if (rows.length > MAX_ACTION_ROWS) {
		throw new DiscordCallError(
			"definitive",
			`discord message supports at most ${MAX_ACTION_ROWS} action rows, got ${rows.length}`,
		);
	}
	return rows;
}
