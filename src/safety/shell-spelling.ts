/**
 * 한 줄의 셸 표기 변환(`Spelling`)과 부분 문자열 편집(`edited`·`replaced`) 유틸리티.
 * `handoff-risk.ts`와 같은 `safety` 계층에서 ANSI-C 쿼팅(`$'...'`), 인용 분할(`r""m`),
 * 이스케이프된 따옴표·경로 구분자(`\"`, `\/`)를 실제 셸 실행 표기로 환원한다.
 */

/**
 * One spelling of a line: its text and, per character of it, the index in the line as written that character comes
 * from, so a hit found in a spelling is judged and excerpted where it stands in the line.
 */
export interface Spelling {
	text: string;
	/** Absent for the line as written, where every character comes from its own index. */
	origin?: number[];
}

/** A replacement of `[start, end)` of a spelling's text by `insert`. */
export interface Edit {
	start: number;
	end: number;
	insert: string;
}

/** Where the character at `index` of a spelling stands in the line as written; past the end, just after the last. */
export function inLine({ text, origin }: Spelling, index: number): number {
	if (origin === undefined) return index;
	return index < text.length ? (origin[index] as number) : (origin.at(-1) ?? -1) + 1;
}

/** `spelling` with `edits` (sorted, not overlapping) applied; an inserted character comes from where its edit starts. */
export function edited(spelling: Spelling, edits: readonly Edit[]): Spelling {
	if (edits.length === 0) return spelling;
	let text = "";
	const origin: number[] = [];
	let pos = 0;
	const copy = (to: number): void => {
		text += spelling.text.slice(pos, to);
		for (let index = pos; index < to; index++) origin.push(inLine(spelling, index));
	};
	for (const { start, end, insert } of edits) {
		copy(start);
		text += insert;
		const from = inLine(spelling, start);
		for (let k = 0; k < insert.length; k++) origin.push(from);
		pos = end;
	}
	copy(spelling.text.length);
	return { text, origin };
}

/** `spelling` with every match of the global `pattern` replaced by `insert`. */
export function replaced(spelling: Spelling, pattern: RegExp, insert = ""): Spelling {
	if (spelling.text.search(pattern) < 0) return spelling;
	const edits: Edit[] = [];
	for (const m of spelling.text.matchAll(pattern)) edits.push({ start: m.index, end: m.index + m[0].length, insert });
	return edited(spelling, edits);
}

const ANSI_C_QUOTE = /\$'((?:\\.|[^'\\])*)'/g;
const ANSI_C_ESCAPE = /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|c[@-_a-z]|[\s\S])/g;

function decodeCodePoint(cp: number, newline: string): string {
	// 개행·복귀 문자는 절 경계(`;`)로 바꿔 뒤따른 금지 문구가 앞 명령 절로 섞이지 않게 막는다.
	if (cp === 0x0a || cp === 0x0d) return newline;
	if (cp === 0x09) return " ";
	if (cp < 0x20 || cp === 0x7f || cp > 0x10ffff) return "";
	return String.fromCodePoint(cp);
}

function decodeAnsiCBody(body: string, newline: string): string {
	return body.replace(ANSI_C_ESCAPE, (_whole, esc: string) => {
		if (esc === "n" || esc === "r") return newline;
		if (esc === "t") return " ";
		if (esc === "\\") return "\\";
		if (esc === "'") return "'";
		if (esc === '"') return '"';
		// `\f`·`\v`는 SQL에서 공백이다: SQL 읽기(`newline`이 공백)에서만 공백으로, 셸 읽기에서는 단어 안에서 사라진다.
		if (esc === "f" || esc === "v") return newline === " " ? " " : "";
		if (esc === "a" || esc === "b" || esc === "e" || esc === "E") return "";
		if (esc.length === 2 && esc.startsWith("c")) return decodeCodePoint(esc.charCodeAt(1) & 0x1f, newline);
		if (esc.startsWith("x")) return decodeCodePoint(Number.parseInt(esc.slice(1), 16), newline);
		if (esc.startsWith("u") || esc.startsWith("U")) return decodeCodePoint(Number.parseInt(esc.slice(1), 16), newline);
		if (/^[0-7]{1,3}$/.test(esc)) return decodeCodePoint(Number.parseInt(esc, 8) & 0xff, newline);
		return esc;
	});
}

function decodeAnsiCQuotes(spelling: Spelling, newline: string): Spelling {
	if (!spelling.text.includes("$'")) return spelling;
	const edits: Edit[] = [];
	for (const match of spelling.text.matchAll(ANSI_C_QUOTE)) {
		edits.push({
			start: match.index,
			end: match.index + match[0].length,
			insert: decodeAnsiCBody(match[1] ?? "", newline),
		});
	}
	return edited(spelling, edits);
}

/**
 * The line as the shell reads its words:
 * 1) `$'...'` ANSI-C 쿼팅을 디코딩한다(`\n`·`\r`은 기본적으로 절 경계 `;`로 분리, `newline`으로 바꿀 수 있다).
 * 2) 이스케이프된 따옴표(`\"`, `\'`)를 해제한다.
 * 3) 공백·역따옴표 없는 인용 구간(`'--hard'`, `r""m`, `s'ec'rets`)의 따옴표를 걷어낸다.
 *    단어 안에 따옴표 하나만 있는 축약형(`don't`)은 짝이 없어 보존된다.
 * 4) 단어 문자·`/`·`-` 앞의 역슬래시(`\/etc`, `\--hard`)를 해제한다.
 */
export function shellSpelling(spelling: Spelling, newline = " ; "): Spelling {
	const unescapedQuotes = replaced(decodeAnsiCQuotes(spelling, newline), /\\(?=['"])/g);
	const quotes = Array.from(unescapedQuotes.text.matchAll(/(['"])([^'"\s`]*)\1/g), (m) => [
		{ start: m.index, end: m.index + 1, insert: "" },
		{ start: m.index + m[0].length - 1, end: m.index + m[0].length, insert: "" },
	]).flat();
	return replaced(edited(unescapedQuotes, quotes), /\\(?=[\w/-])/g);
}
