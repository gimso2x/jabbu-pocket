import { describe, expect, test } from "bun:test";
import { resolveExternalPr } from "../src/lanes/pr";

const git = async () => ({ code: 1, stdout: "", stderr: "" });
const titleOf = async (title: string): Promise<string> => {
	const resolved = await resolveExternalPr(
		{ repo: "o/r" },
		{ repoDir: "/tmp/none", baseBranch: "main", title, laneId: "lane-1" },
		git as never,
	);
	if (!resolved.ok) throw new Error(resolved.problem);
	return resolved.value.title;
};

describe("resolveExternalPr default title cut", () => {
	test("a short title is kept whole", async () => {
		expect(await titleOf("Fix 1A")).toBe("Fix 1A");
	});

	for (const last of ["A", "Z", "9", "b", "d", "f", "u", "x"]) {
		test(`a title cut at the limit keeps its last char ${last}`, async () => {
			const title = `${"a".repeat(199)}${last}tail`;
			expect(await titleOf(title)).toBe(`${"a".repeat(199)}${last}`);
		});
	}

	test("a surrogate pair split by the limit drops the lone high surrogate", async () => {
		const out = await titleOf(`${"a".repeat(199)}😀tail`);
		expect(out).toBe("a".repeat(199));
		expect(out.isWellFormed()).toBe(true);
	});

	test("a surrogate pair that fits is kept", async () => {
		const out = await titleOf(`${"a".repeat(198)}😀tail`);
		expect(out).toBe(`${"a".repeat(198)}😀`);
	});
});
