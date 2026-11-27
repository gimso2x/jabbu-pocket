import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { type JabbuConfig, loadConfig } from "../config";

/**
 * Config for the CLI levers (bundle cap, off-site target). A home without a config.json keeps the defaults —
 * `jabbu-pocket backup` must work on a db-only home (it is the recovery tool) — while a config that exists but is invalid
 * fails loudly, so a broken `maxBundleBytes` or `offsite` never silently reverts to "off".
 */
export function loadConfigIfPresent(homeDir: string, options: { checkTokens?: boolean } = {}): JabbuConfig | undefined {
	return existsSync(join(homeDir, "config.json")) ? loadConfig(homeDir, options) : undefined;
}

/** Verifies `homeDir` is a directory containing `jabbu.db`; writes a clear stderr line and returns false otherwise. */
export function hasHomeDatabase(command: string, homeDir: string): boolean {
	const dbPath = join(homeDir, "jabbu.db");
	if (
		statSync(homeDir, { throwIfNoEntry: false })?.isDirectory() !== true ||
		lstatSync(dbPath, { throwIfNoEntry: false }) === undefined
	) {
		process.stderr.write(`${command}: no database at ${dbPath}\n`);
		return false;
	}
	return true;
}

/** `lstatSync` returning `undefined` on missing/inaccessible paths without throwing. */
export function lstatSafe(path: string) {
	try {
		return lstatSync(path, { throwIfNoEntry: false });
	} catch {
		return undefined;
	}
}
