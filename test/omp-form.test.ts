import { describe, expect, test } from "bun:test";
import {
	defaultAnswer,
	type FormAnswer,
	type FormModel,
	fieldProblem,
	fieldValue,
	formData,
	formDefaults,
	parseForm,
} from "../src/omp/form";

const FULL = `<form>
<p>Which database should the service use?</p>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
<fieldset><legend>Features</legend>
<label><input type="checkbox" name="features" value="auth" checked> Auth</label>
<label><input type="checkbox" name="features" value="cache"> Cache</label>
<label><input type="checkbox" name="features" value="other"> Other thing</label>
</fieldset>
<label><input type="checkbox" name="tests" value="yes"> Run tests</label>
<label>Region <select name="region"><option value="us">US</option><option value="eu" selected>EU</option></select></label>
<label>Tags <select name="tags" multiple><option value="a">A</option><option value="b" selected>B</option><option value="c">C</option></select></label>
<label>Name <input type="text" name="svc" value="api" placeholder="x" required></label>
<label>Replicas <input type="number" name="replicas" min="1" max="5" value="2"></label>
<label>Notes <textarea name="notes">
hello &amp; bye</textarea></label>
<input type="hidden" name="token" value="t1">
</form>`;

function model(html = FULL): FormModel {
	const parsed = parseForm(html);
	if (parsed === undefined) throw new Error("fixture did not parse");
	return parsed;
}

const byName = (form: FormModel, name: string) => {
	const field = form.fields.find((candidate) => candidate.name === name);
	if (field === undefined) throw new Error(`no field ${name}`);
	return field;
};

describe("parseForm (omp 19.1 parseHtmlForm shapes)", () => {
	test("fields, options, defaults and titles", () => {
		const form = model();
		expect(form.fields.map((field) => field.name)).toEqual([
			"db",
			"features",
			"tests",
			"region",
			"tags",
			"svc",
			"replicas",
			"notes",
		]);
		expect(form.hidden).toEqual([["token", "t1"]]);
		const db = byName(form, "db");
		if (db.kind !== "choice") throw new Error("db is a choice");
		expect(db).toMatchObject({
			title: "Which database should the service use?",
			multi: false,
			select: false,
			other: true,
		});
		expect(db.options.map((option) => [option.value, option.label, option.checked])).toEqual([
			["sqlite", "SQLite", true],
			["pg", "Postgres", false],
		]);
		const features = byName(form, "features");
		if (features.kind !== "choice") throw new Error("features is a choice");
		// fieldset/legend titles the group; "Other thing" is not an "Other" option of its own kind... it starts with "other".
		expect(features).toMatchObject({ title: "Features", multi: true, other: false });
		expect(features.options.map((option) => option.checked)).toEqual([true, false, false]);
		const tests = byName(form, "tests");
		expect(tests).toMatchObject({ kind: "choice", multi: true, other: false, title: "Run tests" });
		const region = byName(form, "region");
		expect(region).toMatchObject({ kind: "choice", select: true, multi: false, other: false, title: "Region" });
		const tags = byName(form, "tags");
		if (tags.kind !== "choice") throw new Error("tags is a choice");
		expect(tags).toMatchObject({ select: true, multi: true });
		expect(tags.options.map((option) => option.checked)).toEqual([false, true, false]);
		expect(byName(form, "svc")).toMatchObject({ kind: "text", title: "Name", value: "api", required: true });
		expect(byName(form, "replicas")).toMatchObject({ kind: "text", type: "number", min: 1, max: 5, value: "2" });
		expect(byName(form, "notes")).toMatchObject({ kind: "text", multiline: true, value: "hello & bye" });
	});

	test("a single select without a marked option opens on its first enabled option", () => {
		const form = model(
			`<form><select name="s"><option value="x" disabled>X</option><option value="y">Y</option></select></form>`,
		);
		const field = byName(form, "s");
		if (field.kind !== "choice") throw new Error("choice");
		expect(field.options.map((option) => option.checked)).toEqual([false, true]);
	});

	test("a lone checkbox without its own label is titled by its option; a name-only control by its name", () => {
		const form = model(`<form><input type="checkbox" name="ok" value="1"><input name="api_key"></form>`);
		expect(byName(form, "ok").title).toBe("1");
		expect(byName(form, "api_key").title).toBe("api key");
	});

	test("text outside any field's question stays as intro", () => {
		const form = model(
			`<form><h2>Deploy plan</h2><p>Pick one.</p><fieldset><legend>Env</legend><label><input type="radio" name="e" value="a"> A</label><label><input type="radio" name="e" value="b"> B</label></fieldset></form>`,
		);
		expect(form.intro).toBe("Deploy plan\nEnv");
		// omp fieldQuestions: the text right before a field outranks its section title.
		expect(byName(form, "e").title).toBe("Pick one.");
	});

	test("password, file, no-name and no-control forms are undefined", () => {
		expect(parseForm(`<form><input type="password" name="p"></form>`)).toBeUndefined();
		expect(parseForm(`<form><input name="a"><input type="file" name="f"></form>`)).toBeUndefined();
		expect(parseForm(`<form><input type="text"><select><option>x</option></select></form>`)).toBeUndefined();
		expect(parseForm(`<form><p>just text</p></form>`)).toBeUndefined();
		expect(parseForm(`<form><input type="hidden" name="h" value="1"></form>`)).toBeUndefined();
		expect(parseForm(`<form><input name="a"><input type="radio" name="a" value="1"></form>`)).toBeUndefined();
	});
});

