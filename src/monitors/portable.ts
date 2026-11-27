import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { MonitorLedger, MonitorRow } from "./ledger";
import {
	assertSafeFilesLayout,
	canTakeExport,
	clearWriteTarget,
	exportStem,
	isMonitorFile,
	isOutside,
	PortableUsageError,
	placeholderRootsOf,
	SCRIPTS_PLACEHOLDER,
	splitOption,
	underRoot,
	WORKSPACE_PLACEHOLDER,
} from "./portable-files";
import { copyPortableFiles, type PortableCopyTarget } from "./portable-io";
import { type MonitorSpec, MonitorSpecError, parseMonitorSpec, type SpecContext } from "./spec";

/**
 * Host-independent monitor files (`jabbu-pocket monitors export|apply`): one JSON file per monitor holding only the spec
 * fields, with paths under the scripts root and the workspace written as `@SCRIPTS@/…` and `@WORKSPACE@/…`, so the
 * same file applies on a home with other paths. Ids, cursors, state and timestamps stay in the database.
 */
/** A value spelled like a placeholder (`@SCRIPTS@`, `@WORKSPACE@/x`) or like one with extra leading `@`s. */
const PLACEHOLDER_LIKE = /^(@+)((?:SCRIPTS|WORKSPACE)@(?:\/.*)?)$/s;
/** The spec context of one home; export and apply need the workspace to map paths against. */
export type PortableContext = SpecContext & { workspaceDir: string };

/** The stored spec of a row without its trigger; a row whose trigger kind is no longer supported has only this. */
export function specBaseOfRow(row: MonitorRow): Omit<MonitorSpec, "trigger"> {
	return {
		name: row.name,
		instruction: row.instruction,
		overlap: row.overlap,
		enabled: row.enabled,
		...(row.channel === null ? {} : { channel: row.channel }),
		...(row.copyChannel === null ? {} : { copyChannel: row.copyChannel }),
		...(row.model === null ? {} : { model: row.model }),
		...(row.thinking === null ? {} : { thinking: row.thinking }),
		...(row.deliver === "turn" ? {} : { deliver: row.deliver }),
		...(row.procedureFiles.length === 0 ? {} : { procedureFiles: row.procedureFiles }),
	};
}

/** The stored spec of a row, in the shape `parseMonitorSpec` returns; a row of an unsupported trigger kind has none. */
export function specOfRow(row: MonitorRow): MonitorSpec {
	if (row.trigger.kind === "unsupported") throw new Error(`monitor ${row.id} has an unsupported trigger`);
	return { ...specBaseOfRow(row), trigger: row.trigger };
}

/**
 * The portable spec with a fixed key order (stable diffs). `onOutside` hears about absolute paths outside both roots,
 * which are kept as they are.
 */
