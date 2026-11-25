import { expect, test } from "bun:test";
import { parseForm } from "../src/omp/form";

test("a numeric entity naming a surrogate code point never becomes a lone surrogate in the form model", () => {
	const form = parseForm('<form><input name="a" value="x&#xD800;y&#55357;z"><input name="b" value="&#x1F600;"></form>');
	const [a, b] = form?.fields ?? [];
	expect(a?.kind === "text" ? a.value.isWellFormed() : false).toBe(true);
	expect(b?.kind === "text" ? b.value : "").toBe("😀");
});
