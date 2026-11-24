import { existsSync } from "node:fs";
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
