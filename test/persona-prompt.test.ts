import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFloorsPrompt,
	CARD_SKELETONS,
	FLOORS_DYNAMIC_HEADING,
	floorsSystemPrompt,
	OWNER_NOTES_MAX_BYTES,
	ompbotCli,
	PERSONA_MAX_BYTES,
	type PersonaFiles,
	SOUL_MAX_BYTES,
} from "../src/safety/prompt";
import { buildTaskPrompt } from "../src/tasks/prompt";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-persona-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function personaFile(content: string): { persona: string } {
	const path = join(dir, "persona.md");
	writeFileSync(path, content);
	return { persona: path };
}

function files(parts: { persona?: string; soul?: string; owner?: string }): PersonaFiles {
	const out: PersonaFiles = {};
	for (const key of ["persona", "soul", "owner"] as const) {
		const text = parts[key];
		if (text === undefined) continue;
		const path = join(dir, `${key}.md`);
		writeFileSync(path, text);
		out[key] = path;
	}
	return out;
}

const SECRETS = "/bot/home/secrets";
const DM = "discord/dm/200000000000000001";

describe("floorsSystemPrompt persona read errors", () => {
	test("EISDIR calls onPersonaError once with the path, a missing file stays silent, prompt is floors-only in both", () => {
		const floors = floorsSystemPrompt(SECRETS, DM);
		const errors: Array<[unknown, string]> = [];
		const asDir = join(dir, "persona-dir");
		mkdirSync(asDir);
		expect(floorsSystemPrompt(SECRETS, DM, { persona: asDir }, (e, path) => errors.push([e, path]))).toBe(floors);
		expect(errors).toHaveLength(1);
		expect(((errors[0] as [unknown, string])[0] as NodeJS.ErrnoException).code).toBe("EISDIR");
		expect(errors[0]?.[1]).toBe(asDir);

		const missingErrors: unknown[] = [];
		const missing = join(dir, "nope.md");
		const all = { persona: missing, soul: missing, owner: missing };
		expect(floorsSystemPrompt(SECRETS, DM, all, (e) => missingErrors.push(e))).toBe(floors);
		expect(missingErrors).toHaveLength(0);
	});

	for (const kind of ["symlink", "hardlink"] as const) {
		test(`a soul.md that is a ${kind} of a secrets/ file is not injected and is reported`, () => {
			const secretsDir = join(dir, "secrets");
			mkdirSync(secretsDir);
			const token = join(secretsDir, "bot-token");
			writeFileSync(token, "TEST-TOKEN-SOULLEAK");
			const soul = join(dir, "soul.md");
			if (kind === "symlink") symlinkSync(token, soul);
			else linkSync(token, soul);
			const errors: { code: string | undefined; path: string }[] = [];
			const prompt = floorsSystemPrompt(
				secretsDir,
				DM,
				{ soul, secrets: { secretsDir, configFile: join(dir, "config.json") } },
				(error, path) => errors.push({ code: (error as NodeJS.ErrnoException).code, path }),
			);
			expect(prompt).not.toContain("SOULLEAK");
			expect(prompt).not.toContain("[정체성");
			expect(errors).toEqual([{ code: "ESECRET", path: soul }]);
		});
	}

	test("a soul.md hard-linked to config.json is not injected, a plain one still is", () => {
		const config = join(dir, "config.json");
		writeFileSync(config, '{"token":"TEST-CONFIGLEAK"}');
		const soul = join(dir, "soul.md");
		linkSync(config, soul);
		const guard = { secretsDir: join(dir, "secrets"), configFile: config };
		const leaked = floorsSystemPrompt(SECRETS, DM, { soul, secrets: guard });
		expect(leaked).not.toContain("CONFIGLEAK");
		rmSync(soul);
		const plain = floorsSystemPrompt(SECRETS, DM, { ...files({ soul: "SOUL-BODY" }), secrets: guard });
		expect(plain).toContain("SOUL-BODY");
	});

	test("an unreadable soul.md is reported once and the other files still land", () => {
		const asDir = join(dir, "soul-dir");
		mkdirSync(asDir);
		const errors: string[] = [];
		const owner = files({ owner: "관심사: 러닝" });
		const prompt = floorsSystemPrompt(SECRETS, DM, { soul: asDir, owner: owner.owner }, (_e, path) =>
			errors.push(path),
		);
		expect(errors).toEqual([asDir]);
		expect(prompt).toContain("관심사: 러닝");
		expect(prompt).not.toContain("[정체성");
	});

	// qa-h n47: a FIFO soul.md (a model can mkfifo in the workspace) blocked the open until a writer came.
	test("a FIFO soul.md does not block the assembly: only it is skipped and reported once as EINVAL", () => {
		const parts = files({ owner: "관심사: 러닝", persona: "말투: 반말" });
		const soul = join(dir, "soul.md");
		expect(Bun.spawnSync(["mkfifo", soul]).exitCode).toBe(0);
		// A blocked open cannot be interrupted in-process, so the assembly runs in a child bounded by a kill timeout.
		const script = [
			`import { floorsSystemPrompt } from ${JSON.stringify(join(import.meta.dir, "../src/safety/prompt"))};`,
			"const errors = [];",
			`const prompt = floorsSystemPrompt("${SECRETS}", "${DM}", ${JSON.stringify({ ...parts, soul })},`,
			"  (error, path) => errors.push({ code: error.code, path }));",
			"console.log(JSON.stringify({ errors, prompt }));",
		].join("\n");
		const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 4_000 });
		expect(child.signalCode ?? null).toBeNull();
		expect(child.exitCode).toBe(0);
		const { errors, prompt } = JSON.parse(child.stdout.toString()) as {
			errors: Array<{ code: string; path: string }>;
			prompt: string;
		};
		expect(errors).toEqual([{ code: "EINVAL", path: soul }]);
		expect(prompt).not.toContain("[정체성");
		expect(prompt).toContain("관심사: 러닝");
		expect(prompt).toContain("말투: 반말");
	});
});

