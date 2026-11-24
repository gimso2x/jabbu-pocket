import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { byteLength, clearSecretIndex, indexSecretValue, REDACTED, redact, truncateUtf8 } from "../src/redact";

describe("redact", () => {
	test.each([
		"xoxb-TEST-0",
		"xoxa-TEST-0",
		"xoxp-TEST-0",
		"xoxo-TEST-0",
		"xoxs-TEST-0",
		"xoxr-TEST-0",
		"xoxe-TEST-0",
		"xoxc-TEST-0",
		"xoxd-TEST-0",
		"xapp-TEST-0",
		"sk-TEST-0",
		"sk-ant-TEST-0",
		`ghp_${"A".repeat(36)}`,
		`gho_${"b1".repeat(15)}`,
		`ghu_${"C".repeat(20)}`,
		`ghs_${"D".repeat(36)}`,
		`ghr_${"e".repeat(36)}`,
		`github_pat_${"F".repeat(22)}_${"g".repeat(59)}`,
	])("%s is replaced", (token) => {
		expect(redact(`before ${token} after`)).toBe(`before ${REDACTED} after`);
	});

	test("sk-ant- token is one replacement, not two", () => {
		expect(redact("sk-ant-api03-TEST_0")).toBe(REDACTED);
	});

	test("short token shapes are replaced too", () => {
		expect(redact("xoxb-a")).toBe(REDACTED);
	});

	test("multiple tokens and ordinary words", () => {
		expect(redact("xoxb-TEST-0,xapp-TEST-0 task-1 risk-free disk-usage")).toBe(
			`${REDACTED},${REDACTED} task-1 risk-free disk-usage`,
		);
	});

	test("short gh_ lookalikes and plain words survive", () => {
		expect(redact("ghp_short ghx_AAAAAAAAAAAAAAAAAAAAAAAA light_weight")).toBe(
			"ghp_short ghx_AAAAAAAAAAAAAAAAAAAAAAAA light_weight",
		);
	});

	test("text without secrets is unchanged", () => {
		expect(redact("plain text 한글")).toBe("plain text 한글");
	});

	// Not a real token: the bot-token shape (base64url id . 6-char stamp . HMAC) assembled at runtime.
	const discordToken = [`MTA${"x".repeat(21)}`, "Gh_9-k", `${"Ab-_9".repeat(7)}z`].join(".");

	test("a Discord bot token shape is replaced", () => {
		expect(redact(`토큰 ${discordToken} 끝`)).toBe(`토큰 ${REDACTED} 끝`);
		expect(redact(`Bot ${discordToken}`)).toBe(`Bot ${REDACTED}`);
	});

	test("dotted words, versions, hosts and JWT-like headers are not Discord tokens", () => {
		const plain = "v1.2.3 api.discord.com a.b.c jabbu.config.json eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc";
		expect(redact(plain)).toBe(plain);
	});
});

