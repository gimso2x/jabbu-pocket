// 디렉터리 계층 경계 및 I7(`omp` 직접 import 금지) 정적 게이트: 새 역참조를 막고 기존 부채 기준선은 내리기만 한다.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const BASELINE = "src/dev/layer-baseline.json";
const FORBIDDEN_PACKAGES = /^@(?:oh-my-pi|earendil-works)\//;
const words = (text: string) => text.split(" ");
const UPPER = words("daemon dashboard lanes tasks cli dispatch flow monitors review wiki");
const ALL_RUNTIME_LAYERS = words(
	"(root) channel cli core daemon dashboard discord dispatch flow lanes monitors omp ops release review safety store tasks web wiki",
);

const FORBIDDEN_LAYERS: Record<string, ReadonlySet<string>> = {
	store: new Set(UPPER),
	channel: new Set([...UPPER, "discord", "web"]),
	omp: new Set(UPPER),
	core: new Set(["daemon", "dashboard", "cli", "discord", "web"]),
	safety: new Set(["daemon", "dashboard", "cli", "discord"]),
	discord: new Set(["web", "daemon", "dashboard", "cli"]),
	web: new Set(["discord", "cli"]),
	dev: new Set(ALL_RUNTIME_LAYERS),
};

const REGEX_PREV_KEYWORDS = new Set(
	words("await case default delete do else export in instanceof new of return throw typeof void yield"),
);
const STATEMENT_HEADER_KEYWORDS = new Set(["for", "if", "while", "with"]);
const IMPORT_STOP_KEYWORDS = new Set(words("class const export function import interface let return var"));

interface Token {
	kind: "id" | "str" | "num" | "punct" | "regex";
	val: string;
}

export interface LayerIssues {
	hard: string[];
	edges: string[];
}

function skipString(code: string, start: number, quote: string): { val: string; next: number } {
	let i = start + 1;
	let out = "";
	while (i < code.length) {
		const ch = code[i];
		if (ch === undefined || ch === quote) return { val: out, next: i + 1 };
		if (ch === "\\") {
			out += code[i + 1] ?? "";
			i += 2;
		} else {
			out += ch;
			i += 1;
		}
	}
	return { val: out, next: i };
}

function skipTemplate(code: string, start: number): number {
	let i = start + 1;
	while (i < code.length) {
		const ch = code[i];
		if (ch === undefined) break;
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") return i + 1;
		if (ch === "$" && code[i + 1] === "{") {
			i = skipTemplateExpr(code, i + 2);
			continue;
		}
		i += 1;
	}
	return i;
}

function skipTemplateExpr(code: string, start: number): number {
	let i = start;
	let depth = 1;
	while (i < code.length && depth > 0) {
		const ch = code[i];
		if (ch === undefined) break;
		if (ch === "/" && code[i + 1] === "/") {
			i += 2;
			while (i < code.length && code[i] !== "\n") i += 1;
		} else if (ch === "/" && code[i + 1] === "*") {
			i += 2;
			while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
			i += 2;
		} else if (ch === '"' || ch === "'") {
			i = skipString(code, i, ch).next;
		} else if (ch === "`") {
			i = skipTemplate(code, i);
		} else if (ch === "{") {
			depth += 1;
			i += 1;
		} else if (ch === "}") {
			depth -= 1;
			i += 1;
		} else {
			i += 1;
		}
	}
	return i;
}

