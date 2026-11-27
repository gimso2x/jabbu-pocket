import { chmodSync, copyFileSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { secretInodes } from "../ops/backup-tree";
import { clearWriteTarget, isOutside } from "./portable-files";

export interface PortableCopyTarget {
	target: string;
	name: string;
	root: string;
}

/**
 * Replaces `<dir>/files/{scripts,workspace}` and copies every referenced script and procedure file that stays inside
 * its root, outside `secrets/` (including hard links to `secrets/`), and preserves mode bits.
 */
export function copyPortableFiles(input: {
	scriptsRoot: string;
	filesRoots: Record<string, string>;
	copies: ReadonlyMap<string, PortableCopyTarget>;
	warnings: string[];
}): void {
	const { scriptsRoot, filesRoots, copies, warnings } = input;
	const secretsPath = join(dirname(scriptsRoot), "secrets");
	let secretsDir = secretsPath;
	try {
		secretsDir = realpathSync(secretsPath);
	} catch {
		// No secrets directory: nothing can resolve into it, and the spelled path still matches.
	}
	// Copies of monitors that are gone (or no longer name the file) must not outlive them in the committed directory.
	for (const filesRoot of Object.values(filesRoots)) rmSync(filesRoot, { recursive: true, force: true });
	const secrets = secretInodes(secretsDir);
	for (const [source, { target, name, root }] of copies) {
		// The path is under its root as spelled; a symlink on the way may still lead out (`<workspace>/p.md -> /etc/…`),
		// so the copy goes by where it really leads. A dangling link reads as not found.
		let real: string;
		let mode: number;
		try {
			real = realpathSync(source);
			if (isOutside(relative(realpathSync(root), real))) {
				warnings.push(`${name}: referenced file resolves outside ${root}, not copied: ${source}`);
				continue;
			}
			// A workspace that falls back to the home (no usable config) would otherwise copy the bot's tokens out.
			if (!isOutside(relative(secretsDir, real))) {
				warnings.push(`${name}: referenced file is in the secrets directory, not copied: ${source}`);
				continue;
			}
			const stat = statSync(real);
			if (!stat.isFile()) continue;
			// A hard link under a root shares the secret's inode: no path check sees it.
			if (stat.nlink > 1 && secrets.has(`${stat.dev}:${stat.ino}`)) {
				warnings.push(`${name}: referenced file is a hard link to a secrets/ file, not copied: ${source}`);
				continue;
			}
			mode = stat.mode & 0o7777;
		} catch {
			warnings.push(`referenced file not found, not copied: ${source}`);
			continue;
		}
		try {
			mkdirSync(dirname(target), { recursive: true });
			clearWriteTarget(target);
			copyFileSync(real, target);
			chmodSync(target, mode);
		} catch (error) {
			warnings.push(
				`${name}: referenced file not copied: ${source} (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
}