function portableSpec(
	spec: MonitorSpec,
	ctx: PortableContext,
	onOutside: (path: string) => void = () => {},
): Record<string, unknown> {
	const roots = placeholderRootsOf(ctx.scriptsRoot, ctx.workspaceDir, true);
	const pathToPortable = (path: string): string => {
		if (!isAbsolute(path)) {
			// A relative value spelled like a placeholder gets one more `@`, so apply does not mistake it for one.
			return PLACEHOLDER_LIKE.test(path) ? `@${path}` : path;
		}
		const inside = underRoot(path, roots);
		if (inside === undefined) {
			onOutside(path);
			return path;
		}
		return inside.rest === "" ? inside.placeholder : `${inside.placeholder}/${inside.rest}`;
	};
	const toPortable = (value: string): string => {
		const [prefix, path] = splitOption(value);
		return `${prefix}${pathToPortable(path)}`;
	};
	// A relative procedure file is resolved against the workspace, so one that leads into the scripts dir
	// (`../scripts/steps.md`) is written as a placeholder: the target home may lay its workspace out differently.
	const toPortableProcedure = (path: string): string => {
		if (!isAbsolute(path)) {
			const inside = underRoot(resolve(ctx.workspaceDir, path), roots);
			if (inside?.placeholder === SCRIPTS_PLACEHOLDER) return pathToPortable(resolve(ctx.workspaceDir, path));
		}
		return toPortable(path);
	};
	const { trigger } = spec;
	let portableTrigger: Record<string, unknown>;
	if (trigger.kind === "cron") {
		portableTrigger = {
			kind: "cron",
			schedule: trigger.schedule,
			timezone: trigger.timezone,
			...(trigger.command === undefined ? {} : { command: trigger.command.map(toPortable) }),
			...(trigger.timeoutMs === undefined ? {} : { timeoutMs: trigger.timeoutMs }),
		};
	} else if (trigger.kind === "at") {
		portableTrigger = { kind: "at", at: trigger.at };
	} else {
		// Rows stored before fire/once/suppressUnchanged existed read as their defaults.
		portableTrigger = {
			kind: "script",
			command: trigger.command.map(toPortable),
			intervalMs: trigger.intervalMs,
			fire: trigger.fire ?? "edge",
			once: trigger.once ?? false,
			suppressUnchanged: trigger.suppressUnchanged ?? false,
		};
	}
	return {
		name: spec.name,
		trigger: portableTrigger,
		instruction: spec.instruction,
		overlap: spec.overlap,
		enabled: spec.enabled,
		...(spec.channel === undefined ? {} : { channel: spec.channel }),
		...(spec.copyChannel === undefined ? {} : { copyChannel: spec.copyChannel }),
		...(spec.model === undefined ? {} : { model: spec.model }),
		...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
		...(spec.deliver === undefined || spec.deliver === "turn" ? {} : { deliver: spec.deliver }),
		...(spec.procedureFiles === undefined ? {} : { procedureFiles: spec.procedureFiles.map(toPortableProcedure) }),
	};
}

export interface ExportResult {
	written: number;
	failed: number;
	/** Stale `*.json` files of monitors no longer in the database. */
	removed: number;
	warnings: string[];
}

/**
 * Writes `<dir>/<stem>.json` for every monitor and deletes the other `*.json` files there, so the directory mirrors
 * the database. `withFiles` also copies the referenced script and procedure files under the placeholder roots to
 * `<dir>/files/scripts/` and `<dir>/files/workspace/`, keeping their mode bits.
 */
