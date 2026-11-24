// The home a systemd unit runs a daemon with, read back from `systemctl show -p Environment`.

/** A unit whose `Environment=` names `JABBU_HOME` in a form `unitJabbuHome` cannot read: the apply must not guess its home. */
export class UnitHomeUnreadableError extends Error {
	constructor(unit: string) {
		super(`cannot read JABBU_HOME of unit ${unit}: unparseable Environment= (apply stopped; nothing restarted)`);
		this.name = "UnitHomeUnreadableError";
	}
}

/**
 * `JABBU_HOME` of a `systemctl show -p Environment` value: whitespace-separated assignments, each possibly quoted
 * like systemd does (`"JABBU_HOME=/h/with space"`, backslash escapes inside quotes). Undefined when it is not set.
 */
export function unitJabbuHome(unit: string, environment: string): string | undefined {
	const words: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (let i = 0; i < environment.length; i++) {
		const ch = environment[i] as string;
		if (quote !== undefined) {
			if (ch === "\\" && i + 1 < environment.length) current += environment[++i];
			else if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) words.push(current);
			current = "";
			started = false;
		} else {
			current += ch;
			started = true;
		}
	}
	if (quote !== undefined) throw new UnitHomeUnreadableError(unit);
	if (started) words.push(current);
	const found = words.find((word) => word.startsWith("JABBU_HOME="));
	if (found === undefined) return undefined;
	const home = found.slice("JABBU_HOME=".length);
	if (home === "") throw new UnitHomeUnreadableError(unit);
	return home;
}
