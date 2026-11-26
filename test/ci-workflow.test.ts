// CI 강화 계약: 워크플로가 조용히 느슨해지지 않게 YAML을 직접 읽어 확인한다.
// 러너에서 실제로 돌려 보는 대신, 고정·권한·경로 필터·설치 경로가 문서한 그대로인지 본다.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepoHygiene, MAX_BLOB_BYTES } from "../scripts/check-repo-hygiene";
import { TLC } from "../scripts/tla-check";
import { WINDOWS_SMOKE_TESTS } from "../scripts/windows-smoke-tests";

type Step = {
	id?: string;
	if?: string;
	uses?: string;
	run?: string;
	name?: string;
	shell?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
const LINUX_CORE_JOB_IDS = ["test", "test-arm64", "e2e-omp-mock", "e2e-omp-mock-arm64"] as const;
const WORKTREE_GUARDED_JOB_IDS = [...LINUX_CORE_JOB_IDS, "test-wsl", "test-windows-smoke"] as const;
const JOB_IDS = [...WORKTREE_GUARDED_JOB_IDS, "ci-required"] as const;
type JobId = (typeof JOB_IDS)[number];
type Job = {
	name?: string;
	if?: string;
	needs?: string[];
	permissions?: Record<string, string>;
	"runs-on": string;
	"timeout-minutes": number;
	steps: Step[];
};
type Workflow = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	env?: Record<string, unknown>;
	concurrency: { group: string; "cancel-in-progress": string | boolean };
	jobs: Record<JobId, Job>;
};
type OmpLatest = {
	on: { schedule: { cron: string }[]; workflow_dispatch: unknown; pull_request: { paths: string[] } };
	permissions: Record<string, string>;
	env?: Record<string, unknown>;
	jobs: Record<string, Job>;
};
type WorkflowLint = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	env?: Record<string, unknown>;
	concurrency: { group: string; "cancel-in-progress": string | boolean };
	jobs: Record<string, Job>;
};
type DependencyAudit = {
	on: { schedule: { cron: string }[]; workflow_dispatch: unknown; pull_request: { paths: string[] } };
	permissions: Record<string, string>;
	env?: Record<string, unknown>;
	concurrency: { group: string; "cancel-in-progress": string | boolean };
	jobs: Record<string, Job>;
};
type CompositeAction = {
	name: string;
	description: string;
	runs: { using: string; steps: Step[] };
};

const root = join(import.meta.dir, "..");
const readYaml = (path: string): unknown => Bun.YAML.parse(readFileSync(join(root, path), "utf8"));
const workflow = readYaml(".github/workflows/ci.yml") as Workflow;
const ompLatest = readYaml(".github/workflows/omp-latest.yml") as OmpLatest;
const workflowLint = readYaml(".github/workflows/workflow-lint.yml") as WorkflowLint;
const dependencyAudit = readYaml(".github/workflows/dependency-audit.yml") as DependencyAudit;
const dependabot = readYaml(".github/dependabot.yml") as {
	version: number;
	updates: {
		"package-ecosystem": string;
		directory: string;
		schedule: { interval: string; day?: string };
		ignore?: { "dependency-name": string; "update-types": string[] }[];
		labels?: string[];
		"open-pull-requests-limit"?: number;
	}[];
};
const setup = readYaml(".github/actions/setup/action.yml") as CompositeAction;
const cleanWorktree = readYaml(".github/actions/check-clean-worktree/action.yml") as CompositeAction;
const bunPin = (
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		packageManager: string;
		engines: { bun: string };
	}
).packageManager.replace(/^bun@/, "");
/** 40자 커밋 고정 + 같은 줄 버전 주석(`@<sha> # v1.2.3`). */
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const WORKFLOW_FILES = [
	".github/workflows/ci.yml",
	".github/workflows/omp-latest.yml",
	".github/workflows/workflow-lint.yml",
	".github/workflows/dependency-audit.yml",
] as const;
const ACTION_FILES = [".github/actions/setup/action.yml", ".github/actions/check-clean-worktree/action.yml"] as const;

