import { parseArgs } from "node:util";
import { ConfigError, type JabbuConfig } from "../config";
import { gateText } from "../dashboard/text";
import { collectGates, type Gate, type GatesOptions, gateOptionsFromConfig } from "../ops/gates";
import { loadConfigIfPresent } from "./home-config";

export const GATES_USAGE = `  gates [--json] [--strict] [--ko]
                                 read-only health projection; each gate is open, closed or unknown (nothing to judge: no
                                 heartbeat stamp or no jabbu.db yet); exit 1 if any open, with --strict also if any unknown.
                                 --ko writes the last line in Korean (dashboard labels) for alerts a person reads.
                                 gates: backup_age, offsite_age (only with config offsite), sweep_stalled,
                                 discord_disconnected (only with config channels.discord), frozen,
                                 herdr_unreachable (only with a herdr-health stamp), omp_runtime (only with agent omp),
                                 disk_low, host_pressure, inbound_starved, origin_silent, deliveries_overdue,
                                 deliveries_ambiguous_stuck, lanes_stuck, monitors_failed, monitors_stalled, turns_failing, ledger_unreadable,
                                 inbound_identity_conflicts (report only, never open), drain_orphaned,
                                 cost_cap (warning only, with config costCap.dailyUsd)
`;

/** Test seam of `jabbu-pocket gates`: the clock and the host readers `collectGates` would otherwise take from this machine. */
export type GatesCommandDeps = Pick<GatesOptions, "statfs" | "hostLoad"> & { now?: () => number };

/** `jabbu-pocket gates`: exit 1 when a gate is open, or with `--strict` also when one cannot be judged (`unknown`); exit 2 when the config cannot be read, so no gate was judged. */
export function gatesCommand(args: string[], homeDir: string, deps: GatesCommandDeps = {}): number {
	const { values } = parseArgs({
		args,
		options: { json: { type: "boolean" }, strict: { type: "boolean" }, ko: { type: "boolean" } },
	});
	// A db-only home (no config.json) has no omp to check; the omp_runtime gate is then omitted.
	let config: JabbuConfig | undefined;
	try {
		config = loadConfigIfPresent(homeDir);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		// No verdict: exit 2 keeps this apart from "a gate is open" (1) and "all closed" (0), and the last line still
		// says so for an alerting tool that shows only it.
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify({ error: error.code, message: error.message, gates: [] })}\n`);
		} else if (values.ko === true) {
			process.stdout.write(`게이트 판정 못 함: 설정을 읽지 못했습니다(${error.code})\n`);
		} else {
			process.stdout.write(`gates_done error=${error.code} detail=${JSON.stringify(error.message)}\n`);
		}
		return 2;
	}
	const gates = collectGates({
		homeDir,
		now: (deps.now ?? Date.now)(),
		...gateOptionsFromConfig(config),
		...(deps.statfs === undefined ? {} : { statfs: deps.statfs }),
		...(deps.hostLoad === undefined ? {} : { hostLoad: deps.hostLoad }),
	});
	const open = gates.filter((gate) => gate.state === "open");
	const unknown = gates.filter((gate) => gate.state === "unknown");
	if (values.json === true) {
		process.stdout.write(`${JSON.stringify({ open: open.length, unknown: unknown.length, gates })}\n`);
	} else {
		for (const gate of gates) process.stdout.write(`gate=${gate.name} state=${gate.state} detail=${gate.detail}\n`);
		// Alerting tools show only the last line, so it names the open and the unjudgeable gates.
		// `--ko` swaps it for the owner-facing words of the dashboard (`gateText`), for alerts a person reads.
		const opened = open.map((gate) => `${gate.name}(${gate.detail})`).join(",");
		const unjudged = unknown.map((gate) => gate.name).join(",");
		process.stdout.write(
			values.ko === true
				? `${gatesKoreanSummary(open, unknown, gates.length)}\n`
				: `gates_done open=${open.length} unknown=${unknown.length} total=${gates.length}${opened ? ` opened=${opened}` : ""}${
						unjudged ? ` unknown_gates=${unjudged}` : ""
					}\n`,
		);
	}
	return open.length > 0 || (values.strict === true && unknown.length > 0) ? 1 : 0;
}

/**
 * The `--ko` last line: the open gates by their dashboard label with the gate's numbers, the one thing to do when a
 * single gate is open, then the gates that could not be judged.
 */
function gatesKoreanSummary(open: Gate[], unknown: Gate[], total: number): string {
	if (open.length === 0 && unknown.length === 0) return `게이트 ${total}개 모두 정상`;
	const parts: string[] = [];
	if (open.length > 0) {
		const named = open.map((gate) => `${gateText(gate.name).label}(${gate.detail})`).join(" / ");
		const todo = open.length === 1 ? ` · 할 일: ${gateText(open[0]?.name ?? "").todo}` : "";
		parts.push(`게이트 ${open.length}/${total}개 열림 — ${named}${todo}`);
	}
	if (unknown.length > 0) {
		parts.push(
			`판정 못 한 게이트 ${unknown.length}개 — ${unknown.map((gate) => gateText(gate.name).label).join(" / ")}`,
		);
	}
	return parts.join(" · ");
}