export function exportMonitors(
	ledger: MonitorLedger,
	dir: string,
	ctx: PortableContext,
	options: { withFiles?: boolean } = {},
): ExportResult {
	try {
		mkdirSync(dir, { recursive: true });
		if (!statSync(dir).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new PortableUsageError(
			`--dir is not a directory: ${dir} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (options.withFiles) assertSafeFilesLayout(dir);
	const warnings: string[] = [];
	const claimed = new Set<string>();
	let written = 0;
	let failed = 0;
	/** Source path → where it lands, the monitor naming it first and the placeholder root it was found under. */
	const copies = new Map<string, PortableCopyTarget>();
	const roots = placeholderRootsOf(ctx.scriptsRoot, ctx.workspaceDir, true);
	const filesRoots: Record<string, string> = {
		[SCRIPTS_PLACEHOLDER]: join(dir, "files", "scripts"),
		[WORKSPACE_PLACEHOLDER]: join(dir, "files", "workspace"),
	};
	// Sorted by name so a stem collision gets the same suffix on every host whatever the creation order.
	const rows = ledger.listMonitors().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const row of rows) {
		if (row.trigger.kind === "unsupported") {
			warnings.push(`${row.name}: trigger kind "${row.trigger.was}" is no longer supported, not exported`);
			continue;
		}
		const spec = specOfRow(row);
		const portable = portableSpec(spec, ctx, (path) =>
			warnings.push(`${row.name}: path outside the scripts dir and the workspace kept as is: ${path}`),
		);
		// The `name` inside the file is what apply matches on.
		const stem = exportStem(row.name);
		let file = `${stem}.json`;
		const first = file;
		for (let n = 2; claimed.has(file) || !canTakeExport(join(dir, file)); n++) file = `${stem}-${n}.json`;
		if (file !== first && !claimed.has(first)) {
			warnings.push(`${row.name}: ${first} belongs to the owner (not a monitor file), exported as ${file}`);
		}
		claimed.add(file);
		// A file that cannot be written is a warning: the run goes on, so the stale cleanup below still happens.
		try {
			clearWriteTarget(join(dir, file));
			writeFileSync(join(dir, file), `${JSON.stringify(portable, null, 2)}\n`);
			written++;
		} catch (error) {
			failed++;
			warnings.push(`${row.name}: not written: ${file} (${error instanceof Error ? error.message : String(error)})`);
		}
		if (!options.withFiles) continue;
		const referenced = [
			...(spec.trigger.kind === "script" || spec.trigger.kind === "cron" ? (spec.trigger.command ?? []) : []).map(
				(arg) => splitOption(arg)[1],
			),
			...(spec.procedureFiles ?? []).map((path) => resolve(ctx.workspaceDir, path)),
		];
		for (const path of referenced) {
			const inside = isAbsolute(path) ? underRoot(path, roots) : undefined;
			if (inside === undefined || inside.rest === "") continue;
			const filesRoot = filesRoots[inside.placeholder] as string;
			const target = join(filesRoot, inside.rest);
			if (isOutside(relative(filesRoot, target))) {
				warnings.push(`${row.name}: referenced file would land outside ${filesRoot}, not copied: ${path}`);
				continue;
			}
			if (!copies.has(path)) copies.set(path, { target, name: row.name, root: inside.root });
		}
	}
	if (options.withFiles) copyPortableFiles({ scriptsRoot: ctx.scriptsRoot, filesRoots, copies, warnings });
	let removed = 0;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json") || claimed.has(file) || !isMonitorFile(join(dir, file))) continue;
		try {
			rmSync(join(dir, file), { force: true });
			removed++;
		} catch (error) {
			warnings.push(
				`stale monitor file not removed: ${file} (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
	return { written, failed, removed, warnings };
}

/** Some files of an `apply` directory did not validate; nothing was changed. */
export class PortableApplyError extends Error {
	constructor(readonly problems: string[]) {
		super(`${problems.length} monitor file(s) failed validation`);
		this.name = "PortableApplyError";
	}
}

export interface ApplyResult {
	added: number;
	updated: number;
	unchanged: number;
	removed: number;
	/** `*.json` entries that are not regular files and were skipped. */
	warnings: string[];
}

/** Replaces `@SCRIPTS@`/`@WORKSPACE@` in the path fields of a parsed file; anything malformed is left to validation. */
function resolvePlaceholders(input: Record<string, unknown>, ctx: PortableContext): Record<string, unknown> {
	const roots = placeholderRootsOf(ctx.scriptsRoot, ctx.workspaceDir, false);
	const pathToLocal = (value: string): string => {
		const escaped = PLACEHOLDER_LIKE.exec(value);
		// Two or more `@`s is export's escape of a literal value: drop one and leave the rest alone.
		if (escaped !== null && (escaped[1] as string).length >= 2) return value.slice(1);
		for (const { root, placeholder } of roots) {
			if (value === placeholder) return root;
			if (value.startsWith(`${placeholder}/`)) return join(root, value.slice(placeholder.length + 1));
		}
		return value;
	};
	const toLocal = (value: unknown): unknown => {
		if (typeof value !== "string") return value;
		const [prefix, path] = splitOption(value);
		return `${prefix}${pathToLocal(path)}`;
	};
	const out = { ...input };
	const trigger = input.trigger;
	if (typeof trigger === "object" && trigger !== null && !Array.isArray(trigger)) {
		const t = { ...(trigger as Record<string, unknown>) };
		if (Array.isArray(t.command)) t.command = t.command.map(toLocal);
		else if (t.command !== undefined) t.command = toLocal(t.command);
		out.trigger = t;
	}
	if (Array.isArray(input.procedureFiles)) out.procedureFiles = input.procedureFiles.map(toLocal);
	return out;
}

/**
 * Applies every `<dir>/*.json` by monitor name: a missing monitor is added, a different one updated, an equal one left
 * untouched (its `updated_at` too). With `prune`, monitors without a file are removed. Every file is validated first;
 * one failure throws `PortableApplyError` before anything changes. `dryRun` returns the counts without writing.
 */
export function applyMonitors(
	ledger: MonitorLedger,
	dir: string,
	ctx: PortableContext,
	options: { prune?: boolean; dryRun?: boolean } = {},
): ApplyResult {
	let files: string[];
	const warnings: string[] = [];
	const problems: string[] = [];
	let skipped = 0;
	try {
		files = readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.filter((file) => {
				const path = join(dir, file);
				const lstat = lstatSync(path, { throwIfNoEntry: false });
				if (lstat?.isSymbolicLink()) {
					problems.push(`${file}: symlink is not allowed`);
					return false;
				}
				// Reading a FIFO blocks forever and a directory fails the whole apply: only regular files are specs.
				const stat = statSync(path, { throwIfNoEntry: false });
				if (stat === undefined || stat.isFile()) return true;
				warnings.push(`${file}: not a regular file, skipped`);
				skipped++;
				return false;
			});
	} catch (error) {
		throw new PortableApplyError([`${dir}: ${error instanceof Error ? error.message : String(error)}`]);
	}
	const existing = new Map(ledger.listMonitors().map((row) => [row.name, row]));
	const seen = new Map<string, string>();
	const adds: MonitorSpec[] = [];
	const updates: Array<{ id: string; spec: MonitorSpec }> = [];
	let unchanged = 0;
	for (const file of files) {
		try {
			let raw: string;
			try {
				raw = readFileSync(join(dir, file), "utf8");
			} catch (error) {
				const code =
					error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
				throw new MonitorSpecError(code ? `unreadable file (${code})` : "unreadable file");
			}
			let input: unknown;
			try {
				input = JSON.parse(raw);
			} catch {
				throw new MonitorSpecError("not valid JSON");
			}
			if (typeof input !== "object" || input === null || Array.isArray(input)) {
				throw new MonitorSpecError("monitor spec must be an object");
			}
			const parsed = parseMonitorSpec(resolvePlaceholders(input as Record<string, unknown>, ctx), ctx);
			const other = seen.get(parsed.name);
			if (other !== undefined) throw new MonitorSpecError(`name "${parsed.name}" is also used by ${other}`);
			seen.set(parsed.name, file);
			const current = existing.get(parsed.name);
			if (current === undefined) {
				adds.push(parsed);
				continue;
			}
			const same =
				current.trigger.kind !== "unsupported" &&
				JSON.stringify(portableSpec(parsed, ctx)) === JSON.stringify(portableSpec(specOfRow(current), ctx));
			if (same) unchanged++;
			else updates.push({ id: current.id, spec: parsed });
		} catch (error) {
			if (!(error instanceof MonitorSpecError)) throw error;
			problems.push(`${file}: ${error.message}`);
		}
	}
	if (problems.length > 0) throw new PortableApplyError(problems);
	// A skipped entry may be the file of a monitor whose name cannot be read, so with one present nothing is pruned.
	const pruneHeld = options.prune === true && skipped > 0;
	if (pruneHeld)
		warnings.push(
			`--prune held: ${skipped} *.json entr${skipped === 1 ? "y is" : "ies are"} not regular files, no monitor removed`,
		);
	const removals = options.prune && !pruneHeld ? [...existing.values()].filter((row) => !seen.has(row.name)) : [];
	if (!options.dryRun) {
		ledger.transaction(() => {
			for (const spec of adds) ledger.addMonitor(spec);
			for (const { id, spec } of updates) ledger.updateMonitor(id, spec);
			for (const row of removals) ledger.removeMonitor(row.id);
		});
	}
	return { added: adds.length, updated: updates.length, unchanged, removed: removals.length, warnings };
}
