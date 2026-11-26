/** Platform-neutral string SelectMenu option inside `OutboundMessage.selectMenus`. */
export interface ActionSelectOption {
	label: string;
	value: string;
	description?: string;
	default?: boolean;
}

/** Platform-neutral string SelectMenu component attached to an `OutboundMessage`. */
export interface ActionSelectMenu {
	actionId: string;
	placeholder?: string;
	options: readonly ActionSelectOption[];
	disabled?: boolean;
}

/** Masks every user-visible field inside SelectMenus before an adapter posts or edits them. */
export function redactSelectMenus(
	menus: readonly ActionSelectMenu[],
	mask: (text: string) => string,
): ActionSelectMenu[] {
	return menus.map((menu) => ({
		...menu,
		...(menu.placeholder === undefined ? {} : { placeholder: mask(menu.placeholder) }),
		options: menu.options.map((option) => ({
			...option,
			label: mask(option.label),
			...(option.description === undefined ? {} : { description: mask(option.description) }),
		})),
	}));
}
