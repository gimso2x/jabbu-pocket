// Second process for deliveries-cross-process.test.ts: writes to the same ledger file (as the daemon does all day)
// until the stop file appears, then prints how many rows it wrote.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const [path, stopFile] = process.argv.slice(2) as [string, string];
const db = new Database(path, { strict: true });
db.run("PRAGMA busy_timeout = 5000");
db.run("CREATE TABLE IF NOT EXISTS cross_process_noise (x INTEGER)");
const insert = db.query("INSERT INTO cross_process_noise VALUES (?)");
console.log("ready");
let n = 0;
while (!existsSync(stopFile)) {
	insert.run(n++);
	// sleep-ok: cross-process writer fixture pauses 1ms per burst so the other process can acquire the lock
	if (n % 4 === 0) Bun.sleepSync(1);
}
console.log(`wrote ${n}`);
