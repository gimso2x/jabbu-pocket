import { expect, test } from "bun:test";
import { cardMessage } from "../src/tasks/notify";

const port = { mentionUser: (id: string) => `<@${id}>` };

test("a task card body cut at the cap never ends in a lone surrogate", () => {
	const body = `${"a".repeat(2998)}😀tail`;
	const message = cardMessage({ text: "t", title: "T", body }, port);
	expect(message.body?.isWellFormed()).toBe(true);
	expect(message.body?.endsWith("…")).toBe(true);
});
