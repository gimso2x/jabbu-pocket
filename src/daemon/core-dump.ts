// The `core dump limit` doctor check: a daemon unit without `LimitCORE=0` would let a crashing daemon dump its
// memory, secrets included, into a core file. Bun cannot lower `RLIMIT_CORE` itself, so the unit template carries it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The last `LimitCORE=` value in a unit or drop-in file, or `undefined` when the file could not be judged (then one
 * warn line names it): qa-z #60 — a FIFO in a unit's place would block `readFileSync` for good, so only regular
 * files are read, and a file systemd itself could not read is reported instead of silently skipped.
 */
function readLastLimitCore(
	path: string,
	label: string,
	warn: (name: string, detail: string) => void,
): { value?: string } | undefined {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (!stat?.isFile()) {
		if (stat !== undefined) warn("core dump limit", `${label} is not a regular file`);
		return undefined;
	}
	try {
		let value: string | undefined;
		for (const match of readFileSync(path, "utf8").matchAll(/^LimitCORE=(.*)$/gm)) value = match[1]?.trim();
		return { value };
	} catch (error) {
		warn("core dump limit", `${label} unreadable (${(error as NodeJS.ErrnoException).code})`);
		return undefined;
	}
}

/**
 * `warn` line for an installed daemon unit (`jabbu.service`, `jabbu-<instance>.service` under `unitDir`) without
 * `LimitCORE=0` (run from `jabbu-pocket doctor`). No unit directory or no daemon unit says nothing.
 */
export function checkCoreDumpLimit(unitDir: string, warn: (name: string, detail: string) => void): void {
	let names: string[];
	try {
		// qa-z #7: an instance name may carry dashes (`jabbu-my-bot.service`), so the instance part is no \w run.
		names = readdirSync(unitDir).filter((name) => /^jabbu(?:-[a-z0-9.-]+)?\.service$/.test(name));
	} catch {
		return;
	}
	for (const name of names.filter((n) => !/-(?:backup|dashboard|gc)\.service$/.test(n))) {
		const unit = readLastLimitCore(join(unitDir, name), name, warn);
		if (unit === undefined) continue;
		// qa-z #65: systemd merges the unit file with its drop-ins (`<unit>.d/*.conf`, applied after the unit file
		// in lexical order, the last assignment winning), so the unit file's own 0 alone is no guarantee.
		const dropinDir = `${join(unitDir, name)}.d`;
		let dropins: string[] = [];
		try {
			dropins = readdirSync(dropinDir)
				.filter((file) => file.endsWith(".conf"))
				.sort();
		} catch {
			// no drop-in directory: the unit file alone decides
		}
		let last = unit.value;
		for (const file of dropins) {
			const read = readLastLimitCore(join(dropinDir, file), file, warn);
			if (read !== undefined) last = read.value;
		}
		if (last !== "0")
			warn("core dump limit", `${name} has no LimitCORE=0 (run: jabbu-pocket units render, then reload and restart)`);
	}
}