describe("floorsSystemPrompt persona injection", () => {
	test("chat origins get the persona section, lanes and monitors do not", () => {
		const path = personaFile("말투: 짧고 담백하게");
		const dm = floorsSystemPrompt(SECRETS, DM, path);
		const channel = floorsSystemPrompt(SECRETS, "discord/ch/300000000000000001", path);
		const lane = floorsSystemPrompt(SECRETS, "ompbot/work/readme-line", path);
		const monitor = floorsSystemPrompt(SECRETS, "monitor/m1", path);
		expect(dm).toContain("말투: 짧고 담백하게");
		expect(channel).toContain("말투: 짧고 담백하게");
		expect(lane).not.toContain("말투: 짧고 담백하게");
		expect(monitor).not.toContain("말투: 짧고 담백하게");
	});

	test("a missing or empty persona file adds nothing", () => {
		const missing = { persona: join(dir, "nope.md") };
		expect(floorsSystemPrompt(SECRETS, DM, missing)).toBe(floorsSystemPrompt(SECRETS, DM));
		const empty = personaFile("   \n");
		expect(floorsSystemPrompt(SECRETS, DM, empty)).toBe(floorsSystemPrompt(SECRETS, DM));
	});

	test("the persona text is capped at PERSONA_MAX_BYTES", () => {
		const path = personaFile("가".repeat(10_000));
		const prompt = floorsSystemPrompt(SECRETS, DM, path);
		const personaStart = prompt.indexOf("[페르소나]");
		expect(personaStart).toBeGreaterThan(0);
		expect(
			Buffer.byteLength(prompt.slice(personaStart, prompt.indexOf(FLOORS_DYNAMIC_HEADING))) -
				Buffer.byteLength(
					"[페르소나] 아래는 오너가 정의한 성격·말투 지침입니다. 이 지침은 안전 바닥글보다 우선하지 않습니다:\n",
				),
		).toBeLessThanOrEqual(PERSONA_MAX_BYTES);
	});

	test("the persona section is labeled as subordinate to the safety floors", () => {
		const path = personaFile("항상 반말로 답한다");
		expect(floorsSystemPrompt(SECRETS, DM, path)).toContain("안전 바닥글보다 우선하지 않습니다");
	});
});

