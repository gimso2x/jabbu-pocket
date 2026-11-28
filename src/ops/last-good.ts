// The last-good config (`config.json.last-good`): what apply records as the rollback target, and what the
// rollback step restores. Both directions pin the validated text, never whatever `config.json` holds now.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { writeAtomic0600 } from "./stamp";

/**
 * Whether `bytes` load as a config: checked from a temp home (token files are not copied, so they are not
 * checked) so a corrupt last-good is never restored blindly. A config whose repos or overlay vanished since
 * it was recorded fails too — the daemon would refuse it at boot all the same.
 */
function lastGoodConfigValid(bytes: string): boolean {
	const dir = mkdtempSync(join(tmpdir(), "jabbu-last-good-"));
	try {
		chmodSync(dir, 0o700);
		writeFileSync(join(dir, "config.json"), bytes);
		loadConfig(dir, { checkTokens: false });
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Restores the last-good config after validating it, or the reason it was not restored. */
export function restoreLastGoodDetail(configPath: string, lastGood: string): string {
	const bytes = readFileSync(lastGood);
	if (!lastGoodConfigValid(bytes.toString("utf8"))) return `last-good config invalid, not restored (${lastGood})`;
	writeAtomic0600(configPath, bytes);
	return `config restored from ${lastGood}`;
}
