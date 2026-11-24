// CI 강화 계약: 워크플로가 조용히 느슨해지지 않게 YAML을 직접 읽어 확인한다.
// 러너에서 실제로 돌려 보는 대신, 고정·권한·경로 필터·설치 경로가 문서한 그대로인지 본다.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
	uses?: string;
	run?: string;
	name?: string;
	shell?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
};
const JOB_IDS = ["test", "e2e-omp-mock"] as const;
type JobId = (typeof JOB_IDS)[number];
type Workflow = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": string | boolean };
	jobs: Record<JobId, { "runs-on": string; "timeout-minutes": number; steps: Step[] }>;
};

const root = join(import.meta.dir, "..");
const readYaml = (path: string): unknown => Bun.YAML.parse(readFileSync(join(root, path), "utf8"));
const workflow = readYaml(".github/workflows/ci.yml") as Workflow;
const setup = readYaml(".github/actions/setup/action.yml") as {
	name: string;
	description: string;
	runs: { using: string; steps: Step[] };
};
const bunPin = (
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		packageManager: string;
		engines: { bun: string };
	}
).packageManager.replace(/^bun@/, "");
/** 40자 커밋 고정 + 같은 줄 버전 주석(`@<sha> # v1.2.3`). */
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

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

	test("the token is read-only", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
	});

	test("no path filter: every PR and every main push runs CI", () => {
		for (const trigger of ["push", "pull_request"] as const) {
			const config = workflow.on[trigger] as Record<string, unknown>;
			expect(config).not.toHaveProperty("paths");
			expect(config).not.toHaveProperty("paths-ignore");
		}
	});

	test.each(JOB_IDS)("job %s runs on a pinned runner image with a timeout", (job) => {
		expect(workflow.jobs[job]["runs-on"]).toMatch(/^ubuntu-\d+\.\d+$/);
		expect(workflow.jobs[job]["timeout-minutes"]).toBeGreaterThan(0);
	});

	test.each([".github/workflows/ci.yml", ".github/actions/setup/action.yml"])(
		"every action in %s is pinned to a 40-hex commit with its version noted",
		(file) => {
			const text = readFileSync(join(root, file), "utf8");
			const lines = text.split("\n").filter((line) => line.includes("uses: ") && !line.includes("uses: ./"));
			expect(lines.length).toBeGreaterThan(0);
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

	test("gitleaks comes only from the checksum-verifying installer, never a piped download", () => {
		for (const job of JOB_IDS) {
			const steps = workflow.jobs[job].steps.filter((step) => step.run?.includes("gitleaks"));
			expect(steps.length).toBe(1);
			expect(steps[0]?.run).toContain('bash scripts/ci-install-gitleaks.sh "$RUNNER_TEMP/bin"');
			expect(steps[0]?.run).toContain('echo "OMPBOT_GITLEAKS=$RUNNER_TEMP/bin/gitleaks" >> "$GITHUB_ENV"');
		}
		for (const job of JOB_IDS)
			for (const step of workflow.jobs[job].steps) expect(step.run ?? "").not.toContain("curl");
	});

	test("both jobs install dependencies through the shared setup action", () => {
		for (const job of JOB_IDS)
			expect(workflow.jobs[job].steps.some((step) => step.uses === "./.github/actions/setup")).toBe(true);
	});

	test("the e2e-omp-mock job checks its fixtures before running the real omp e2e", () => {
		const runs = workflow.jobs["e2e-omp-mock"].steps.map((step) => step.run ?? "").filter((run) => run !== "");
		const check = runs.findIndex((run) => run.includes("bun src/dev/check-test-fixtures.ts"));
		const e2e = runs.findIndex((run) => run.includes("test/omp-mock.e2e.test.ts"));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(e2e);
		const e2eStep = workflow.jobs["e2e-omp-mock"].steps.find((step) => step.run?.includes("test/omp-mock.e2e.test.ts"));
		expect(e2eStep?.env).toEqual({ OMPBOT_E2E_OMP_MOCK: "1" });
	});
});

describe("setup action", () => {
	test("installs the Bun version package.json declares", () => {
		expect(setup.name.length).toBeGreaterThan(0);
		expect(setup.description.length).toBeGreaterThan(0);
		expect(setup.runs.using).toBe("composite");
		expect(setup.runs.steps[0]?.uses).toContain("setup-bun@");
		expect(setup.runs.steps[0]?.with?.["bun-version"]).toBe(bunPin);
	});

	test("caches the Bun install cache keyed on both lockfiles and installs frozen", () => {
		const cache = setup.runs.steps[1];
		expect(cache?.uses).toContain("actions/cache@");
		expect(cache?.with?.path).toBe("~/.bun/install/cache");
		expect(cache?.with?.key).toContain("hashFiles('bun.lock', 'test/fixtures/omp-host/bun.lock')");
		const last = setup.runs.steps.at(-1);
		expect(last?.run).toBe("bun install --frozen-lockfile");
		expect(last?.shell).toBe("bash");
	});
});

describe("repository paths the CI files point at", () => {
	test("every scripts/, test/, src/ and .github/ path in ci.yml, the setup action and the PR template exists", () => {
		const files = [".github/workflows/ci.yml", ".github/actions/setup/action.yml", ".github/pull_request_template.md"];
		const missing: string[] = [];
		for (const file of files) {
			const text = readFileSync(join(root, file), "utf8");
			for (const token of text.match(/(?<![\w./-])(?:scripts|test|src|\.github)\/[\w./-]*[\w-]/g) ?? [])
				if (!existsSync(join(root, token))) missing.push(`${file}: ${token}`);
		}
		expect(missing).toEqual([]);
	});
});
