import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { layerViolations, lowerLayerBaseline, scanImportSpecifiers, scanLayerIssues } from "../src/dev/check-layers";

const roots: string[] = [];
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function makeTempRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "check-layers-"));
	roots.push(dir);
	return dir;
}

describe("check-layers", () => {
	test("정적·타입·re-export·동적·require·shebang import를 추출하고 비선언과 주석을 무시한다", () => {
		const sample = `#!/usr/bin/env bun
// import { commented } from "../daemon/fake";
/* export * from "../tasks/fake"; */
import side from "../core/a";
import type { OnlyType } from "../lanes/b";
import "../channel/c";
import Legacy = require("../store/d");
export { reexp } from "../monitors/e";
export type { ReType } from "../wiki/f";
export * as ns from "../review/g";
export const notReExport = 1;
const str = 'import x from "../daemon/str"';
const tmpl = \`head \${1 + 2} import y from "../daemon/tmpl"\`;
const rx1 = /'/;
const rx2 = /"/;
if (true) /'/.test("x");
const fakeObj = { import: (x: string) => x };
fakeObj.import("../daemon/prop");
type Dyn = typeof import("../dispatch/h");
const loader = () => import("../flow/i");
`;
		expect(scanImportSpecifiers(sample)).toEqual([
			"../channel/c",
			"../core/a",
			"../dispatch/h",
			"../flow/i",
			"../lanes/b",
			"../monitors/e",
			"../review/g",
			"../store/d",
			"../wiki/f",
		]);
	});

	test("금지 계층 역참조와 I7 금지 패키지 import를 구분해 판정한다", () => {
		const dir = makeTempRepo();
		mkdirSync(path.join(dir, "src", "store"), { recursive: true });
		mkdirSync(path.join(dir, "src", "core"), { recursive: true });
		mkdirSync(path.join(dir, "src", "daemon"), { recursive: true });
		mkdirSync(path.join(dir, "src", "channel"), { recursive: true });
		writeFileSync(path.join(dir, "src", "core", "a.ts"), "export const a = 1;\n");
		writeFileSync(path.join(dir, "src", "daemon", "d.ts"), 'import { a } from "../core/a";\nexport { a };\n');
		writeFileSync(
			path.join(dir, "src", "store", "s.ts"),
			'import { a } from "../core/a";\nimport { a as d } from "../daemon/d";\nexport { a, d };\n',
		);
		writeFileSync(path.join(dir, "src", "channel", "c.ts"), 'import "zod";\nimport "@oh-my-pi/pi-coding-agent";\n');

		const issues = scanLayerIssues(dir);
		expect(issues).toEqual({
			hard: ["src/channel/c.ts -> @oh-my-pi/pi-coding-agent (I7 금지 패키지)"],
			edges: ["src/store/s.ts -> src/daemon/d"],
		});
		expect(layerViolations(issues, ["src/store/s.ts -> src/daemon/d"])).toEqual([
			"src/channel/c.ts -> @oh-my-pi/pi-coding-agent (I7 금지 패키지)",
		]);
		expect(layerViolations(issues, [issues.hard[0] ?? ""])).toEqual([
			"src/channel/c.ts -> @oh-my-pi/pi-coding-agent (I7 금지 패키지)",
			"src/store/s.ts -> src/daemon/d",
		]);
	});

	test("기준선 하향은 여전히 존재하는 항목만 남기고 --update가 파일에 기록한다", () => {
		expect(
			lowerLayerBaseline(["src/a.ts -> src/b", "src/c.ts -> src/d"], ["src/gone.ts -> src/x", "src/a.ts -> src/b"]),
		).toEqual(["src/a.ts -> src/b"]);

		const dir = makeTempRepo();
		mkdirSync(path.join(dir, "src", "dev"), { recursive: true });
		mkdirSync(path.join(dir, "src", "store"), { recursive: true });
		mkdirSync(path.join(dir, "src", "daemon"), { recursive: true });
		writeFileSync(path.join(dir, "src", "daemon", "x.ts"), "export const x = 1;\n");
		writeFileSync(path.join(dir, "src", "store", "s.ts"), 'import { x } from "../daemon/x";\nexport { x };\n');
		const baselineFile = path.join(dir, "src", "dev", "layer-baseline.json");
		writeFileSync(
			baselineFile,
			`${JSON.stringify(["src/store/gone.ts -> src/daemon/y", "src/store/s.ts -> src/daemon/x"], null, "\t")}\n`,
		);

		const scriptPath = path.resolve(import.meta.dir, "../src/dev/check-layers.ts");
		const res = Bun.spawnSync(["bun", scriptPath, `--root=${dir}`, "--update"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(res.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(baselineFile, "utf8"))).toEqual(["src/store/s.ts -> src/daemon/x"]);
	});

	test("저장소의 현재 src는 커밋된 계층 기준선을 넘지 않고 잔여 부채도 없다", () => {
		const repo = path.join(import.meta.dir, "..");
		const baseline = JSON.parse(readFileSync(path.join(repo, "src/dev/layer-baseline.json"), "utf8")) as string[];
		const issues = scanLayerIssues(repo);
		expect(layerViolations(issues, baseline)).toEqual([]);
		expect(lowerLayerBaseline(issues.edges, baseline)).toEqual(baseline);
	});
});
