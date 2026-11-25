import { expect, test } from "bun:test";
import { AUDIT_CMD_CHARS, createDispatchAudit } from "../src/dispatch/audit";

test("a clipped audit command never ends in a lone surrogate", () => {
	const lines: string[] = [];
	const audit = createDispatchAudit({ homeDir: "/unused", log: { warn: () => {} }, sink: (line) => lines.push(line) });
	audit.record(["echo", `${"a".repeat(AUDIT_CMD_CHARS - 6)}😀tail`], { code: 0, timedOut: false }, 1);
	const entry = JSON.parse(lines[0] ?? "{}") as { cmd: string };
	expect(entry.cmd.isWellFormed()).toBe(true);
	expect(entry.cmd.endsWith("…")).toBe(true);
});
