import { openDeliveriesLedgerFor } from "./deliveries-ledger";
import { heldLine } from "./deliveries-list";

export const DELIVERIES_USAGE = `  deliveries list                held (ambiguous) deliveries waiting for the owner: id, channel, thread, time, preview
  deliveries ack <id>            the answer did arrive: close the held row as confirmed
  deliveries resend <id>         send it again (parts already posted are skipped); the daemon pumps it
`;

const USAGE_LINE = "usage: jabbu-pocket deliveries <list|ack|resend>";
type Verb = "list" | "ack" | "resend";

/** What the owner mistyped, or the verb to run: the two failure shapes the command line may take. */
function readCall(args: string[]): Verb | { error: string } {
	const [verb, idText] = args;
	if (verb !== "list" && verb !== "ack" && verb !== "resend") return { error: USAGE_LINE };
	if (args.length > (verb === "list" ? 1 : 2)) return { error: `${USAGE_LINE} (too many arguments)` };
	if (verb !== "list" && (idText === undefined || !/^\d+$/.test(idText)))
		return { error: `deliveries ${verb}: needs a delivery id` };
	return verb;
}

/** `jabbu-pocket deliveries list|ack <id>|resend <id>`: the owner's way out of a held (`failed_ambiguous`) delivery. */
export function deliveriesCommand(args: string[], homeDir: string): number {
	const call = readCall(args);
	if (typeof call !== "string") {
		process.stderr.write(`${call.error}\n${DELIVERIES_USAGE}`);
		return 2;
	}
	const ledger = openDeliveriesLedgerFor(homeDir);
	if (ledger === undefined) return 1;
	try {
		if (call === "list") {
			const rows = ledger.listAmbiguous();
			process.stdout.write(rows.length === 0 ? "no ambiguous deliveries\n" : `${rows.map(heldLine).join("\n")}\n`);
			return 0;
		}
		const resolved = ledger.resolveAmbiguous(Number(args[1]), call);
		process.stdout.write(`${call === "ack" ? "acked" : "resent"} ${resolved.deliveryId}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`deliveries ${call}: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		ledger.close();
	}
}