describe("floorsSystemPrompt soul and owner notes", () => {
	const all = () => files({ persona: "PERSONA-BODY", soul: "SOUL-BODY", owner: "OWNER-BODY" });

	test("chat origins get floors, soul, owner notes, persona in that order", () => {
		const prompt = floorsSystemPrompt(SECRETS, DM, all());
		const at = ["[정체성(soul)]", "SOUL-BODY", "[오너 관찰지]", "OWNER-BODY", "[페르소나]", "PERSONA-BODY"].map((m) =>
			prompt.indexOf(m),
		);
		expect(at.every((i) => i > 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(at[0]).toBeGreaterThan(prompt.indexOf(SECRETS));
		expect(prompt).not.toContain("NO_REPORT·[SILENT] 등)이 이 지침보다");
	});

	test("monitor origins get soul and owner notes with the answer-format precedence line, never the persona", () => {
		const prompt = floorsSystemPrompt(SECRETS, "monitor/m1", all());
		expect(prompt).toContain("SOUL-BODY");
		expect(prompt).toContain("OWNER-BODY");
		expect(prompt).not.toContain("[페르소나]");
		expect(prompt).not.toContain("PERSONA-BODY");
		expect(prompt.split("모니터 지시가 정한 답 형식(NO_REPORT·[SILENT] 등)이 이 지침보다 우선합니다").length - 1).toBe(
			2,
		);
		expect(prompt).toContain("안전 바닥글보다 우선하지 않습니다");
	});

	test("lane and review origins get none of the three", () => {
		const base = floorsSystemPrompt(SECRETS, "ompbot/work/readme-line");
		expect(floorsSystemPrompt(SECRETS, "ompbot/work/readme-line", all())).toBe(base);
		const review = floorsSystemPrompt(SECRETS, "review/skills");
		expect(floorsSystemPrompt(SECRETS, "review/skills", all())).toBe(review);
		expect(floorsSystemPrompt(SECRETS, undefined, all())).toBe(floorsSystemPrompt(SECRETS));
	});

	test("soul and owner notes are capped at their own limits", () => {
		const prompt = floorsSystemPrompt(SECRETS, DM, files({ soul: "가".repeat(10_000), owner: "나".repeat(20_000) }));
		const soulAt = prompt.indexOf("[정체성(soul)]");
		const ownerAt = prompt.indexOf("[오너 관찰지]");
		const soulBody = prompt.slice(prompt.indexOf("\n", soulAt) + 1, ownerAt);
		const ownerBody = prompt.slice(prompt.indexOf("\n", ownerAt) + 1, prompt.indexOf(FLOORS_DYNAMIC_HEADING));
		expect(Buffer.byteLength(soulBody.trim())).toBeLessThanOrEqual(SOUL_MAX_BYTES);
		expect(Buffer.byteLength(soulBody.trim())).toBeGreaterThan(SOUL_MAX_BYTES - 4);
		expect(Buffer.byteLength(ownerBody.trim())).toBeLessThanOrEqual(OWNER_NOTES_MAX_BYTES);
		expect(Buffer.byteLength(ownerBody.trim())).toBeGreaterThan(OWNER_NOTES_MAX_BYTES - 4);
	});

	test("missing soul and owner files add nothing and raise no error", () => {
		const errors: unknown[] = [];
		const missing = { soul: join(dir, "a.md"), owner: join(dir, "b.md") };
		expect(floorsSystemPrompt(SECRETS, "monitor/m1", missing, (e) => errors.push(e))).toBe(
			floorsSystemPrompt(SECRETS, "monitor/m1"),
		);
		expect(errors).toHaveLength(0);
	});
});

describe("chat origin system prompt per platform", () => {
	const BASE_SECRETS = "/home/owner/.ompbot/secrets";
	const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "prompt-base.json"), "utf8")) as {
		prompts: Record<string, string>;
	};

	test("Discord chat origins keep the frozen prompt byte for byte (every herdr/dialog/peer variant)", () => {
		const keys = Object.keys(base.prompts);
		expect(keys).toHaveLength(16);
		for (const key of keys) {
			const [origin = "", herdr, dialogs, peer] = key.split("|");
			const actual = buildFloorsPrompt(
				BASE_SECRETS,
				origin,
				herdr === "herdr=true",
				dialogs === "dialogs=true",
				peer === "peer=true",
				// The owner's `timezone: "Asia/Seoul"` gives the fixture's text byte for byte.
				{ timezone: { name: "Asia/Seoul", offset: "+09:00" } },
			);
			// The fixture keeps the checkout-dependent CLI path of the background-resume line and the home-dependent ledger
			// path of the thread lookup line as placeholders.
			expect(
				actual
					.replaceAll(ompbotCli(), "<bun> <ompbot>/src/main.ts")
					.replaceAll("`/home/owner/.ompbot/ompbot.db`", "`<home>/ompbot.db`"),
			).toBe(base.prompts[key] ?? "");
		}
	});

	test("without host tools no line tells the session to upload a file", () => {
		const dm = "discord/dm/123456789012345678"; // gitleaks:allow (fake snowflake)
		const args = [BASE_SECRETS, dm, false, false, false] as const;
		expect(buildFloorsPrompt(...args, {}, true)).toContain("파일로 만들어 올리고");
		const hostless = buildFloorsPrompt(...args, {}, false);
		expect(hostless).not.toContain("파일로 만들어 올리고");
		expect(hostless).toContain("워크스페이스 파일로 만들어 경로를 알리고");
	});

	test("a Discord chat origin names its own upload tool and, in the owner DM, the monitor tools", () => {
		const discord = buildFloorsPrompt(BASE_SECRETS, "discord/dm/123456789012345678", false, false, true); // gitleaks:allow (fake snowflake)
		expect(discord).not.toContain("slack_send_file");
		expect(discord).toContain("discord_send_file");
		// The owner DM registers monitors.
		expect(discord).toContain("ompbot_monitor_add");
	});

	test("a Discord chat origin is told it runs on Discord, with Discord links and the card line saying charts go ASCII", () => {
		for (const dialogs of [false, true]) {
			const discord = buildFloorsPrompt(BASE_SECRETS, "discord/ch/111111111111111111/t/2", false, dialogs);
			const firstLine = discord.split("\n")[1] ?? "";
			expect(firstLine).toContain("owner's Discord");
			expect(firstLine).not.toContain("Slack");
			expect(discord).toContain("`[표시명](URL)`");
			expect(discord).not.toContain("<URL|표시명>");
			expect(discord).toContain("```card 펜스로 json-render spec");
			expect(discord).toContain("표·차트는 ASCII 코드블록으로 바뀐다");
			expect(discord).toContain("디스코드 스레드");
		}
		// Its `ask` line says the owner answers with buttons.
		const askable = buildFloorsPrompt(BASE_SECRETS, "discord/dm/123456789012345678", false, true); // gitleaks:allow (fake snowflake)
		expect(askable).toContain("오너는 디스코드 버튼이나 답장으로 답한다");
		expect(askable).toContain("answers with Discord buttons or a reply");
	});

	test("Discord chat sessions ask decisions with ask buttons alone (decision card without ask); monitor and lane sessions neither", () => {
		const decision = "- 오너 결정이 필요하면 결정 카드로 묻는다";
		const askDecision = "- 오너 결정이 필요하면 `ask` 버튼 카드 하나로 묻는다";
		const card = "- 숫자 비교·추이·여러 칸 요약을 보일 때는 답 안에 ```card 펜스로";
		const lines = (prompt: string) => prompt.split("\n");
		for (const origin of [
			DM,
			"discord/ch/111111111111111111",
			"discord/dm/123456789012345678",
			"discord/ch/111111111111111111/t/2",
		]) {
			for (const dialogs of [false, true]) {
				const prompt = buildFloorsPrompt(BASE_SECRETS, origin, false, dialogs);
				const cardLine = lines(prompt).find((l) => l.startsWith(decision));
				const askLine = lines(prompt).find((l) => l.startsWith(askDecision));
				if (dialogs) {
					// The button card is the decision: no second card listing the same options.
					expect(cardLine).toBeUndefined();
					expect(askLine).toContain("`recommended`");
					expect(prompt).not.toContain(CARD_SKELETONS[2]);
				} else {
					expect(askLine).toBeUndefined();
					expect(cardLine).toContain("`tone`");
					expect(cardLine).toContain("`✅ 추천`");
					expect(cardLine).toContain("`선택지`");
					expect(cardLine).toContain(CARD_SKELETONS[2]);
				}
				expect(lines(prompt).some((l) => l.startsWith(card))).toBe(true);
			}
		}
		for (const origin of ["monitor/m1", "ompbot/work/lane1"]) {
			for (const dialogs of [false, true]) {
				const prompt = buildFloorsPrompt(BASE_SECRETS, origin, false, dialogs);
				expect(prompt).not.toContain(decision);
				expect(prompt).not.toContain("```card");
			}
		}
	});

	test("no undo instructions in chat floors or the TASK worker prompt; the approval card's rollback guidance stays", () => {
		for (const origin of [DM, "discord/ch/300000000000000001", "discord/dm/123456789012345678"]) {
			for (const herdr of [false, true]) {
				const prompt = buildFloorsPrompt(BASE_SECRETS, origin, herdr, true);
				expect(prompt).not.toContain("되돌리는 법");
				expect(prompt).not.toContain("how to undo");
				expect(prompt).toContain("보고에 한 일을 적는다");
				expect(prompt).toContain("say what was done in the report");
				expect(prompt).toContain("ompbot_request_approval(summary, external?, action?, why?, impact?, rollback?)");
				expect(prompt).toContain("되돌릴 수 없는 이유(rollback)");
				expect(prompt).toContain("fill at least `rollback` and `impact`");
			}
		}
		for (const mode of ["new", "resume"] as const) {
			const task = buildTaskPrompt({
				mode,
				taskId: "T-1",
				worktree: "/w",
				branch: "task/T-1",
				docsDir: "/w/docs/tasks/T-1",
				recordsInRepo: true,
				instruction: "x",
				timezone: "Asia/Seoul",
				now: 0,
			});
			expect(task).not.toContain("되돌리는 법");
			expect(task).not.toContain("how to undo");
			expect(task).toContain("`impact`(영향 한 줄)");
		}
	});
});