describe("ci.yml", () => {
	test("main pushes are never cancelled; only a newer PR push replaces a PR run", () => {
		// 워크플로 파일에 적힌 GitHub 표현식 원문을 그대로 단언한다(`${`를 포함한 문자열이 정상이다).
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub 표현식 원문 비교
		const group = "ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}";
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub 표현식 원문 비교
		const cancel = "${{ github.event_name == 'pull_request' }}";
		expect(workflow.concurrency.group).toBe(group);
		expect(workflow.concurrency["cancel-in-progress"]).toBe(cancel);
	});

	test("the token is read-only and Node 24 JS actions are forced across workflows", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
		for (const wf of [workflow, ompLatest, workflowLint, dependencyAudit]) {
			expect(String(wf.env?.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24)).toBe("true");
		}
	});

	test("no path filter: every PR and every main push runs CI", () => {
		for (const trigger of ["push", "pull_request"] as const) {
			const config = workflow.on[trigger] as Record<string, unknown>;
			expect(config).not.toHaveProperty("paths");
			expect(config).not.toHaveProperty("paths-ignore");
		}
	});

	test.each(JOB_IDS)("job %s runs on a pinned runner image with a timeout", (job) => {
		expect(workflow.jobs[job]["runs-on"]).toMatch(/^(?:ubuntu-\d+\.\d+(?:-arm)?|windows-\d+)$/);
		expect(workflow.jobs[job]["timeout-minutes"]).toBeGreaterThan(0);
	});

	test.each([...WORKFLOW_FILES, ...ACTION_FILES])(
		"every action in %s is pinned to a 40-hex commit with its version noted",
		(file) => {
			const text = readFileSync(join(root, file), "utf8");
			const lines = text.split("\n").filter((line) => line.includes("uses: ") && !line.includes("uses: ./"));
			if (file !== ".github/actions/check-clean-worktree/action.yml") expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				const ref = line
					.replace(/#.*$/, "")
					.trim()
					.replace(/^-\s*uses:\s*|^uses:\s*/, "");
				expect(ref).toMatch(PINNED);
				expect(line).toMatch(/#\s*v[0-9]+\.[0-9]+\.[0-9]+/);
			}
		},
	);

	test("every actions/checkout step disables persist-credentials", () => {
		const workflows: Array<[string, Record<string, Job>]> = [
			["ci.yml", workflow.jobs],
			["omp-latest.yml", ompLatest.jobs],
			["workflow-lint.yml", workflowLint.jobs],
			["dependency-audit.yml", dependencyAudit.jobs],
		];
		for (const [file, jobs] of workflows) {
			for (const [jobId, job] of Object.entries(jobs)) {
				const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
				for (const step of checkouts) {
					expect(step.with?.["persist-credentials"], `${file}:${jobId}`).toBe(false);
				}
			}
		}
	});

	test("gitleaks comes only from the checksum-verifying installer, never a piped download", () => {
		for (const job of LINUX_CORE_JOB_IDS) {
			const steps = workflow.jobs[job].steps.filter((step) => step.run?.includes("gitleaks"));
			expect(steps.length).toBe(1);
			expect(steps[0]?.run).toContain('bash scripts/ci-install-gitleaks.sh "$RUNNER_TEMP/bin"');
			expect(steps[0]?.run).toContain('echo "JABBU_GITLEAKS=$RUNNER_TEMP/bin/gitleaks" >> "$GITHUB_ENV"');
		}
		const wslInstall = workflow.jobs["test-wsl"].steps.find((step) => step.run?.includes("ci-install-gitleaks.sh"));
		expect(wslInstall?.run).toContain('bash scripts/ci-install-gitleaks.sh "$HOME/.local/bin"');
		expect(wslInstall?.run).toContain('bash scripts/ci-install-bun.sh "$HOME/.local/bin"');
		for (const wf of [workflow, ompLatest, workflowLint, dependencyAudit]) {
			for (const job of Object.values(wf.jobs)) {
				for (const step of job.steps) expect(step.run ?? "").not.toContain("curl");
			}
		}
	});

	test("all CI jobs keep their structure, hygiene gate, multi-env coverage and clean-worktree guard", () => {
		expect(Object.keys(workflow.jobs)).toEqual([
			"test",
			"test-arm64",
			"e2e-omp-mock",
			"e2e-omp-mock-arm64",
			"test-wsl",
			"test-windows-smoke",
			"ci-required",
		]);
		expect(workflow.jobs["test-arm64"]["runs-on"]).toBe("ubuntu-24.04-arm");
		expect(workflow.jobs.test["runs-on"]).toBe("ubuntu-24.04");
		expect(workflow.jobs["e2e-omp-mock"]["runs-on"]).toBe("ubuntu-24.04");
		expect(workflow.jobs["e2e-omp-mock-arm64"]["runs-on"]).toBe("ubuntu-24.04-arm");
		expect(workflow.jobs["test-wsl"]["runs-on"]).toBe("windows-2025");
		expect(workflow.jobs["test-windows-smoke"]["runs-on"]).toBe("windows-2025");
		expect(workflow.jobs["ci-required"]["runs-on"]).toBe("ubuntu-24.04");
		expect(workflow.jobs.test.steps.map((step) => step.run ?? step.uses)).toEqual([
			expect.stringContaining("actions/checkout@"),
			"./.github/actions/setup",
			expect.stringContaining("ci-install-gitleaks.sh"),
			"bun run check",
			"bun run knip",
			"bun scripts/check-repo-hygiene.ts",
			"bun test --parallel=3",
			expect.stringContaining("actions/setup-java@"),
			expect.stringContaining("actions/cache/restore@"),
			"bun scripts/tla-check.ts --strict",
			expect.stringContaining("actions/cache/save@"),
			"./.github/actions/check-clean-worktree",
		]);
		expect(workflow.jobs["test-arm64"].steps).toEqual([
			...workflow.jobs.test.steps.slice(0, 7),
			workflow.jobs.test.steps.at(-1) as Step,
		]);
		expect(workflow.jobs["e2e-omp-mock-arm64"].steps).toEqual(workflow.jobs["e2e-omp-mock"].steps);

		const wslSteps = workflow.jobs["test-wsl"].steps;
		const setupWsl = wslSteps.find((step) => step.uses?.startsWith("Vampire/setup-wsl@"));
		expect(setupWsl?.with).toMatchObject({
			distribution: "Ubuntu-24.04",
			"wsl-version": "2",
			"use-cache": "false",
			"wsl-shell-user": "runner",
		});
		expect(String(setupWsl?.with?.["wsl-conf"])).toContain("systemd=true");
		const wslRuns = wslSteps.map((step) => step.run ?? "");
		expect(wslRuns.some((run) => run.includes("ci-install-bun.sh"))).toBe(true);
		expect(wslRuns.some((run) => run.includes("ci-install-gitleaks.sh"))).toBe(true);
		for (const cmd of ["bun run check", "bun run knip", "bun scripts/check-repo-hygiene.ts", "bun test --parallel=3"]) {
			expect(wslRuns.some((run) => run.includes(cmd))).toBe(true);
		}

		expect(workflow.jobs["test-windows-smoke"].steps.map((step) => step.run ?? step.uses)).toEqual([
			expect.stringContaining("actions/checkout@"),
			"./.github/actions/setup",
			"bun run check",
			"bun run knip",
			"bun scripts/check-repo-hygiene.ts",
			"bun scripts/windows-smoke-tests.ts",
			"./.github/actions/check-clean-worktree",
		]);

		for (const job of WORKTREE_GUARDED_JOB_IDS) {
			const clean = workflow.jobs[job].steps.at(-1);
			expect(clean?.uses).toBe("./.github/actions/check-clean-worktree");
			expect(clean?.if).toBe("always() && !cancelled()");
		}
		const required = workflow.jobs["ci-required"];
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub 표현식 원문 비교
		expect(required.if).toBe("${{ always() }}");
		expect(required.needs).toEqual(["test", "e2e-omp-mock"]);
		expect(required.steps[0]?.run).toContain('test "$TEST_RESULT" = success');
		expect(required.steps[0]?.run).toContain('test "$E2E_RESULT" = success');
	});

	test("the test job installs temurin 21, runs TLA+ strictly, and caches tla2tools with main-only save", () => {
		const steps = workflow.jobs.test.steps;
		const java = steps.find((step) => step.uses?.startsWith("actions/setup-java@"));
		expect(java?.with).toEqual({ distribution: "temurin", "java-version": "21" });
		const check = steps.findIndex((step) => step.run === "bun scripts/tla-check.ts --strict");
		expect(check).toBeGreaterThan(steps.indexOf(java as Step));
		const restore = steps[check - 1];
		expect(restore?.uses).toContain("actions/cache/restore@");
		expect(restore?.id).toBe("tla-cache");
		expect(restore?.with?.path).toBe(`~/.cache/jabbu-pocket/tla2tools-${TLC.tag}.jar`);
		expect(restore?.with?.key).toBe(`tla2tools-${TLC.tag}-${TLC.sha256}`);
		const save = steps[check + 1];
		expect(save?.uses).toContain("actions/cache/save@");
		expect(save?.if).toContain("refs/heads/main");
		expect(save?.if).toContain("pull_request");
		expect(save?.if).toContain("tla-cache.outputs.cache-hit != 'true'");
		for (const job of ["test-arm64", "e2e-omp-mock", "e2e-omp-mock-arm64", "test-wsl", "test-windows-smoke"] as const)
			expect(workflow.jobs[job].steps.some((step) => step.run?.includes("tla-check"))).toBe(false);
	});

	test("e2e-omp-mock restores omp-host cache, saves only on main, and never sets --omp-only", () => {
		const text = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
		expect(text).not.toContain("JABBU_OMP_EXPECT_VERSION");
		expect(text).not.toContain("--omp-only");
		const steps = workflow.jobs["e2e-omp-mock"].steps;
		const restore = steps.find((step) => step.uses?.includes("actions/cache/restore@"));
		const save = steps.find((step) => step.uses?.includes("actions/cache/save@"));
		expect(restore?.id).toBe("omp-host-cache");
		expect(restore?.with?.path).toBe("~/.cache/jabbu-omp-host-bun");
		expect(String(restore?.with?.key)).toContain("hashFiles('test/fixtures/omp-host/bun.lock')");
		expect(save?.if).toContain("refs/heads/main");
		expect(save?.if).toContain("omp-host-cache.outputs.cache-hit != 'true'");
	});

	test("every setup-action job installs dependencies through the shared setup action", () => {
		for (const job of ["test", "test-arm64", "e2e-omp-mock", "e2e-omp-mock-arm64", "test-windows-smoke"] as const)
			expect(workflow.jobs[job].steps.some((step) => step.uses === "./.github/actions/setup")).toBe(true);
	});

	test("ci-install-bun.sh pins the same Bun version as package.json", () => {
		const installer = readFileSync(join(root, "scripts/ci-install-bun.sh"), "utf8");
		expect(installer).toContain(`VERSION=${bunPin}\n`);
	});

	test("WINDOWS_SMOKE_TESTS is non-empty, sorted, deduplicated, and points to existing test files", () => {
		expect(WINDOWS_SMOKE_TESTS.length).toBeGreaterThan(0);
		expect([...WINDOWS_SMOKE_TESTS]).toEqual([...WINDOWS_SMOKE_TESTS].sort());
		expect(new Set(WINDOWS_SMOKE_TESTS).size).toBe(WINDOWS_SMOKE_TESTS.length);
		for (const file of WINDOWS_SMOKE_TESTS) {
			expect(file).toMatch(/^test\/.*\.test\.ts$/);
			expect(existsSync(join(root, file)), file).toBe(true);
		}
	});

	test("the e2e-omp-mock job checks its fixtures before running the real omp e2e", () => {
		const runs = workflow.jobs["e2e-omp-mock"].steps.map((step) => step.run ?? "").filter((run) => run !== "");
		const check = runs.findIndex((run) => run.includes("bun src/dev/check-test-fixtures.ts"));
		const e2e = runs.findIndex((run) => run.includes("test/omp-mock.e2e.test.ts"));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(e2e);
		const e2eStep = workflow.jobs["e2e-omp-mock"].steps.find((step) => step.run?.includes("test/omp-mock.e2e.test.ts"));
		expect(e2eStep?.env).toEqual({ JABBU_E2E_OMP_MOCK: "1" });
	});
});

