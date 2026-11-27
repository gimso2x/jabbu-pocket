import { describe, expect, test } from "bun:test";
import type { ProcessRunner, RunProcessResult } from "../src/dispatch/omp";
import { removeRemoteWorktree, syncRemoteBase } from "../src/tasks/host-sync";

/** The remote side of a call: ssh's argv minus `ssh -o … -o … -- <target>` and the trailing `2>&1`, quotes taken off. */
const remoteWords = (cmd: string[]): string[] =>
	cmd.slice(7, -1).map((word) => (word.startsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word));

type Reply = Partial<RunProcessResult>;
type Script = (words: string[]) => Reply | undefined;

/** A fake ssh: every call is recorded (target and remote words); `script` answers by the remote words, else exit 0 with no output. */
function fake(script: Script): { run: ProcessRunner; calls: { target: string; words: string[] }[] } {
	const calls: { target: string; words: string[] }[] = [];
	const run: ProcessRunner = async (cmd) => {
		expect(cmd.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--"]);
		expect(cmd.at(-1)).toBe("2>&1");
		const words = remoteWords(cmd);
		calls.push({ target: cmd[6] as string, words });
		return { code: 0, stdout: "", timedOut: false, ...script(words) };
	};
	return { run, calls };
}

const has = (words: string[], ...needle: string[]) => needle.every((word) => words.includes(word));

const REMOVE = {
	repo: "/home/u/work/app",
	worktree: "/home/u/work/app-wt/T-20261124-13",
	branch: "task/T-20261124-13",
};

describe("removeRemoteWorktree", () => {
	test("성공: 두 명령을 인용해 원격에서 돌리고 undefined", async () => {
		const { run, calls } = fake(() => undefined);
		expect(await removeRemoteWorktree(run, "wsl", REMOVE)).toBeUndefined();
		expect(calls.map((call) => call.words)).toEqual([
			["git", "-C", REMOVE.worktree, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
			["git", "-C", REMOVE.repo, "worktree", "remove", "--force", REMOVE.worktree],
			["git", "-C", REMOVE.repo, "branch", "-D", REMOVE.branch],
		]);
		expect(calls.every((call) => call.target === "wsl")).toBe(true);
	});

	test("이미 없음은 성공이다(worktree·branch 둘 다)", async () => {
		const { run } = fake((words) =>
			has(words, "ls-files")
				? { code: 128, stdout: `fatal: cannot change to '${REMOVE.worktree}': No such file or directory` }
				: has(words, "worktree")
					? { code: 128, stdout: `fatal: '${REMOVE.worktree}' is not a working tree` }
					: { code: 1, stdout: `error: branch '${REMOVE.branch}' not found.` },
		);
		expect(await removeRemoteWorktree(run, "wsl", REMOVE)).toBeUndefined();
	});

	test("다시 못 만드는 무시 파일이 있으면 지우지 않고 그 목록을 돌려준다", async () => {
		const { run, calls } = fake((words) =>
			has(words, "ls-files") ? { stdout: "node_modules/\n.env\ndata/local.db\nsrc/x.pyc\n" } : undefined,
		);
		const left = await removeRemoteWorktree(run, "wsl", REMOVE);
		expect(left).toContain("git이 무시하는 파일 2건(.env; data/local.db)");
		expect(calls).toHaveLength(1);
	});

	test("다시 만들어지는 무시 파일뿐이면 그대로 지운다", async () => {
		const { run, calls } = fake((words) =>
			has(words, "ls-files") ? { stdout: "node_modules/\npkg/dist/\n__pycache__/\n" } : undefined,
		);
		expect(await removeRemoteWorktree(run, "wsl", REMOVE)).toBeUndefined();
		expect(calls).toHaveLength(3);
	});

	test("무시 파일을 못 읽으면(ls-files 실패) 지우지 않는다", async () => {
		const { run, calls } = fake((words) =>
			has(words, "ls-files") ? { code: 128, stdout: "fatal: not a git repository" } : undefined,
		);
		expect(await removeRemoteWorktree(run, "wsl", REMOVE)).toContain("git ls-files 실패");
		expect(calls).toHaveLength(1);
	});

	test("실패한 첫 줄을 돌려주되 두 번째 명령도 돌린다", async () => {
		const { run, calls } = fake((words) =>
			has(words, "ls-files")
				? undefined
				: has(words, "worktree")
					? { code: 128, stdout: "hint: nothing\nfatal: cannot remove a locked working tree" }
					: { code: 1, stdout: "error: cannot delete branch used by worktree" },
		);
		const left = await removeRemoteWorktree(run, "wsl", REMOVE);
		expect(left).toContain("worktree 제거 실패");
		expect(left).toContain("cannot remove a locked working tree");
		expect(left).not.toContain("branch -D");
		expect(calls).toHaveLength(3);
	});

	test("ssh 255는 오류 문자열이고 다음 명령은 돌리지 않는다", async () => {
		const { run, calls } = fake(() => ({ code: 255, stderr: "ssh: connect to host wsl port 22: Connection refused" }));
		const left = await removeRemoteWorktree(run, "wsl", REMOVE);
		expect(left).toContain("원격 호스트에 닿지 못함");
		expect(calls).toHaveLength(1);
	});

	test("타임아웃도 닿지 못함이다", async () => {
		const { run } = fake(() => ({ code: null, timedOut: true }));
		expect(await removeRemoteWorktree(run, "wsl", REMOVE)).toContain("원격 호스트에 닿지 못함");
	});

	test("위험한 경로·브랜치는 아무것도 돌리지 않고 거절한다", async () => {
		for (const bad of [
			{ ...REMOVE, repo: "/home/u/work/app; rm -rf /" },
			{ ...REMOVE, worktree: "relative/path" },
			{ ...REMOVE, branch: "task/../main" },
			{ ...REMOVE, branch: "-D" },
			{ ...REMOVE, branch: "task/$(id)" },
		]) {
			const { run, calls } = fake(() => undefined);
			expect(await removeRemoteWorktree(run, "wsl", bad)).toContain("거절");
			expect(calls).toHaveLength(0);
		}
	});
});

const SYNC = {
	host: "wsl",
	repo: "/home/u/work/app",
	baseBranch: "main",
	remote: "origin",
	expectedSlug: "acme/widgets",
};
const URL = "https://github.com/acme/widgets.git";
const CHECKOUT = "/home/u/work/app";
const LIST = `worktree ${CHECKOUT}\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/u/work/app-wt/x\nHEAD def\nbranch refs/heads/task/T-20261124-13\n`;

/** The remote repository as a script: remote URL, worktree list, status and the refs `rev-parse` answers. */
function repo(over: {
	url?: string;
	list?: string;
	dirty?: string;
	refs?: Record<string, string>;
	ancestor?: number;
}): Script {
	return (words) => {
		const sub = words[3];
		if (sub === "remote") return { stdout: `${over.url ?? URL}\n` };
		if (sub === "worktree") return { stdout: over.list ?? LIST };
		if (sub === "status") return { stdout: over.dirty ?? "" };
		if (sub === "rev-parse") {
			const ref = String(words.at(-1)).replace("^{commit}", "");
			const sha = over.refs?.[ref];
			return sha === undefined ? { code: 1 } : { stdout: `${sha}\n` };
		}
		if (sub === "merge-base") return { code: over.ancestor ?? 0 };
		return undefined;
	};
}

const kinds = (calls: { words: string[] }[]) => calls.map((call) => call.words[3]);

describe("syncRemoteBase", () => {
	test("base가 체크아웃돼 있고 깨끗하면 fetch 뒤 merge --ff-only", async () => {
		const { run, calls } = fake(repo({}));
		expect(await syncRemoteBase(run, "wsl", SYNC)).toBeUndefined();
		const words = calls.map((call) => call.words);
		expect(words).toContainEqual(["git", "-C", SYNC.repo, "fetch", "origin", "main"]);
		expect(words.at(-1)).toEqual(["git", "-C", CHECKOUT, "merge", "--ff-only", "origin/main"]);
		expect(words.findIndex((entry) => entry.includes("fetch"))).toBeLessThan(words.length - 1);
	});

	test("체크아웃이 더러우면 merged-not-synced 메모만 남기고 merge는 부르지 않는다", async () => {
		const { run, calls } = fake(repo({ dirty: " M a.txt\n?? b.txt\n" }));
		const note = await syncRemoteBase(run, "wsl", SYNC);
		expect(note).toBe(`merged-not-synced: 원격 wsl ${SYNC.repo} 갱신 필요 — ${CHECKOUT}에 미커밋 변경 2건`);
		expect(calls.some((call) => call.words.includes("merge"))).toBe(false);
	});

	test("base가 체크아웃이 아니면 update-ref(옛 값 보호)로 옮긴다", async () => {
		const list = "worktree /home/u/work/app\nHEAD abc\nbranch refs/heads/develop\n";
		const refs = { "refs/heads/main": "a".repeat(40), "refs/remotes/origin/main": "b".repeat(40) };
		const { run, calls } = fake(repo({ list, refs }));
		expect(await syncRemoteBase(run, "wsl", SYNC)).toBeUndefined();
		expect(calls.at(-1)?.words).toEqual([
			"git",
			"-C",
			SYNC.repo,
			"update-ref",
			"refs/heads/main",
			"b".repeat(40),
			"a".repeat(40),
		]);
		expect(kinds(calls)).not.toContain("merge");
	});

	test("이미 같은 sha면 아무것도 옮기지 않는다(멱등)", async () => {
		const list = "worktree /home/u/work/app\nHEAD abc\nbranch refs/heads/develop\n";
		const refs = { "refs/heads/main": "c".repeat(40), "refs/remotes/origin/main": "c".repeat(40) };
		const { run, calls } = fake(repo({ list, refs }));
		expect(await syncRemoteBase(run, "wsl", SYNC)).toBeUndefined();
		expect(calls.some((call) => call.words.includes("update-ref"))).toBe(false);
	});

	test("로컬 base가 원격 추적의 조상이 아니면 옮기지 않고 메모", async () => {
		const list = "worktree /home/u/work/app\nHEAD abc\nbranch refs/heads/develop\n";
		const refs = { "refs/heads/main": "a".repeat(40), "refs/remotes/origin/main": "b".repeat(40) };
		const { run, calls } = fake(repo({ list, refs, ancestor: 1 }));
		expect(await syncRemoteBase(run, "wsl", SYNC)).toContain("조상이 아님");
		expect(calls.some((call) => call.words.includes("update-ref"))).toBe(false);
	});

	test("원격 origin이 다른 저장소면 fetch도 ff도 하지 않고 메모", async () => {
		const { run, calls } = fake(repo({ url: "git@github.com:other/thing.git" }));
		const note = await syncRemoteBase(run, "wsl", SYNC);
		expect(note).toContain("merged-not-synced: 원격 wsl");
		expect(note).toContain("other/thing");
		expect(calls).toHaveLength(1);
	});

	test("ssh가 안 되면 메모에 이유가 들어간다", async () => {
		const { run } = fake(() => ({ code: 255, stderr: "ssh: Could not resolve hostname wsl" }));
		const note = await syncRemoteBase(run, "wsl", SYNC);
		expect(note).toContain("merged-not-synced");
		expect(note).toContain("원격 호스트에 닿지 못함");
	});

	test("위험 문자는 아무것도 돌리지 않고 거절한다", async () => {
		const bad = [
			{ ...SYNC, baseBranch: "main; rm -rf /" },
			{ ...SYNC, baseBranch: "main branch" },
			{ ...SYNC, baseBranch: "ma$(id)" },
			{ ...SYNC, baseBranch: "a..b" },
			{ ...SYNC, baseBranch: "a//b" },
			{ ...SYNC, baseBranch: "main/" },
			{ ...SYNC, baseBranch: "-x" },
			{ ...SYNC, remote: "origin;id" },
			{ ...SYNC, remote: "-u" },
			{ ...SYNC, repo: "/home/u/app && id" },
			{ ...SYNC, repo: "/home/../etc" },
		];
		for (const input of bad) {
			const { run, calls } = fake(repo({}));
			expect(await syncRemoteBase(run, "wsl", input)).toContain("거절");
			expect(calls).toHaveLength(0);
		}
	});

	test("모든 원격 인자는 한 단어씩 따로 인용되어 나간다", async () => {
		const seen: string[][] = [];
		const run: ProcessRunner = async (cmd) => {
			seen.push(cmd.slice(7, -1));
			return { code: 0, stdout: `${URL}\n`, timedOut: false };
		};
		await syncRemoteBase(run, "me@host", { ...SYNC, baseBranch: "release/1.0" });
		expect(seen.length).toBeGreaterThan(0);
		for (const words of seen) for (const word of words) expect(word).toMatch(/^'.*'$/);
		expect(seen[0]).toEqual(["'git'", "'-C'", `'${SYNC.repo}'`, "'remote'", "'get-url'", "'origin'"]);
	});
});
