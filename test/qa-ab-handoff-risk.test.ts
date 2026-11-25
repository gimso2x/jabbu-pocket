import { describe, expect, test } from "bun:test";
import { scanHandoffBrief } from "../src/safety/handoff-risk";

const rulesOf = (brief: string) => scanHandoffBrief(brief).findings.map((finding) => finding.rule);
const DOLLAR = "$";
const BRACED_PWD = `${DOLLAR}{PWD}`;

describe("qa-ab safety handoff-risk 수정", () => {
	test("#16: sudo/doas/env options with arguments still surface wrapped service_control without ReDoS", () => {
		for (const cmd of [
			"sudo -u root reboot",
			"sudo -g wheel -- shutdown -h now",
			"doas -u root poweroff",
			"env -i reboot",
			"env -u PATH FOO=1 reboot",
			"env -C /tmp reboot",
			"env -- reboot",
		]) {
			const scan = scanHandoffBrief(cmd);
			expect({ cmd, verdict: scan.verdict, rules: rulesOf(cmd) }).toEqual({
				cmd,
				verdict: "high_risk",
				rules: ["service_control"],
			});
		}

		const t0 = performance.now();
		expect(scanHandoffBrief(`sudo ${"-u ".repeat(30)}ls`).verdict).toBe("clear");
		expect(performance.now() - t0).toBeLessThan(50);
	});

	test("#17: $PWD and braced PWD under bot home or subdirs trigger secret_path without false positives", () => {
		for (const brief of [
			"cd ~/.jabbu && cat $PWD/secrets/x",
			`cd ~/.jabbu\ncat "${BRACED_PWD}/secrets/token.json"`,
			"cd ~/.jabbu/logs && cat $PWD/../secrets/x",
			'cd ~/.jabbu/secrets && cat "$PWD/token.json"',
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict, rules: rulesOf(brief) }).toEqual({
				brief,
				verdict: "high_risk",
				rules: ["secret_path"],
			});
		}

		for (const clearBrief of ["cd ~/.jabbu && cat $PWD/secrets.md", "cd ~/.jabbu/logs && cat $PWD_EXTRA/secrets"]) {
			expect({ clearBrief, verdict: scanHandoffBrief(clearBrief).verdict }).toEqual({
				clearBrief,
				verdict: "clear",
			});
		}
	});
});
