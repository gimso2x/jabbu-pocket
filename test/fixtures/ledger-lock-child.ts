// A second jabbu process holding the tasks ledger's write lock, the way a WAL recovery (or another writer) does while
// the owner's CLI is opening the file. usage: bun ledger-lock-child.ts <db> <holdMs>; prints "locked" once held.
import { Database } from "bun:sqlite";

const [path, holdMs] = process.argv.slice(2) as [string, string];
const db = new Database(path, { strict: true });
db.run("PRAGMA busy_timeout = 5000");
db.run("BEGIN EXCLUSIVE");
console.log("locked");
// The opener is inside sqlite's own busy wait, so it cannot say when it got there: hold the lock until this bound ends.
// It only has to outlast the opener's spawn-to-lock gap (microseconds once its "locked" line is read); holding longer
// never weakens the check, because a failure is the opener giving up on the lock, not the holder releasing it.
const until = Date.now() + Number(holdMs);
// sleep-ok: a lock holder has no event to subscribe to; the bound is the release
while (Date.now() < until) Bun.sleepSync(5);
db.run("ROLLBACK");
db.close();
