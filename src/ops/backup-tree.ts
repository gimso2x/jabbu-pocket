import { existsSync, lstatSync, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { BackupError } from "./backup-error";

/** `dev:ino` of every regular file under `secrets/`, a symlinked token resolved to its real file (a missing directory has none). */
export function secretInodes(secretsReal: string): Set<string> {
	const inodes = new Set<string>();
	if (!existsSync(secretsReal)) return inodes;
	const stack = [secretsReal];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const stat = lstatSync(join(dir, entry.name));
			if (stat.isDirectory()) stack.push(join(dir, entry.name));
			else if (stat.isFile()) inodes.add(`${stat.dev}:${stat.ino}`);
			else if (stat.isSymbolicLink()) {
				// A link's own inode is not the token's: a hard link in a source shares the link target's inode.
				const target = statSync(join(dir, entry.name), { throwIfNoEntry: false });
				if (target?.isFile()) inodes.add(`${target.dev}:${target.ino}`);
			}
		}
	}
	return inodes;
}

/** A hard-linked regular file that shares its inode with a secret would carry the token's bytes into the tar. */
export function refuseSecretHardLink(stat: Stats, name: string, secrets: Set<string>): void {
	if (stat.isFile() && stat.nlink > 1 && secrets.has(`${stat.dev}:${stat.ino}`)) {
		throw new BackupError("bundle_failed", `${name} is a hard link to a secrets/ file`);
	}
}

/** On-disk size of a directory tree (symlinks count as their own link size, never their target). */
export function treeBytes(root: string, label: string, secrets: Set<string>): number {
	let total = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const stat = lstatSync(path);
			refuseSecretHardLink(stat, `${label}${path.slice(root.length)}`, secrets);
			if (stat.isDirectory()) stack.push(path);
			else total += stat.size;
		}
	}
	return total;
}
