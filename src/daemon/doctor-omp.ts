// The `omp` probes doctor runs (`models --json`, the judge role): split out of `doctor.ts` to keep that
// file within its size ratchet. A probe runs `omp` with the env the RPC driver gives it, under a time limit.
import { readFileSync } from "node:fs";
import { buildChildEnv, withOmpProfile } from "../omp/env";

/** What a short `omp` probe printed, or why it could not be read (spawn error, time limit, unreadable stdout). */
type OmpProbe = { out: string; code: number } | { failure: string };

/**
 * Runs `omp <args>` with the env the RPC driver gives omp, under a time limit. The child gets its own process group:
 * a launcher's grandchild holding stdout open would keep the read waiting past the limit, so the whole group is killed.
 */
async function probeOmp(
	ompExecutable: string,
	args: string[],
	timeoutMs: number,
	ompProfile: string | undefined,
	base: Record<string, string | undefined>,
): Promise<OmpProbe> {
	let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
	try {
		proc = Bun.spawn([ompExecutable, ...args], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			detached: true,
			env: withOmpProfile(buildChildEnv({}, base), ompProfile),
		});
	} catch (error) {
		return { failure: `cannot run ${ompExecutable} (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const result = await Promise.race([Promise.all([new Response(proc.stdout).text(), proc.exited]), timedOut]);
		if (result === "timeout") {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// ESRCH: the group is already gone
			}
			await proc.exited;
			return { failure: `timeout after ${timeoutMs / 1000}s` };
		}
		return { out: result[0], code: result[1] };
	} catch {
		return { failure: "unparsable output" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The chat models `omp models --json` lists, as `provider/id` (or the bare `id` when the entry names no provider),
 * run with the env the RPC driver gives omp. Zero means no provider login and no API key: every turn would fail
 * with "No default model selected", so doctor says so before the first DM. A string is why the list could not be
 * read (timeout, exit code, unparsable output).
 */
export async function listOmpModels(
	ompExecutable: string,
	timeoutMs = 30_000,
	/** Config `ompProfile`: the bot profile's models and login (`withOmpProfile`). */
	ompProfile?: string,
	base: Record<string, string | undefined> = process.env,
): Promise<string[] | string> {
	const probe = await probeOmp(ompExecutable, ["models", "--json"], timeoutMs, ompProfile, base);
	if ("failure" in probe) return probe.failure;
	if (probe.code !== 0) return `omp models exited ${probe.code}`;
	try {
		const parsed = JSON.parse(probe.out) as { models?: unknown };
		if (!Array.isArray(parsed.models)) return "unparsable output";
		const ids: string[] = [];
		for (const entry of parsed.models) {
			const id = modelIdOf(entry);
			if (id === undefined) return "unparsable output";
			ids.push(id);
		}
		return ids;
	} catch {
		return "unparsable output";
	}
}

/** `provider/id` of one `models --json` entry, or `undefined` when it names no usable id. */
function modelIdOf(entry: unknown): string | undefined {
	const model = entry as { id?: unknown; provider?: unknown };
	if (typeof model !== "object" || model === null || typeof model.id !== "string" || model.id === "") return undefined;
	return typeof model.provider === "string" && model.provider !== "" ? `${model.provider}/${model.id}` : model.id;
}

/** How many chat models `omp models --json` lists (see `listOmpModels`). */
export async function countOmpModels(
	ompExecutable: string,
	timeoutMs = 30_000,
	ompProfile?: string,
	base: Record<string, string | undefined> = process.env,
): Promise<number | string> {
	const models = await listOmpModels(ompExecutable, timeoutMs, ompProfile, base);
	return typeof models === "string" ? models : models.length;
}

/** The result of the judge-role probe: what the role resolves to, or why the role could not be read. */
export type JudgeRole = { model: string } | { unreadable: string } | { missing: true };

/**
 * `modelRoles.judge` as `omp --config <overlay> config list --json` resolves it. A read-only probe: no model is chosen
 * and no call is made (the source's rule: recommend the role, never pick or call a model). A config list that does not
 * come back (exit code, timeout, unparsable output) is `unreadable` — a missing role and an unreadable answer are
 * different lines in the report, since only the first is the owner's to set. Without an overlay the bot omp reads its
 * own global config, which is not this install's judge, so that case is `unreadable` too. A missing probe answer is
 * cross-checked against the overlay file itself (qa-z #9 — the children run with `--config <overlay>`).
 */
export async function readJudgeRole(
	ompExecutable: string,
	overlayConfig: string | undefined,
	timeoutMs = 30_000,
	ompProfile?: string,
	base: Record<string, string | undefined> = process.env,
): Promise<JudgeRole> {
	if (overlayConfig === undefined) return { unreadable: "no ompConfigOverlay for this install" };
	const args = ["--config", overlayConfig, "config", "list", "--json"];
	const probe = await probeOmp(ompExecutable, args, timeoutMs, ompProfile, base);
	if ("failure" in probe) return { unreadable: probe.failure };
	if (probe.code !== 0) return { unreadable: `omp config list exited ${probe.code}` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(probe.out);
	} catch {
		return { unreadable: "unparsable output" };
	}
	if (typeof parsed !== "object" || parsed === null) return { unreadable: "unparsable output" };
	const roles = (parsed as { modelRoles?: { value?: unknown } }).modelRoles?.value;
	// No role storage at all reads as an unset role: omp keeps roles inside `modelRoles`, and an overlay that sets
	// none leaves the global ones in place — so what is read here is the effective value.
	const judge = typeof roles === "object" && roles !== null ? (roles as Record<string, unknown>).judge : undefined;
	if (typeof judge === "string" && judge.trim() !== "") return { model: judge };
	// qa-z #9: the probe does not always merge the overlay — the file itself is checked as the effective role.
	const fromOverlay = overlayJudgeRole(overlayConfig);
	return fromOverlay === undefined ? { missing: true } : { model: fromOverlay };
}

/** A YAML value as a mapping, or undefined for anything else (a list, a scalar, null). */
const mappingOf = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** `modelRoles.judge` straight from the overlay file (qa-z #9), or undefined when the file sets none or is unreadable. */
function overlayJudgeRole(overlayConfig: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(readFileSync(overlayConfig, "utf8"));
	} catch {
		return undefined;
	}
	const judge = mappingOf(mappingOf(parsed)?.modelRoles)?.judge;
	return typeof judge === "string" && judge.trim() !== "" ? judge : undefined;
}