// Expected shapes follow omp 19.1: `defaultFormData` / `choiceValue` / `isArrayChoice` (pi-tui html-form/data.ts) and the
// strict reader `parseFormDialogResponse` + `parseFormChoice` (pi-coding-agent modes/rpc/rpc-mode.ts 1217-1366).
describe("formDefaults / formData", () => {
	test("defaults: radio and select a string, groups an array, text a string, number a number, hidden kept (defaultFormData)", () => {
		expect(formDefaults(model())).toEqual({
			token: "t1",
			db: "sqlite",
			features: ["auth"],
			region: "eu",
			tags: ["b"],
			svc: "api",
			replicas: 2,
			notes: "hello & bye",
		});
	});

	test("a lone checkbox: on submits its value, off leaves the name out (isArrayChoice is false for one option)", () => {
		const form = model();
		const tests = byName(form, "tests");
		expect(formData(form, new Map<string, FormAnswer>([["tests", { checked: [0] }]])).tests).toBe("yes");
		expect("tests" in formData(form, new Map<string, FormAnswer>([["tests", { checked: [] }]]))).toBe(false);
		expect(defaultAnswer(tests)).toEqual({ checked: [] });
	});

	test("single: one string; unselected leaves the name out; Other text stands in for the value (choiceValue)", () => {
		const form = model();
		const db = byName(form, "db");
		expect(fieldValue(db, { checked: [1] })).toBe("pg");
		expect(fieldValue(db, { checked: [] })).toBeUndefined();
		expect(fieldValue(db, { checked: [], other: "  mysql " })).toBe("mysql");
		expect(formData(form, new Map<string, FormAnswer>([["db", { checked: [], other: "mysql" }]])).db).toBe("mysql");
	});

	test("multiple: an array; none is []; Other joins the array (choiceValue)", () => {
		const form = model();
		const tags = byName(form, "tags");
		expect(fieldValue(tags, { checked: [0, 2] })).toEqual(["a", "c"]);
		expect(fieldValue(tags, { checked: [] })).toEqual([]);
		const group = model(
			`<form><label><input type="checkbox" name="g" value="a"> A</label><label><input type="checkbox" name="g" value="b"> B</label></form>`,
		);
		expect(fieldValue(byName(group, "g"), { checked: [1], other: "z" })).toEqual(["b", "z"]);
	});

	test("an Other text is ignored where the field offers none (select)", () => {
		expect(fieldValue(byName(model(), "region"), { checked: [0], other: "mars" })).toBe("us");
	});

	test("number answers submit a number, text a string", () => {
		const form = model();
		expect(fieldValue(byName(form, "replicas"), { text: "4" })).toBe(4);
		expect(fieldValue(byName(form, "replicas"), { text: "" })).toBe("");
		expect(fieldValue(byName(form, "svc"), { text: "web" })).toBe("web");
	});

	test("some answers + defaults for the rest", () => {
		const data = formData(
			model(),
			new Map<string, FormAnswer>([
				["db", { checked: [1] }],
				["replicas", { text: "3" }],
			]),
		);
		expect(data).toEqual({
			token: "t1",
			db: "pg",
			features: ["auth"],
			region: "eu",
			tags: ["b"],
			svc: "api",
			replicas: 3,
			notes: "hello & bye",
		});
	});
});

// Rules follow omp `fieldError` (html-form/data.ts), which `parseFormDialogResponse` applies to every field.
describe("fieldProblem", () => {
	const form = model(`<form>
<input name="n" type="number" min="1" max="5">
<input name="p" pattern="[a-z]+">
<input name="r" required>
<label><input type="radio" name="c" value="a" required> A</label><label><input type="radio" name="c" value="b"> B</label>
<label><input type="checkbox" name="m" value="a" required> A</label><label><input type="checkbox" name="m" value="b"> B</label>
</form>`);
	const check = (name: string, answer: FormAnswer) => {
		const field = byName(form, name);
		return fieldProblem(field, fieldValue(field, answer));
	};

	test("number range", () => {
		expect(check("n", { text: "9" })).toContain("5");
		expect(check("n", { text: "0" })).toContain("1");
		expect(check("n", { text: "abc" })).toBeDefined();
		expect(check("n", { text: "3" })).toBeUndefined();
		expect(check("n", { text: "" })).toBeUndefined();
	});
	test("pattern is anchored", () => {
		expect(check("p", { text: "abc" })).toBeUndefined();
		expect(check("p", { text: "abc1" })).toBeDefined();
	});
	test("required text and choices", () => {
		expect(check("r", { text: " " })).toBeDefined();
		expect(check("c", { checked: [] })).toBeDefined();
		expect(check("c", { checked: [1] })).toBeUndefined();
		expect(check("m", { checked: [] })).toBeDefined();
	});
});
