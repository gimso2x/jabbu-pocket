// Starts a lane and kills itself after its worktree exists but before the registry row is written.
import { CHANNEL } from "../helpers/bot-home";
import { laneHarness } from "../helpers/lane-harness";

const [home, repo] = process.argv.slice(2);
if (home === undefined || repo === undefined) throw new Error("usage: lane-start-crash-child.ts <home> <repo>");
const h = laneHarness(home);
const insertLane = h.store.insertLane.bind(h.store);
h.store.insertLane = (input) => {
	process.kill(process.pid, "SIGKILL");
	return insertLane(input);
};
await h.manager.start({ title: "crash probe", cwd: repo, channel: CHANNEL, parentOrigin: "discord/dm/1" });
