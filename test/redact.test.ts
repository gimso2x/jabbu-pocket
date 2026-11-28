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
		// minimum lengths of the npm_ and sk_/rk_ rules are heuristic matching thresholds, not provider-verified lengths
		["npm_", `TEST${"0".repeat(32)}`],
		["sk_live_", `TEST${"0".repeat(20)}`],
		["rk_live_", `TEST${"0".repeat(20)}`],
		["sk_test_", `TEST${"0".repeat(20)}`],
		["rk_test_", `TEST${"0".repeat(20)}`],
		["https://hooks.slack.com/services/", "T00000000/B00000000/TESTTESTTESTTESTTESTTEST"],
		["https://discord.com/api/webhooks/", `123456789012345678/${"T".repeat(68)}`],
		["https://discordapp.com/api/webhooks/", `123456789012345678/${"t".repeat(68)}`],
		["hf_", "T".repeat(34)],
		["SG.", `${"T".repeat(22)}.${"U".repeat(43)}`],
		["gsk_", "T".repeat(52)],
		["dop_v1_", "a1".repeat(32)],
		["xai-", "T".repeat(48)],
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

	test("a PEM private key cut off before its END line is masked up to the first non-base64 line", () => {
		const kind = "RSA PRIVATE KEY";
		const cut = [`-----BEGIN ${kind}-----`, "MIIEowIBAAKCAQEAtesttest", "TESTTESTTESTTESTTEST=="].join("\n");
		expect(redact(`key:\n${cut}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
		// A lone header with no body line is not a key fragment: it stays.
		expect(redact(`error: missing -----BEGIN ${kind}----- in file`)).toBe(
			`error: missing -----BEGIN ${kind}----- in file`,
		);
	});

	test("lookalikes survive: a public key, AKIA in a word, a webhook docs URL", () => {
		const text =
			"-----BEGIN PUBLIC KEY----- AKIAX https://discord.com/api/webhooks docs https://hooks.slack.com/ glpat-x";
		expect(redact(text)).toBe(text);
	});

	test("npm and Stripe lookalikes survive: npm env names, short bodies, a longer word holding the prefix, sk_ without live/test", () => {
		const text =
			"npm_config_registry npm_package_name npm_short sk_live_short rk_test_abc xnpm_" +
			"0".repeat(32) +
			" my_sk_live_" +
			"0".repeat(20) +
			" sk_prod_" +
			"0".repeat(20) +
			" pk_live_" +
			"0".repeat(20);
		expect(redact(text)).toBe(text);
	});

	test("new provider lookalikes survive: short bodies and a longer word holding the prefix", () => {
		const text = "hf_short xhf_012345678901234567890 gsk_short dop_v1_abc xai-short SG.a.b";
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

	test("credential-named field values are masked, short values and other fields stay", () => {
		const value = "correct-horse-battery-staple-99";
		for (const [field, input] of [
			["password", `{"user":"a","password":"${value}"}`],
			["passwd", `{"passwd": "${value}"}`],
			["client_secret", `{"client_secret": "${value}"}`],
			["api_key", `{"api_key": "${value}"}`],
			["apiKey", `{"apiKey": "${value}"}`],
			["secret", `{"secret": "${value}"}`],
			["form", `client_secret=${value}&grant_type=client_credentials`],
		] as const) {
			const out = redact(input);
			expect(out).not.toContain(value);
			expect(out).toContain(REDACTED);
			expect(out).toContain(field === "form" ? "grant_type" : field);
		}
		expect(redact(`{"password": "short"}`)).toBe(`{"password": "short"}`);
		expect(redact(`{"username": "${value}"}`)).toBe(`{"username": "${value}"}`);
	});

	test("credential query params are masked, the rest of the link stays", () => {
		const value = "abcdef0123456789abcdef0123456789";
		expect(redact(`https://api.example.com/v1/x?api_key=${value}&other=1`)).toBe(
			`https://api.example.com/v1/x?api_key=${REDACTED}&other=1`,
		);
		expect(redact(`https://example.com/cb?client_secret=${value}`)).toBe(
			`https://example.com/cb?client_secret=${REDACTED}`,
		);
		expect(redact(`https://example.com/x?password=${value}`)).toBe(`https://example.com/x?password=${REDACTED}`);
		expect(redact(`https://example.com/?mytoken=${value}`)).toBe(`https://example.com/?mytoken=${value}`);
	});

	test("Authorization header values are masked, the header name stays", () => {
		const basic = "dXNlcjpodW50ZXIyLXBhc3N3b3JkMTIzNDU2";
		expect(redact(`fetch failed: 401 Authorization: Basic ${basic}`)).toBe(
			`fetch failed: 401 Authorization: ${REDACTED}`,
		);
		expect(redact(`{"Authorization": "Basic ${basic}"}`)).toBe(`{"Authorization": "${REDACTED}"}`);
		expect(redact(`Proxy-Authorization: Basic ${basic}`)).toBe(`Proxy-Authorization: ${REDACTED}`);
		expect(redact("Authorization: Bearer abcdef0123456789abcdef0123456789")).toBe(`Authorization: ${REDACTED}`);
		// A Basic value under the 16-char floor is the documented residual (same floor as every other field).
		expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic dXNlcjpwYXNz");
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

describe("redactThenClip", () => {
	test("clips after masking and never leaves a lone high surrogate", async () => {
		const { redactThenClip } = await import("../src/redact");
		expect(redactThenClip("xoxb-TEST-0 rest", 5)).toBe(REDACTED.slice(0, 5));
		// "a"*119 + "🎉" + tail: a UTF-16 cut at 120 lands between the pair's halves.
		const clipped = redactThenClip(`${"a".repeat(119)}🎉tail`, 120);
		expect(clipped).toBe("a".repeat(119));
		expect(clipped.charCodeAt(clipped.length - 1)).toBe("a".charCodeAt(0));
		// A pair wholly inside the budget survives whole.
		expect(redactThenClip(`${"a".repeat(118)}🎉tail`, 120)).toBe(`${"a".repeat(118)}🎉`);
		expect(redactThenClip("abc", 0)).toBe("");
		expect(redactThenClip("", 10)).toBe("");
	});
});

describe("redact on a long unbroken run", () => {
	test("a long run of scheme-like characters is masked in linear time and a real URL password still is", () => {
		// Before the scheme was length-bounded, every word boundary in the run rescanned the rest of it: ~21 s at 400 KB.
		const run = "a-".repeat(200_000);
		const start = performance.now();
		expect(redact(run)).toBe(run);
		expect(performance.now() - start).toBeLessThan(2_000);
		const password = "hunter2-correct-horse-9";
		expect(redact(`${run} https://deploy:${password}@git.example.com/o/r.git`)).toBe(
			`${run} https://deploy:${REDACTED}@git.example.com/o/r.git`,
		);
	});
});
