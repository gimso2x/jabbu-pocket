import { afterEach, beforeEach, expect, test } from "bun:test";
import { CHANNEL, makeHome, type TestHome } from "./helpers/bot-home";
import { makeRepo } from "./helpers/git-fixtures";
import { laneHarness, removeRepoAndWorktrees } from "./helpers/lane-harness";

// A cap that lands inside an emoji must drop the whole pair, never leave a lone high surrogate.
const loneHigh = (text: string) => {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff;
};

let home: TestHome;
let repos: string[];

beforeEach(() => {
	home = makeHome("jabbu-surrogate-lane-");
	repos = [];
});

afterEach(() => {
	home.remove();
	for (const repo of repos) removeRepoAndWorktrees(repo);
});

test("lane title and milestone caps never end in a lone high surrogate", async () => {
	const h = laneHarness(home.dir);
	const lane = await h.manager.start({
		title: `${"a".repeat(119)}😀tail`,
		cwd: makeRepo(repos),
		channel: CHANNEL,
	});
	await h.settle();
	expect(lane.title.length).toBeLessThanOrEqual(120);
	expect(loneHigh(lane.title)).toBe(false);
	await h.manager.progress(lane.originKey, `${"b".repeat(299)}😀tail`, { needsOwner: true });
	const milestone = h.store.getLane(lane.name)?.meta.milestone ?? "";
	expect(milestone.length).toBeGreaterThan(0);
	expect(loneHigh(milestone)).toBe(false);
	h.close();
});