function tokenizeTs(code: string): Token[] {
	const tokens: Token[] = [];
	const parenHeaderStack: boolean[] = [];
	let i = 0;
	const canStartRegex = (lastClosedHeader: boolean): boolean => {
		const prev = tokens.at(-1);
		if (prev === undefined) return true;
		if (prev.kind === "num" || prev.kind === "str" || prev.kind === "regex") return false;
		if (prev.kind === "id") return REGEX_PREV_KEYWORDS.has(prev.val);
		if (prev.val === ")") return lastClosedHeader;
		return prev.val !== "]" && prev.val !== "++" && prev.val !== "--";
	};
	let lastClosedHeader = false;
	while (i < code.length) {
		const ch = code[i];
		if (ch === undefined) break;
		if (ch === "/" && code[i + 1] === "/") {
			i += 2;
			while (i < code.length && code[i] !== "\n") i += 1;
		} else if (ch === "/" && code[i + 1] === "*") {
			i += 2;
			while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
			i += 2;
		} else if (ch === "/" && canStartRegex(lastClosedHeader)) {
			let j = i + 1;
			let inClass = false;
			while (j < code.length) {
				const rc = code[j];
				if (rc === undefined || rc === "\n") break;
				if (rc === "\\") {
					j += 2;
					continue;
				}
				if (rc === "[") inClass = true;
				else if (rc === "]") inClass = false;
				else if (!inClass && rc === "/") {
					j += 1;
					break;
				}
				j += 1;
			}
			while (j < code.length && /[a-z]/i.test(code[j] ?? "")) j += 1;
			tokens.push({ kind: "regex", val: code.slice(i, j) });
			lastClosedHeader = false;
			i = j;
		} else if (ch === '"' || ch === "'") {
			const parsed = skipString(code, i, ch);
			tokens.push({ kind: "str", val: parsed.val });
			lastClosedHeader = false;
			i = parsed.next;
		} else if (ch === "`") {
			i = skipTemplate(code, i);
			tokens.push({ kind: "str", val: "" });
			lastClosedHeader = false;
		} else if (/[0-9]/.test(ch)) {
			let j = i + 1;
			while (j < code.length && /[0-9a-fA-FxXoObBn._]/.test(code[j] ?? "")) j += 1;
			tokens.push({ kind: "num", val: code.slice(i, j) });
			lastClosedHeader = false;
			i = j;
		} else if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < code.length && /[A-Za-z0-9_$]/.test(code[j] ?? "")) j += 1;
			tokens.push({ kind: "id", val: code.slice(i, j) });
			lastClosedHeader = false;
			i = j;
		} else if (/\s/.test(ch)) {
			i += 1;
		} else if ((ch === "+" && code[i + 1] === "+") || (ch === "-" && code[i + 1] === "-")) {
			tokens.push({ kind: "punct", val: `${ch}${ch}` });
			lastClosedHeader = false;
			i += 2;
		} else {
			if (ch === "(") {
				const prev = tokens.at(-1);
				parenHeaderStack.push(prev?.kind === "id" && STATEMENT_HEADER_KEYWORDS.has(prev.val));
				lastClosedHeader = false;
			} else if (ch === ")") {
				lastClosedHeader = parenHeaderStack.pop() ?? false;
			} else {
				lastClosedHeader = false;
			}
			tokens.push({ kind: "punct", val: ch });
			i += 1;
		}
	}
	return tokens;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

const takeFrom = (tokens: readonly Token[], pos: number): string | undefined =>
	tokens[pos]?.kind === "id" && tokens[pos]?.val === "from" && tokens[pos + 1]?.kind === "str"
		? tokens[pos + 1]?.val
		: undefined;

