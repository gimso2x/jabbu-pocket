import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMonitorLedger } from "../src/monitors/ledger";
import { applyMonitors, exportMonitors, type PortableContext } from "../src/monitors/portable";
import { parseMonitorSpec } from "../src/monitors/spec";
import { redact } from "../src/redact";
import { openStore } from "../src/store/db";
import { makeHome, OWNER_DM, type TestHome } from "./helpers/bot-home";
import { killSpawned, runCliCapture } from "./helpers/daemon-process";

const DM_ORIGIN = `discord/dm/${OWNER_DM}`;

let dir: string;
let ctx: PortableContext;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jabbu-monitors-qa-j-"));
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "workspace"));
	ctx = { scriptsRoot: join(dir, "scripts"), workspaceDir: join(dir, "workspace"), defaultTimezone: "Asia/Seoul" };
});

afterEach(() => {
	killSpawned();
	rmSync(dir, { recursive: true, force: true });
});

function ledger() {
	return openMonitorLedger(join(dir, "jabbu.db"));
}

function scriptSpec(name: string, command: string[]) {
	for (const arg of command) {
		if (arg.startsWith(ctx.scriptsRoot)) {
			writeFileSync(arg, "#!/bin/sh\nexit 1\n");
			chmodSync(arg, 0o755);
		}
	}
	return parseMonitorSpec({ name, trigger: { kind: "script", command, intervalMs: 60_000 }, instruction: "i" }, ctx);
}

describe("portable apply/export (qa-j)", () => {
	// qa n63/n123: a FIFO or directory named `*.json` hides its monitor's name, so --prune must not delete anything.
	test("--prune is held while a non-regular *.json entry was skipped", () => {
		const l = ledger();
		l.addMonitor(scriptSpec("keepme", [join(dir, "scripts", "s.sh")]));
		const apply = join(dir, "apply");
		mkdirSync(join(apply, "diry.json"), { recursive: true });
		const result = applyMonitors(l, apply, ctx, { prune: true });
		expect(result.removed).toBe(0);
		expect(result.warnings.join("\n")).toContain("--prune held");
		expect(l.listMonitors().map((m) => m.name)).toEqual(["keepme"]);
		l.close();
	});

	// qa n124: a relative argument spelled `@SCRIPTS@/…` must survive export -> apply unchanged.
	test("a relative argument spelled like a placeholder round-trips", () => {
		const l = ledger();
		const script = join(dir, "scripts", "s.sh");
		l.addMonitor(scriptSpec("lit", [script, "@SCRIPTS@/data.txt", "--out=@WORKSPACE@/x"]));
		const out = join(dir, "out");
		exportMonitors(l, out, ctx);
		const file = JSON.parse(readFileSync(join(out, "lit.json"), "utf8")) as { trigger: { command: string[] } };
		expect(file.trigger.command[0]).toBe("@SCRIPTS@/s.sh");
		const other = openMonitorLedger(join(dir, "other.db"));
		const home2 = join(dir, "h2");
		const ctx2 = { ...ctx, scriptsRoot: join(home2, "scripts"), workspaceDir: join(home2, "ws") };
		mkdirSync(ctx2.scriptsRoot, { recursive: true });
		writeFileSync(join(ctx2.scriptsRoot, "s.sh"), "#!/bin/sh\n", { mode: 0o755 });
		applyMonitors(other, out, ctx2);
		const stored = other.listMonitors()[0]?.trigger as { command: string[] };
		expect(stored.command).toEqual([join(home2, "scripts", "s.sh"), "@SCRIPTS@/data.txt", "--out=@WORKSPACE@/x"]);
		other.close();
		l.close();
	});

	// qa n125: an absolute path glued to an option is mapped (or warned about) like a whole-argument path.
	test("an absolute path glued to --opt= becomes a placeholder, an outside one warns", () => {
		const l = ledger();
		l.addMonitor(
			scriptSpec("opt", [
				join(dir, "scripts", "o.sh"),
				`--out=${join(dir, "workspace", "report.txt")}`,
				"--tmp=/var/elsewhere/x",
			]),
		);
		const result = exportMonitors(l, join(dir, "out"), ctx);
		const file = JSON.parse(readFileSync(join(dir, "out", "opt.json"), "utf8")) as { trigger: { command: string[] } };
		expect(file.trigger.command).toEqual(["@SCRIPTS@/o.sh", "--out=@WORKSPACE@/report.txt", "--tmp=/var/elsewhere/x"]);
		expect(result.warnings.join("\n")).toContain("/var/elsewhere/x");
		l.close();
	});

	// qa n64: a workspace-relative procedure file that leads into the scripts dir is exported as a placeholder.
	test("a relative procedureFile pointing into the scripts dir is folded to @SCRIPTS@", () => {
		const l = ledger();
		writeFileSync(join(dir, "scripts", "steps.md"), "steps\n");
		l.addMonitor(
			parseMonitorSpec(
				{
					name: "proc",
					trigger: { kind: "cron", schedule: "0 9 * * *" },
					instruction: "i",
					procedureFiles: ["../scripts/steps.md"],
				},
				ctx,
			),
		);
		const out = join(dir, "out");
		exportMonitors(l, out, ctx, { withFiles: true });
		const file = JSON.parse(readFileSync(join(out, "proc.json"), "utf8")) as { procedureFiles: string[] };
		expect(file.procedureFiles).toEqual(["@SCRIPTS@/steps.md"]);
		const other = openMonitorLedger(join(dir, "other.db"));
		const ctx2 = { ...ctx, scriptsRoot: join(dir, "h2", "scripts"), workspaceDir: join(dir, "h2", "data", "cwd") };
		mkdirSync(ctx2.scriptsRoot, { recursive: true });
		mkdirSync(ctx2.workspaceDir, { recursive: true });
		writeFileSync(join(ctx2.scriptsRoot, "steps.md"), "steps\n");
		expect(applyMonitors(other, out, ctx2).added).toBe(1);
		other.close();
		l.close();
	});
});

