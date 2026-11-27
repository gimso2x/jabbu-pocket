// `jabbu-pocket quota status|lift|clear` CLI 명령.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { clearQuotaLift, readQuotaGateSnapshot, readQuotaLifts, writeQuotaLift } from "../ops/quota-gate";

export const QUOTA_USAGE = `  quota status [--json]          show active per-provider quota holds and manual lifts
  quota lift [provider] [--minutes N]    temporarily lift quota holds (default 60m; omit provider for all)
  quota clear [provider]         remove manual quota lift(s)
`;

const DEFAULT_LIFT_MINUTES = 60;
const MAX_LIFT_MINUTES = 1440;
const PROVIDER_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validProviderArg(raw: string): boolean {
	return raw === "*" || PROVIDER_ARG.test(raw);
}

/** `jabbu-pocket quota <status|lift|clear>` 실행기. */
export function quotaCommand(args: string[], homeDir: string, now: () => number = Date.now): number {
	const [sub, ...rest] = args;
	if (sub === "status") {
		const { values, positionals } = parseArgs({
			args: rest,
			options: { json: { type: "boolean" } },
			allowPositionals: true,
		});
		if (positionals.length > 0) {
			process.stderr.write(`quota status: too many arguments\n${QUOTA_USAGE}`);
			return 2;
		}
		const at = now();
		const snapshot = readQuotaGateSnapshot(homeDir, at);
		const lifts = [...readQuotaLifts(homeDir, at).values()].sort((a, b) => a.provider.localeCompare(b.provider));
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify({ ...snapshot, lifts })}\n`);
			return 0;
		}
		const updated = snapshot.updatedAt === null ? "never" : new Date(snapshot.updatedAt).toISOString();
		const mode = snapshot.mode === "warn" ? " mode=warn" : "";
		const err = snapshot.lastError === undefined ? "" : ` last_error=${JSON.stringify(snapshot.lastError)}`;
		process.stdout.write(
			`quota_status held=${snapshot.held.length} lifts=${lifts.length} updated=${updated}${mode}${err}\n`,
		);
		for (const hold of snapshot.held) {
			const causes = hold.causes
				.map((cause) => `${cause.label}:${Math.round(cause.usedPct)}%->${new Date(cause.releaseAt).toISOString()}`)
				.join(",");
			process.stdout.write(`hold provider=${hold.provider} causes=${causes}\n`);
		}
		for (const lift of lifts) {
			process.stdout.write(`lift provider=${lift.provider} until=${new Date(lift.untilMs).toISOString()}\n`);
		}
		return 0;
	}
	if (sub === "lift") {
		const { values, positionals } = parseArgs({
			args: rest,
			options: { minutes: { type: "string" } },
			allowPositionals: true,
		});
		if (positionals.length > 1) {
			process.stderr.write(`quota lift: too many arguments\n${QUOTA_USAGE}`);
			return 2;
		}
		const rawProvider = positionals[0];
		if (rawProvider !== undefined && !validProviderArg(rawProvider)) {
			process.stderr.write(`quota lift: invalid provider ${rawProvider}\n${QUOTA_USAGE}`);
			return 2;
		}
		let minutes = DEFAULT_LIFT_MINUTES;
		if (values.minutes !== undefined) {
			minutes = /^\d+$/.test(values.minutes) ? Number(values.minutes) : Number.NaN;
			if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_LIFT_MINUTES) {
				process.stderr.write(`quota lift: --minutes must be an integer between 1 and ${MAX_LIFT_MINUTES}\n`);
				return 2;
			}
		}
		if (!existsSync(homeDir)) {
			process.stderr.write(`quota lift: home directory does not exist: ${homeDir}\n`);
			return 1;
		}
		const provider = rawProvider === undefined ? "*" : rawProvider.toLowerCase();
		const at = now();
		const entry = writeQuotaLift(homeDir, { provider, untilMs: at + minutes * 60_000, now: at });
		process.stdout.write(
			`quota_lifted provider=${entry.provider} minutes=${minutes} until=${new Date(entry.untilMs).toISOString()}\n`,
		);
		return 0;
	}
	if (sub === "clear") {
		const { positionals } = parseArgs({ args: rest, allowPositionals: true });
		if (positionals.length > 1) {
			process.stderr.write(`quota clear: too many arguments\n${QUOTA_USAGE}`);
			return 2;
		}
		const rawProvider = positionals[0];
		if (rawProvider !== undefined && !validProviderArg(rawProvider)) {
			process.stderr.write(`quota clear: invalid provider ${rawProvider}\n${QUOTA_USAGE}`);
			return 2;
		}
		const provider = rawProvider === undefined ? undefined : rawProvider.toLowerCase();
		const count = clearQuotaLift(homeDir, provider);
		process.stdout.write(`quota_cleared provider=${provider ?? "*"} count=${count}\n`);
		return 0;
	}
	process.stderr.write(`usage: jabbu-pocket quota <status|lift|clear>\n${QUOTA_USAGE}`);
	return 2;
}