describe("fable IMP-13: cloud keys, webhook URLs and private keys", () => {
	// Assembled at run time so no secret scanner reads these fakes as real credentials.
	test.each([
		["AKIA", "TESTTESTTEST0000"],
		["AIza", `Sy${"T".repeat(31)}-0`],
		["glpat-", "TEST_TEST_TEST_TEST_0"],
		["https://hooks.slack.com/services/", "T00000000/B00000000/TESTTESTTESTTESTTESTTEST"],
		["https://discord.com/api/webhooks/", `123456789012345678/${"T".repeat(68)}`],
		["https://discordapp.com/api/webhooks/", `123456789012345678/${"t".repeat(68)}`],
	])("%s… is replaced", (head, tail) => {
		expect(redact(`before ${head}${tail} after`)).toBe(`before ${REDACTED} after`);
	});

	test("a PEM private key block is masked from BEGIN to END, the text around it stays", () => {
		const kind = "RSA PRIVATE KEY";
		const block = [
			`-----BEGIN ${kind}-----`,
			"MIIEowIBAAKCAQEAtest",
			"TESTTESTTESTTEST==",
			`-----END ${kind}-----`,
		].join("\n");
		expect(redact(`key:\n${block}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
		const ssh = "OPENSSH PRIVATE KEY";
		expect(redact([`-----BEGIN ${ssh}-----`, "b3BlbnNzaC1rZXktdjEAtest", `-----END ${ssh}-----`].join("\n"))).toBe(
			REDACTED,
		);
	});

	test("lookalikes survive: a public key, AKIA in a word, a webhook docs URL", () => {
		const text =
			"-----BEGIN PUBLIC KEY----- AKIAX https://discord.com/api/webhooks docs https://hooks.slack.com/ glpat-x";
		expect(redact(text)).toBe(text);
	});
});

describe("qa50b I-20: a token split by a line break", () => {
	test("is masked whole, both halves", () => {
		const out = redact("card: ghp_abcdefghijklmnop\nqrstuvwxyz0123456789 end");
		expect(out).toBe(`card: ${REDACTED} end`);
		const tail = redact(`x ghp_${"A".repeat(10)}\r\n${"B".repeat(26)} y`);
		expect(tail).toBe(`x ${REDACTED} y`);
	});

	test("plain multi-line prose and the line after a complete token are untouched", () => {
		expect(redact("line one\nline two")).toBe("line one\nline two");
		expect(redact("a xoxb-TEST-0\nnext line")).toBe(`a ${REDACTED}\nnext line`);
		expect(redact(`a ghp_${"A".repeat(36)}\nnext`)).toBe(`a ${REDACTED}\nnext`);
	});
});

describe("byte budget", () => {
	test("truncateUtf8 never splits a code point", () => {
		const s = "가나다"; // 3 bytes each
		expect(truncateUtf8(s, 7)).toBe("가나");
		expect(truncateUtf8(s, 9)).toBe(s);
		expect(truncateUtf8("a😀b", 4)).toBe("a");
		expect(truncateUtf8("abc", 0)).toBe("");
	});

	test("budget is applied after masking: growth from masking cannot exceed it", () => {
		const input = "xoxb-a"; // 6 bytes raw, 10 bytes masked
		expect(byteLength(input)).toBe(6);
		const out = truncateUtf8(redact(input), 8);
		expect(byteLength(out)).toBeLessThanOrEqual(8);
		expect(out).not.toContain("xoxb");
	});

	test("shrinking masks leave room for later content", () => {
		const input = `xoxb-${"A".repeat(100)} tail`;
		expect(truncateUtf8(redact(input), 30)).toBe(`${REDACTED} tail`);
	});

	test("result in bytes never exceeds the budget for multibyte output", () => {
		const out = truncateUtf8(redact(`한글 xapp-TEST-0 ${"가".repeat(50)}`), 40);
		expect(byteLength(out)).toBeLessThanOrEqual(40);
		expect(out).not.toContain("xapp-");
	});

	test("a URL password and signed-query values are masked, the rest of the link stays", () => {
		expect(redact("fatal: unable to access 'https://deploy:hunter2pass@git.example.com/a/b.git/'")).toBe(
			`fatal: unable to access 'https://deploy:${REDACTED}@git.example.com/a/b.git/'`,
		);
		expect(redact("https://u:p@ss@host.example/x")).toBe(`https://u:${REDACTED}@host.example/x`);
		expect(redact("https://b.example/x.zip?X-Amz-Credential=AKIDEXAMPLE%2Fs3&X-Amz-Signature=abcdef0123&n=1")).toBe(
			`https://b.example/x.zip?X-Amz-Credential=AKIDEXAMPLE%2Fs3&X-Amz-Signature=${REDACTED}&n=1`,
		);
		expect(redact("see https://api.example/v1?sig=zzTop99&page=2 and https://e.example/?x=1&token=abc123")).toBe(
			`see https://api.example/v1?sig=${REDACTED}&page=2 and https://e.example/?x=1&token=${REDACTED}`,
		);
	});

	test("links without credentials are untouched", () => {
		for (const text of [
			"http://host:8080/a@b",
			"https://example.com/path?page=2&sort=asc",
			"https://example.com:8443/x",
			"ssh://git@github.com/o/r.git",
			"https://example.com/?mytoken=1",
		])
			expect(redact(text)).toBe(text);
	});
});

describe("HTML entity and URL-encoded secret index masking (AC-3)", () => {
	const SECRET = "abc&def<ghi\"jkl'mno pqr";

	beforeEach(() => {
		clearSecretIndex();
	});

	afterEach(() => {
		clearSecretIndex();
	});

	test("masks HTML entity representations (&#39;, &#x27;, &quot;, &lt;, &gt;, &amp;)", () => {
		expect(indexSecretValue(SECRET)).toBe(true);
		const html39 = "leak abc&amp;def&lt;ghi&quot;jkl&#39;mno pqr tail";
		const html27 = "leak abc&amp;def&lt;ghi&quot;jkl&#x27;mno pqr tail";
		const redacted39 = redact(html39);
		const redacted27 = redact(html27);

		expect(redacted39).toBe(`leak ${REDACTED} tail`);
		expect(redacted27).toBe(`leak ${REDACTED} tail`);
		expect(redacted39).not.toContain("abc");
		expect(redacted39).not.toContain("ghi");
		expect(redacted39).not.toContain("mno");
		expect(redacted27).not.toContain("abc");
		expect(redacted27).not.toContain("ghi");
		expect(redacted27).not.toContain("mno");
	});

	test("masks URL-encoded representations (encodeURIComponent, + space variant, lower-case hex)", () => {
		expect(indexSecretValue(SECRET)).toBe(true);
		const urlStd = `url ${encodeURIComponent(SECRET)} end`;
		const urlPlus = `url ${encodeURIComponent(SECRET).replaceAll("%20", "+")} end`;
		const urlStrict = "url abc%26def%3Cghi%22jkl%27mno%20pqr end";
		const urlLower = "url abc%26def%3cghi%22jkl%27mno+pqr end";

		for (const input of [urlStd, urlPlus, urlStrict, urlLower]) {
			const res = redact(input);
			expect(res).toBe(`url ${REDACTED} end`);
			expect(res).not.toContain("abc");
			expect(res).not.toContain("ghi");
			expect(res).not.toContain("mno");
		}
	});
});