/** 소스 문자열에서 런타임·타입 전용·re-export·require 모듈 지정자를 중복 없이 추출한다. */
export function scanImportSpecifiers(code: string): string[] {
	const stripped = code.replace(/^#![^\n]*\n?/, "");
	const specs = new Set<string>();
	for (const entry of transpiler.scanImports(stripped)) specs.add(entry.path);
	const tokens = tokenizeTs(stripped);
	for (let k = 0; k < tokens.length; k += 1) {
		const token = tokens[k];
		if (token === undefined || token.kind !== "id") continue;
		const prev = tokens[k - 1];
		if (prev?.kind === "punct" && prev.val === ".") continue;
		const next = tokens[k + 1];
		if (next?.kind === "punct" && next.val === ":") continue;

		if (token.val === "import") {
			if (next?.kind === "punct" && next.val === "(" && tokens[k + 2]?.kind === "str") {
				const arg = tokens[k + 2];
				if (arg !== undefined) specs.add(arg.val);
				continue;
			}
			if (next?.kind === "str") {
				specs.add(next.val);
				continue;
			}
			if (
				next?.kind === "id" &&
				tokens[k + 2]?.kind === "punct" &&
				tokens[k + 2]?.val === "=" &&
				tokens[k + 3]?.kind === "id" &&
				tokens[k + 3]?.val === "require" &&
				tokens[k + 4]?.kind === "punct" &&
				tokens[k + 4]?.val === "(" &&
				tokens[k + 5]?.kind === "str"
			) {
				const req = tokens[k + 5];
				if (req !== undefined) specs.add(req.val);
				continue;
			}
			let depth = 0;
			for (let m = k + 1; m < tokens.length; m += 1) {
				const cur = tokens[m];
				if (cur === undefined) break;
				if (cur.kind === "punct" && (cur.val === "{" || cur.val === "(")) depth += 1;
				else if (cur.kind === "punct" && (cur.val === "}" || cur.val === ")")) depth = Math.max(0, depth - 1);
				else if (depth === 0) {
					if (cur.kind === "punct" && (cur.val === ";" || cur.val === "=" || cur.val === ":" || cur.val === "(")) break;
					if (cur.kind === "id" && IMPORT_STOP_KEYWORDS.has(cur.val)) break;
					const fromTarget = takeFrom(tokens, m);
					if (fromTarget !== undefined) {
						specs.add(fromTarget);
						k = m + 1;
						break;
					}
				}
			}
		} else if (token.val === "export") {
			let pos = k + 1;
			if (tokens[pos]?.kind === "id" && tokens[pos]?.val === "type") pos += 1;
			const head = tokens[pos];
			if (head?.kind !== "punct") continue;
			if (head.val === "*") {
				pos += 1;
				if (tokens[pos]?.kind === "id" && tokens[pos]?.val === "as" && tokens[pos + 1]?.kind === "id") pos += 2;
			} else if (head.val === "{") {
				let depth = 1;
				pos += 1;
				while (pos < tokens.length && depth > 0) {
					const cur = tokens[pos];
					if (cur === undefined) break;
					if (cur.kind === "punct" && cur.val === "{") depth += 1;
					else if (cur.kind === "punct" && cur.val === "}") depth -= 1;
					pos += 1;
				}
			} else continue;
			const fromTarget = takeFrom(tokens, pos);
			if (fromTarget !== undefined) {
				specs.add(fromTarget);
				k = pos + 1;
			}
		}
	}
	return [...specs].sort();
}

function layerOf(srcRelative: string): string {
	const slash = srcRelative.indexOf("/");
	return slash === -1 ? "(root)" : srcRelative.slice(0, slash);
}

/** `root/src` 아래 `.ts` 파일에서 I7 금지 패키지(`hard`)와 계층 역참조(`edges`)를 수집한다. */
export function scanLayerIssues(root: string): LayerIssues {
	const srcRoot = resolve(root, "src");
	const files = [...new Bun.Glob("src/**/*.ts").scanSync(root)].map((f) => f.replaceAll("\\", "/")).sort();
	const hard = new Set<string>();
	const edges = new Set<string>();
	for (const file of files) {
		const fromLayer = layerOf(file.slice("src/".length));
		const deny = FORBIDDEN_LAYERS[fromLayer];
		const code = readFileSync(join(root, file), "utf8");
		for (const spec of scanImportSpecifiers(code)) {
			if (FORBIDDEN_PACKAGES.test(spec)) {
				hard.add(`${file} -> ${spec} (I7 금지 패키지)`);
				continue;
			}
			if (!spec.startsWith(".") || deny === undefined) continue;
			const resolved = resolve(dirname(join(root, file)), spec);
			const target = relative(srcRoot, resolved).replaceAll("\\", "/");
			if (target === "" || target.startsWith("..")) continue;
			const normalized = target.replace(/\.[cm]?[jt]sx?$/, "");
			if (deny.has(layerOf(normalized))) {
				edges.add(`${file} -> src/${normalized}`);
			}
		}
	}
	return { hard: [...hard].sort(), edges: [...edges].sort() };
}

/** 기준선에 없는 계층 역참조와 I7 금지 패키지 위반을 반환한다. */
export function layerViolations(issues: LayerIssues, baseline: readonly string[]): string[] {
	const allowed = new Set(baseline);
	return [...issues.hard, ...issues.edges.filter((edge) => !allowed.has(edge))];
}

/** 기준선을 내리기만 한다: 여전히 남은 엣지만 정렬 유지하고 새 엣지는 넣지 않는다. */
export function lowerLayerBaseline(edges: readonly string[], baseline: readonly string[]): string[] {
	const active = new Set(edges);
	return baseline.filter((edge) => active.has(edge)).sort();
}

if (import.meta.main) {
	const rootArg = process.argv.find((arg) => arg.startsWith("--root="))?.slice(7);
	const repo = rootArg ?? join(import.meta.dir, "..", "..");
	const baselinePath = join(repo, ...BASELINE.split("/"));
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as string[];
	const issues = scanLayerIssues(repo);
	const next = lowerLayerBaseline(issues.edges, baseline);
	const reduced = baseline.length - next.length;
	let activeBaseline = baseline;
	if (process.argv.includes("--update")) {
		writeFileSync(baselinePath, `${JSON.stringify(next, null, "\t")}\n`);
		activeBaseline = next;
		console.log(`[check-layers] 기준선 하향 ${reduced}건`);
	} else if (reduced > 0) {
		console.log(`[check-layers] 해소된 기준선 ${reduced}건 — bun src/dev/check-layers.ts --update로 기준선을 내리세요`);
	}
	const over = layerViolations(issues, activeBaseline);
	for (const line of over) console.error(line);
	if (over.length > 0) {
		console.error(`[check-layers] ${over.length}건 위반. 계층 역참조나 I7 금지 패키지 import를 제거하세요.`);
	}
	process.exitCode = over.length > 0 ? 1 : 0;
}
