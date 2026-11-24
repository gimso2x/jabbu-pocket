// Runs one real `landLane` and dies at a named step when the test asks for it: the process can go between the merge and
// the push or between the push and the cleanup, and the re-run has to finish the landing or leave the repository alone.
import { type LandRequest, landLane } from "../../src/lanes/land";
import { defaultGit } from "../../src/lanes/verify";
import { createTaskHostOps } from "../../src/tasks/host";

const request = JSON.parse(process.argv[2] ?? "") as LandRequest;
if (typeof request.repo !== "string" || typeof request.sha !== "string") {
	throw new Error("usage: bun test/fixtures/land-crash-child.ts '<LandRequest JSON>'");
}
const { removeWorktree } = createTaskHostOps();
const result = await landLane(request, { git: defaultGit, removeWorktree });
process.stdout.write(`${JSON.stringify(result)}\n`);
