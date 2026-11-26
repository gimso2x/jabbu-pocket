import { existsSync } from "node:fs";
import { join } from "node:path";
import { type MonitorLedger, openMonitorLedger } from "../monitors/ledger";
import {
	type ApplyResult,
	applyMonitors,
	type ExportResult,
	exportMonitors,
	type PortableContext,
} from "../monitors/portable";

/**
 * The ledger of one `monitors` CLI run. With no ledger file, a verb that cannot do anything without one (`list`·`show`·
 * `update`·`remove`·`test`·`export`, `apply --dry-run`) gets an empty in-memory ledger instead of creating the file: a
 * ledger holding only the monitor tables is what `gates` and `status` report as unreadable, and `deliveries list` fails on
 * it with `no such table`. The rule `tasks` already follows (`cli/tasks.ts`). `add`, and an `apply` that writes, create it.
 */
export function monitorsLedger(sub: string, homeDir: string, dryRun = false): MonitorLedger {
	const path = join(homeDir, "jabbu.db");
	return existsSync(path) || sub === "add" || (sub === "apply" && !dryRun)
		? openMonitorLedger(path)
		: openMonitorLedger(":memory:");
}

/**
 * Runs `monitors apply`: when the ledger file does not exist yet, validates and dry-runs against an in-memory ledger
 * first so failed validation or an empty directory (`added + updated + removed === 0`) leaves no empty `jabbu.db`.
 */
export function applyPortableMonitors(
	dir: string,
	homeDir: string,
	ctx: PortableContext,
	options: { prune: boolean; dryRun: boolean },
): ApplyResult {
	const dbPath = join(homeDir, "jabbu.db");
	if (!existsSync(dbPath)) {
		const dryLedger = openMonitorLedger(":memory:");
		let dry: ApplyResult;
		try {
			dry = applyMonitors(dryLedger, dir, ctx, { prune: options.prune, dryRun: true });
		} finally {
			dryLedger.close();
		}
		if (options.dryRun || dry.added + dry.updated + dry.removed === 0) return dry;
	}
	const ledger = openMonitorLedger(dbPath);
	try {
		return applyMonitors(ledger, dir, ctx, options);
	} finally {
		ledger.close();
	}
}

/** Runs `monitors export` without creating `jabbu.db` on a home with no ledger. */
export function exportPortableMonitors(
	dir: string,
	homeDir: string,
	ctx: PortableContext,
	options: { withFiles: boolean },
): ExportResult {
	const ledger = monitorsLedger("export", homeDir);
	try {
		return exportMonitors(ledger, dir, ctx, options);
	} finally {
		ledger.close();
	}
}
