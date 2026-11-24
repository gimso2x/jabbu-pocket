import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBotStore } from "../src/core/origin";
import { taskOriginKey } from "../src/lanes/status";
import { makeHome, OWNER, OWNER_DM, type TestHome } from "./helpers/bot-home";
import { killSpawned, spawnDaemon } from "./helpers/daemon-process";

/**
 * AC-3 on the real process: a bot whose `agent` is "agy" still runs a [TASK] worker origin's turn through the omp
 * `--mode rpc` child. The fake omp executable records its argv, env and cwd; the fake agy records any call that is
 * not a version probe. The task row and its pending start row are seeded before the daemon starts, so the daemon's
 * own boot dispatch builds the child through `run.ts` `driverFactory`.
 */
const WORKER_MODEL = "zai/glm-5.4-flash";

let home: TestHome | undefined;

afterEach(() => {
	killSpawned();
	home?.remove();
	home = undefined;
});

/** `#!/bin/sh` script answering the version probe like the real CLI and appending `record` for anything else. */
const probeScript = (versionLine: string, record: string): string =>
	`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; exit 0; fi\n${record}\nexit 0\n`;

describe("a [TASK] worker origin of a daemon whose bot agent is agy", () => {
	test("AC-3: its child is omp --mode rpc (no rpc-ui dialogs) in the task worktree with the worker model, the floors prompt and OMP_WIKI_NOTE_DISABLE=1; agy never runs", async () => {
		home = makeHome("jabbu-task-spawn-");
		const rec = join(home.dir, "rec");
		mkdirSync(rec);
		writeFileSync(
			home.config.ompExecutable,
			probeScript(
				"omp/0.0.0-stub",
				`printf '%s\\0' "$@" > "${rec}/omp-argv"\npwd -P > "${rec}/omp-cwd"\nenv > "${rec}/omp-env"`,
			),
			{ mode: 0o755 },
		);
		const agy = join(home.dir, "fake-agy");
		writeFileSync(agy, probeScript("agy 0.0.0-stub", `echo "$@" >> "${rec}/agy-calls"`), { mode: 0o755 });
		const configText = JSON.parse(readFileSync(home.config.configPath, "utf8")) as Record<string, unknown>;
		writeFileSync(
			home.config.configPath,
			JSON.stringify({
				...configText,
				agent: "agy",
				agyExecutable: agy,
				channels: {
					discord: {
						ownerUserId: OWNER,
						botTokenFile: "secrets/discord-bot-token",
						applicationId: "600000000000000000",
					},
				},
			}),
			{ mode: 0o600 },
		);

		// The ledger a previous run left: one headless task on the worker model and its start row waiting on the task origin.
		const store = openBotStore(join(home.dir, "jabbu.db"), { now: Date.now }, "Asia/Seoul");
		const row = store.tasks.register({
			title: "헤드리스 워커",
			risk: "L1",
			originKey: `discord/dm/${OWNER_DM}`,
			threadRef: `${OWNER_DM}:400000000000000001`,
			host: null,
			repo: join(home.dir, "repo"),
			acceptance: [{ id: "AC-1", text: "하나" }],
			worker: { tier: "low", tierReason: "test", model: WORKER_MODEL },
			runtime: "headless",
		});
		const origin = taskOriginKey(row.agent);
		store.ensureOrigin(origin, join(home.dir, "sessions", "task-origin"));
		store.recordInbound({
			originKey: origin,
			platformMessageId: `task:${row.agent}:start:seed`,
			textRef: "시작",
			threadRef: `task:${row.taskId}`,
		});
		store.close();

		const daemon = spawnDaemon(home.dir, join(home.dir, "transport.jsonl"));
		await daemon.waitLog(/event=daemon_ready/);
		// The fake child exits without a ready frame: the boot dispatch fails once its argv is on disk.
		await daemon.waitLog(new RegExp(`event=dispatch_failed origin=${origin} .*omp exited \\(code 0\\) before ready`));

		const argv = readFileSync(join(rec, "omp-argv"), "utf8").split("\0").slice(0, -1);
		expect(argv[argv.indexOf("--mode") + 1]).toBe("rpc");
		expect(argv).not.toContain("rpc-ui");
		expect(argv[argv.indexOf("--model") + 1]).toBe(WORKER_MODEL);
		expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("# jabbu 워커 안내");
		expect(argv[argv.indexOf("--session-dir") + 1]).toStartWith(join(home.dir, "sessions"));
		expect(readFileSync(join(rec, "omp-cwd"), "utf8").trim()).toBe(realpathSync(row.worktree));
		expect(readFileSync(join(rec, "omp-env"), "utf8").split("\n")).toContain("OMP_WIKI_NOTE_DISABLE=1");
		expect(existsSync(join(rec, "agy-calls"))).toBe(false);
	});
});
