import { existsSync } from "node:fs";
import { join } from "node:path";
import { type MonitorLedger, openMonitorLedger } from "../monitors/ledger";

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