describe("monitors test wake gate (qa-j)", () => {
	let home: TestHome;
	beforeEach(() => {
		home = makeHome("jabbu-monitors-qa-j-cli-");
		mkdirSync(join(home.dir, "scripts"));
	});
	afterEach(() => home.remove());

	// qa n65: the scheduler drops a check whose last stdout line is {"wakeAgent": false}; a manual fire must too.
	test("a script whose last line is the wake gate does not create an event", async () => {
		const script = join(home.dir, "scripts", "gate.sh");
		writeFileSync(script, "#!/bin/sh\necho quiet\necho '{\"wakeAgent\": false}'\n");
		chmodSync(script, 0o755);
		const added = await runCliCapture(home.dir, [
			"monitors",
			"add",
			"--json",
			JSON.stringify({
				name: "gate",
				trigger: { kind: "script", command: [script], intervalMs: 60_000 },
				instruction: "i",
			}),
		]);
		expect(added.code).toBe(0);
		const fired = await runCliCapture(home.dir, ["monitors", "test", "gate"]);
		expect(fired.code).toBe(0);
		expect(JSON.parse(fired.stdout)).toEqual({ fired: false, suppressed: "wake_gate" });
		const l = openMonitorLedger(join(home.dir, "jabbu.db"));
		expect(l.listEvents()).toHaveLength(0);
		l.close();
	});
});

describe("owner notice incidents (qa-j)", () => {
	// qa n69: with no owner destination the incident must not be consumed; the next failure after one exists alerts.
	test("a failure with nowhere to send it does not use up the incident", () => {
		let t = 1_700_000_000_000;
		const store = openStore({ timezone: "Asia/Seoul", path: join(dir, "store.db"), clock: { now: () => t }, redact });
		const mon = store.monitors.addMonitor(scriptSpec("m", [join(dir, "scripts", "t.sh")]));
		const failOnce = () => {
			t += 60_000;
			const { eventId } = store.monitors.admitManual(mon.id, "x");
			store.monitors.markDispatched(eventId, `monitor:${mon.id}:${eventId}:1`);
			return store.failMonitorEvent(eventId, "[turn failed] boom", { retry: false });
		};
		expect(store.ownerHome()).toBeUndefined();
		expect(failOnce()).toBeUndefined();
		store.ensureOrigin(DM_ORIGIN, "sess/e1");
		store.recordInbound({
			originKey: DM_ORIGIN,
			platformMessageId: `${OWNER_DM}:1`,
			textRef: "hi",
			threadRef: `${OWNER_DM}:1`,
		});
		expect(store.ownerHome()).toBeDefined();
		expect(failOnce()?.body).toContain("failed_no_retry");
	});

	test("a check-error streak with nowhere to send it alerts once a destination exists", () => {
		let t = 1_700_000_000_000;
		const store = openStore({ timezone: "Asia/Seoul", path: join(dir, "store2.db"), clock: { now: () => t }, redact });
		const mon = store.monitors.addMonitor(scriptSpec("m2", [join(dir, "scripts", "t2.sh")]));
		const fail = () => {
			t += 60_000;
			store.monitors.recordCheckError(mon.id, "spawn EACCES");
		};
		for (let i = 0; i < 3; i++) fail();
		store.ensureOrigin(DM_ORIGIN, "sess/e1");
		store.recordInbound({
			originKey: DM_ORIGIN,
			platformMessageId: `${OWNER_DM}:1`,
			textRef: "hi",
			threadRef: `${OWNER_DM}:1`,
		});
		for (let i = 0; i < 3; i++) fail();
		const raw = new Database(join(dir, "store2.db"), { readonly: true });
		const rows = raw.query("SELECT body FROM deliveries").all() as Array<{ body: string }>;
		raw.close();
		expect(rows.map((r) => r.body).join("\n")).toContain("점검이");
	});
});