describe("omp-latest.yml", () => {
	const job = ompLatest.jobs["omp-latest"] as Job;
	const stepRun = (needle: string) => job.steps.find((step) => step.run?.includes(needle));

	test("runs daily, on demand and on PRs touching only its own inputs", () => {
		expect(ompLatest.on.schedule).toEqual([{ cron: "30 18 * * *" }]);
		expect(ompLatest.on).toHaveProperty("workflow_dispatch");
		expect(ompLatest.on.pull_request.paths.sort()).toEqual(
			[
				".github/workflows/omp-latest.yml",
				"src/dev/check-test-fixtures.ts",
				"test/fixtures/omp-host/**",
				"test/omp-mock.e2e.test.ts",
				"test/omp-unanswered-tool-call.test.ts",
			].sort(),
		);
		expect(Object.keys(ompLatest.on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
	});

	test("one read-only job with a fork schedule guard, timeout and the shared setup action", () => {
		expect(ompLatest.permissions).toEqual({ contents: "read" });
		expect(Object.keys(ompLatest.jobs)).toEqual(["omp-latest"]);
		expect(job.if).toBe("github.event_name != 'schedule' || github.repository == 'gimso2x/jabbu-pocket'");
		expect(job["runs-on"]).toBe("ubuntu-24.04");
		expect(job["timeout-minutes"]).toBeGreaterThan(0);
		expect(job.steps.some((step) => step.uses === "./.github/actions/setup")).toBe(true);
	});

	test("resolves the npm latest as an exact x.y.z without curl and installs only that version outside the fixture", () => {
		const resolve = stepRun("npm view");
		expect(resolve?.run).toContain("@oh-my-pi/pi-coding-agent");
		expect(resolve?.run).toContain("JABBU_OMP_EXPECT_VERSION");
		expect(resolve?.run).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
		const install = stepRun("JABBU_OMP_EXECUTABLE");
		expect(install?.run).toContain("@oh-my-pi/pi-coding-agent@$JABBU_OMP_EXPECT_VERSION");
		expect(install?.run).toContain("$RUNNER_TEMP");
		expect(install?.run).not.toContain("test/fixtures/omp-host");
		for (const step of job.steps) expect(step.run ?? "").not.toContain("curl");
	});

	test("checks the expected version, then runs exactly the two mock e2e files and fails on any skip", () => {
		const runs = job.steps.map((step) => step.run ?? "");
		const check = runs.findIndex((run) => run.includes("bun src/dev/check-test-fixtures.ts --omp-only"));
		const e2e = runs.findIndex((run) => run.includes("test/omp-mock.e2e.test.ts"));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(e2e);
		const step = job.steps[e2e];
		expect(step?.env).toEqual({ JABBU_E2E_OMP_MOCK: "1" });
		expect(step?.run).toContain("bun test test/omp-mock.e2e.test.ts test/omp-unanswered-tool-call.test.ts");
		expect(step?.run).not.toContain("omp-rpc.contract");
		expect(step?.run).toContain("set -o pipefail");
		expect(step?.run).toContain("[1-9][0-9]* pass$");
		expect(step?.run).toContain("[0-9]+ skip$");
		expect(runs.some((run) => run.includes("gitleaks"))).toBe(false);
	});
});

describe("workflow-lint.yml", () => {
	test("restricts workflow permissions and configures zizmor and actionlint", () => {
		expect(workflowLint.permissions).toEqual({});
		expect(Object.keys(workflowLint.jobs)).toEqual(["zizmor", "actionlint"]);
		const zizmorJob = workflowLint.jobs.zizmor as Job;
		expect(zizmorJob.permissions).toEqual({ contents: "read" });
		const zizmorStep = zizmorJob.steps.find((step) => step.uses?.startsWith("zizmorcore/zizmor-action@"));
		expect(zizmorStep?.with).toEqual({
			inputs: ".github",
			"advanced-security": false,
			annotations: true,
			"min-confidence": "high",
			"min-severity": "high",
		});
		const actionlintJob = workflowLint.jobs.actionlint as Job;
		expect(actionlintJob.permissions).toEqual({ contents: "read" });
		const runs = actionlintJob.steps.map((step) => step.run ?? "");
		expect(runs.some((run) => run.includes('bash scripts/ci-install-actionlint.sh "$RUNNER_TEMP/bin"'))).toBe(true);
		expect(runs.some((run) => run.includes("awk"))).toBe(true);
		expect(runs.some((run) => run.includes('"$RUNNER_TEMP/bin/actionlint"'))).toBe(true);
	});
});

describe("dependency-audit.yml", () => {
	test("audits root production and dev dependencies daily with a fork schedule guard", () => {
		expect(dependencyAudit.permissions).toEqual({ contents: "read" });
		expect(dependencyAudit.on.schedule).toEqual([{ cron: "23 22 * * *" }]);
		expect(dependencyAudit.on.pull_request.paths).toEqual([".github/workflows/dependency-audit.yml"]);
		const auditJob = dependencyAudit.jobs.audit as Job;
		expect(auditJob.if).toBe("github.event_name != 'schedule' || github.repository == 'gimso2x/jabbu-pocket'");
		expect(auditJob["runs-on"]).toBe("ubuntu-24.04");
		expect(auditJob["timeout-minutes"]).toBeGreaterThan(0);
		const bunStep = auditJob.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
		expect(bunStep?.with?.["bun-version-file"]).toBe("package.json");
		expect(auditJob.steps.some((step) => step.run === "bun audit --audit-level=high")).toBe(true);
	});
});

describe("dependabot.yml", () => {
	const find = (ecosystem: string, directory: string) =>
		dependabot.updates.find((u) => u["package-ecosystem"] === ecosystem && u.directory === directory);

	test("github-actions and bun directories are all declared weekly on Monday", () => {
		expect(dependabot.version).toBe(2);
		const keys = dependabot.updates.map((u) => `${u["package-ecosystem"]} ${u.directory}`).sort();
		expect(keys).toEqual(
			["bun /", "bun /test/fixtures/omp-host", "github-actions /", "github-actions /.github/actions/setup"].sort(),
		);
		for (const update of dependabot.updates) {
			expect(update.schedule).toEqual({ interval: "weekly", day: "monday" });
			expect(update["open-pull-requests-limit"]).toBe(5);
			expect(update).not.toHaveProperty("labels");
		}
	});

	test("bun updates skip semver-major", () => {
		for (const directory of ["/", "/test/fixtures/omp-host"])
			expect(find("bun", directory)?.ignore).toEqual([
				{ "dependency-name": "*", "update-types": ["version-update:semver-major"] },
			]);
	});
});

describe("setup action", () => {
	test("reads the Bun version from package.json where packageManager is pinned", () => {
		expect(setup.name.length).toBeGreaterThan(0);
		expect(setup.description.length).toBeGreaterThan(0);
		expect(setup.runs.using).toBe("composite");
		expect(bunPin).toMatch(/^\d+\.\d+\.\d+$/);
		expect(setup.runs.steps[0]?.uses).toContain("setup-bun@");
		expect(setup.runs.steps[0]?.with?.["bun-version-file"]).toBe("package.json");
	});

	test("the cache key carries runner.arch so x64 and arm64 native packages never share a cache", () => {
		expect(String(setup.runs.steps[1]?.with?.key)).toContain("runner.arch");
	});

	test("restores cache with restore-keys, retries install on cache corruption, and saves only on main", () => {
		const restore = setup.runs.steps[1];
		expect(restore?.id).toBe("bun-cache");
		expect(restore?.uses).toContain("actions/cache/restore@");
		expect(restore?.with?.path).toBe("~/.bun/install/cache");
		expect(String(restore?.with?.key)).toContain("hashFiles('bun.lock')");
		expect(String(restore?.with?.key)).toContain("-bun-root-");
		expect(String(restore?.with?.["restore-keys"])).toContain("runner.arch");
		expect(String(restore?.with?.["restore-keys"])).toContain("-bun-root-");

		const install = setup.runs.steps[2];
		expect(install?.shell).toBe("bash");
		expect(install?.run).toContain("bun install --frozen-lockfile");
		expect(install?.run).toContain("--cache-dir=");

		const save = setup.runs.steps[3];
		expect(save?.uses).toContain("actions/cache/save@");
		expect(save?.if).toContain("refs/heads/main");
		expect(save?.if).toContain("pull_request");
		expect(save?.if).toContain("bun-cache.outputs.cache-hit != 'true'");
		expect(save?.with?.path).toBe("~/.bun/install/cache");
	});
});

describe("check-clean-worktree action", () => {
	test("checks tracked and untracked files via git status --porcelain=v1", () => {
		expect(cleanWorktree.name).toBe("check-clean-worktree");
		expect(cleanWorktree.runs.using).toBe("composite");
		const step = cleanWorktree.runs.steps[0];
		expect(step?.shell).toBe("bash");
		expect(step?.run).toContain("git -C");
		expect(step?.run).toContain("status --porcelain=v1 --untracked-files=normal");
	});
});

describe("scripts/check-repo-hygiene.ts", () => {
	test("flags oversized blobs and conflict markers while allowing allowlisted blobs and binary NUL files", () => {
		const dir = mkdtempSync(join(tmpdir(), "jabbu-hygiene-"));
		try {
			writeFileSync(join(dir, "ok.txt"), "clean line\n");
			writeFileSync(join(dir, "big.txt"), "a".repeat(200));
			const markers = ["<".repeat(7), "=".repeat(7), ">".repeat(7)];
			writeFileSync(join(dir, "conflict.txt"), `ok\n${markers[0]} HEAD\n${markers[1]}\n${markers[2]} main\n`);
			writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 1, 2, ...Buffer.from(`\n${markers[0]}\n`)]));

			expect(MAX_BLOB_BYTES).toBe(512_000);
			expect(checkRepoHygiene(dir, ["ok.txt"])).toEqual([]);

			const hits = checkRepoHygiene(dir, ["ok.txt", "big.txt", "conflict.txt", "binary.bin"], { maxBytes: 100 });
			expect(hits).toEqual([
				"blob-size: big.txt (200B > 100B)",
				"conflict-marker: conflict.txt:2",
				"conflict-marker: conflict.txt:3",
				"conflict-marker: conflict.txt:4",
			]);

			const allowlisted = checkRepoHygiene(dir, ["big.txt"], {
				maxBytes: 100,
				allowLarge: new Set(["big.txt"]),
			});
			expect(allowlisted).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("repository paths the CI files point at", () => {
	test("every scripts/, test/, src/ and .github/ path in the workflows, actions and PR template exists", () => {
		const files = [...WORKFLOW_FILES, ...ACTION_FILES, ".github/pull_request_template.md"];
		const missing: string[] = [];
		for (const file of files) {
			const text = readFileSync(join(root, file), "utf8");
			for (const token of text.match(/(?<![\w./-])(?:scripts|test|src|\.github)\/[\w./-]*[\w-]/g) ?? [])
				if (!existsSync(join(root, token))) missing.push(`${file}: ${token}`);
		}
		expect(missing).toEqual([]);
	});
});
