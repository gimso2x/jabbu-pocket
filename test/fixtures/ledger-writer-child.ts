// A second jabbu process writing to the shared tasks ledger (the owner's `jabbu-pocket tasks ...` command line).
// usage: bun ledger-writer-child.ts <db> register|pause <rounds> [taskId]; prints {ok, failures:[code,...]}.
import { openTaskLedger } from "../../src/tasks/ledger";

const [path, mode, rounds, taskId] = process.argv.slice(2);
const ledger = openTaskLedger(path as string, "Asia/Seoul");
let ok = 0;
const failures: string[] = [];
for (let i = 0; i < Number(rounds); i++) {
	try {
		if (mode === "pause" && taskId !== undefined) {
			ledger.pauseTask(taskId);
			ledger.unpauseTask(taskId);
		} else {
			ledger.register({
				title: `t${i}`,
				risk: "L2",
				originKey: "o",
				threadRef: "D1:1",
				host: "h",
				repo: "/r",
				acceptance: [],
			} as never);
		}
		ok++;
	} catch (error) {
		failures.push(String((error as { code?: string }).code ?? error));
	}
}
ledger.close();
console.log(JSON.stringify({ ok, failures }));
