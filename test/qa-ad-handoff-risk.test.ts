import { describe, expect, test } from "bun:test";
import { scanHandoffBrief } from "../src/safety/handoff-risk";

const rulesOf = (brief: string) => scanHandoffBrief(brief).findings.map((finding) => finding.rule);
const DOLLAR = "$";
const PWD_VAR = `${DOLLAR}PWD`;
const BRACED_PWD = `${DOLLAR}{PWD}`;
const JABBU_HOME_VAR = `${DOLLAR}JABBU_HOME`;

describe("qa-ad safety handoff-risk 수정", () => {
	test("#25: service_control 지수 백트래킹 없이 선형 시간(<20ms)에 종료되고 정상/위험 판정을 유지한다", () => {
		const worst = `systemctl${" --x".repeat(500)} status`;
		// JIT 웜업 뒤 측정해 CI/부하 편차를 줄인다.
		scanHandoffBrief("systemctl --x status");
		const started = performance.now();
		const slowScan = scanHandoffBrief(worst);
		const elapsedMs = performance.now() - started;
		expect(slowScan.verdict).toBe("clear");
		expect(elapsedMs).toBeLessThan(20);

		for (const cmd of [
			"systemctl --user --now restart foo",
			"systemctl --host=remote stop bar",
			"systemctl -q stop bar",
			"systemctl -- reboot",
			"docker compose restart app",
			"pm2 delete api",
		]) {
			const scan = scanHandoffBrief(cmd);
			expect({ cmd, verdict: scan.verdict, rules: rulesOf(cmd) }).toEqual({
				cmd,
				verdict: "high_risk",
				rules: ["service_control"],
			});
		}

		// 한 줄에 구분자 없이 앞선 동사가 실패해도 뒤따르는 service_control을 놓치지 않는다.
		for (const cmd of [
			"systemctl status 확인 후 systemctl restart jabbu",
			"docker ps 확인하고 docker stop app",
			"pm2 list 본 다음 pm2 delete api",
			"systemctl status 보고, systemctl stop nginx",
		]) {
			const scan = scanHandoffBrief(cmd);
			expect({ cmd, verdict: scan.verdict, rules: rulesOf(cmd) }).toEqual({
				cmd,
				verdict: "high_risk",
				rules: ["service_control"],
			});
		}

		for (const safe of ["systemctl --user status jabbu", "docker compose ps", "pm2 list"]) {
			expect({ safe, verdict: scanHandoffBrief(safe).verdict }).toEqual({ safe, verdict: "clear" });
		}
	});

	test("#26: 인용부호 안에서 줄바꿈된 SQL을 탐지하고 영어 아포스트로피·금지 문구는 비간섭한다", () => {
		for (const [brief, line] of [
			["psql -c 'DROP\nTABLE jobs;'", 1],
			['psql -c "DELETE\nFROM users;"', 1],
			['psql -c "TRUNCATE\nTABLE inbound;"', 1],
			['psql -c "SELECT \\"x\\"; DELETE\nFROM users;"', 1],
			["작업:\n```sh\npsql -c 'DROP\nTABLE jobs;'\n```", 3],
		] as const) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict }).toEqual({ brief, verdict: "high_risk" });
			expect(scan.findings).toContainEqual(
				expect.objectContaining({ rule: "sql_destructive", line, severity: "high_risk" }),
			);
		}

		// 비셸 펜스·닫히지 않은 따옴표·상한(16줄/4096자) 밖에서는 이어붙이지 않는다.
		for (const safe of [
			"```diff\n'DROP\nTABLE jobs;'\n```",
			"```sql\n'DROP\nTABLE jobs;'\n```",
			"'DROP\n```json\n{}\n```\nTABLE jobs;'",
			"echo 'unclosed\nDROP\nTABLE jobs;",
			`'DROP${"\nSELECT 1".repeat(16)}\nTABLE jobs;'`,
			`'DROP\n${"x".repeat(4100)}\nTABLE jobs;'`,
			"don't worry\nit's fine\nuser's guide",
		]) {
			expect({ safe, verdict: scanHandoffBrief(safe).verdict }).toEqual({ safe, verdict: "clear" });
		}

		// 영어 아포스트로피는 열기 따옴표가 아니므로 뒤의 줄이나 실제 인용 SQL 판정에 간섭하지 않는다.
		expect(scanHandoffBrief("don't\nDROP TABLE jobs;")).toMatchObject({
			verdict: "high_risk",
			findings: [{ rule: "sql_destructive", line: 2, severity: "high_risk" }],
		});
		expect(scanHandoffBrief("I don't think\nit's a 'DROP\nTABLE jobs;'").verdict).toBe("high_risk");

		// 여러 줄에 걸친 금지 문구 및 백슬래시 이어붙이기 중복 제거 확인.
		const alreadyOwn = scanHandoffBrief('"Do not run\nDROP TABLE"');
		expect(alreadyOwn.verdict).toBe("high_risk");
		expect(alreadyOwn.findings.filter((f) => f.rule === "sql_destructive")).toHaveLength(1);

		const multiLineForbid = scanHandoffBrief('"Do not run\nDROP\nTABLE"');
		expect(multiLineForbid.verdict).toBe("advisory");
		expect(multiLineForbid.findings).toMatchObject([{ rule: "sql_destructive", line: 1, severity: "advisory" }]);

		const backslashAndQuote = scanHandoffBrief("psql -c 'DROP \\\nTABLE jobs;'");
		expect(backslashAndQuote.verdict).toBe("high_risk");
		expect(backslashAndQuote.findings.filter((f) => f.rule === "sql_destructive")).toHaveLength(1);
	});

	test("#27: cd ~/.jabbu 뒤 ././secrets, .//secrets, $PWD/./secrets 변형을 secret_path로 탐지한다", () => {
		for (const brief of [
			"cd ~/.jabbu && cat ././secrets/token",
			"cd ~/.jabbu && cat .//secrets/token",
			`cd ~/.jabbu && cat ${PWD_VAR}/./secrets/token`,
			`cd ~/.jabbu && cat ${BRACED_PWD}//./secrets/token`,
			"cd ~/.jabbu\ncat ././secrets/token",
			`cd ${JABBU_HOME_VAR} && cat .//./secrets`,
		]) {
			const scan = scanHandoffBrief(brief);
			expect({ brief, verdict: scan.verdict, rules: rulesOf(brief) }).toEqual({
				brief,
				verdict: "high_risk",
				rules: ["secret_path"],
			});
		}

		for (const clearBrief of [
			"cd ~/.jabbu && cat ./../secrets/token",
			"cd ~/.jabbu && cat ././secrets.md",
			`cd ~/.jabbu && cat ${PWD_VAR}/./config.json`,
		]) {
			expect({ clearBrief, verdict: scanHandoffBrief(clearBrief).verdict }).toEqual({
				clearBrief,
				verdict: "clear",
			});
		}
	});
});
