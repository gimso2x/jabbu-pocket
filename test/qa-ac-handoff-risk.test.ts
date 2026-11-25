import { describe, expect, test } from "bun:test";
import { HANDOFF_SCAN_BYTES, scanHandoffBrief } from "../src/safety/handoff-risk";

const rulesOf = (brief: string) => scanHandoffBrief(brief).findings.map((finding) => finding.rule);

describe("qa-ac safety handoff-risk 수정", () => {
	test("#15: timeout -k/-s/--kill-after/--signal 옵션 뒤 시간과 power 명령을 놓치지 않는다", () => {
		for (const cmd of [
			"timeout -k 5 10 reboot",
			"timeout -s KILL 10 shutdown -h now",
			"timeout --kill-after 5 --signal TERM 10 reboot",
			"timeout --signal=KILL -v 10s poweroff",
		]) {
			const scan = scanHandoffBrief(cmd);
			expect({ cmd, verdict: scan.verdict, rules: rulesOf(cmd) }).toEqual({
				cmd,
				verdict: "high_risk",
				rules: ["service_control"],
			});
		}
	});

	test("#16: 영어 종속절·한국어 접속절 경계를 구분하되 or 뒤 명령은 단일 금지절로 남긴다", () => {
		for (const brief of [
			"git reset --hard origin/main so we don't hit the conflict again",
			"git push --force origin main because we never need old history",
			"git reset --hard origin/main while nobody else is pushing",
			"git reset --hard origin/main if you don't want stale files",
			"git reset --hard origin/main since don't keep local drift",
			"git reset --hard origin/main when we never asked for edits",
			"git reset --hard origin/main although never recommended",
			"git reset --hard origin/main unless we don't overwrite tags",
			"git reset --hard origin/main yet we never lost commits",
			"git reset --hard origin/main 하니까 충돌이 안 나",
			"git reset --hard origin/main 하므로 문제는 없다",
			"git reset --hard origin/main 한다면 지우지 마",
			"git reset --hard origin/main 했으므로 신경 쓰지 마",
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
		}

		// `or` must remain inside a single forbidden clause so "do not run X or Y" keeps both advisory.
		const singleForbidden = scanHandoffBrief("do not run git reset --hard or git push --force");
		expect(singleForbidden.verdict).toBe("advisory");
		expect(singleForbidden.findings.every((f) => f.severity === "advisory")).toBe(true);
	});

	test("#17: 환경변수 대입과 exec -a/-cl 래퍼 뒤 위험 명령을 탐지한다", () => {
		for (const cmd of ["X=1 reboot", "FOO=bar BAZ=1 sudo shutdown -r now", "exec -a fake reboot", "exec -cl reboot"]) {
			const scan = scanHandoffBrief(cmd);
			expect({ cmd, verdict: scan.verdict, rules: rulesOf(cmd) }).toEqual({
				cmd,
				verdict: "high_risk",
				rules: ["service_control"],
			});
		}
		expect(scanHandoffBrief("cd ~/.jabbu && X=1 exec -a reader cat secrets/token").verdict).toBe("high_risk");
	});

	test("긴 공백·반복 래퍼 입력에서도 선형 시간(<200ms)으로 끝난다", () => {
		const inputs = [
			" ".repeat(HANDOFF_SCAN_BYTES),
			`${"X=1 ".repeat(1_000)}ls`,
			`timeout ${"-k ".repeat(30)}ls`,
			`exec ${"-a ".repeat(30)}ls`,
		];
		const t0 = performance.now();
		for (const input of inputs) {
			expect(scanHandoffBrief(input).verdict).toBe("clear");
		}
		expect(performance.now() - t0).toBeLessThan(200);
	});
});
