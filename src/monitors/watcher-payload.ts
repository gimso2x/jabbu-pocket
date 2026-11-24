/**
 * The payload of one watcher event: up to `max` changed paths, one per line, then a line counting the rest. A path's
 * control characters (a newline in a file name) are written as \u escapes so one path stays one line.
 */
export function watchPayload(paths: readonly string[], overflow: number, uncounted: number, max: number): string {
	const lines = paths
		.slice(0, max)
		.map((path) =>
			path.replace(
				/[\p{Cc}\u2028\u2029]/gu,
				(char) => `\\u${(char.codePointAt(0) as number).toString(16).padStart(4, "0")}`,
			),
		);
	const more = paths.length + overflow - lines.length;
	if (uncounted > 0) lines.push(`… and at least ${more + 1} more`);
	else if (more > 0) lines.push(`… and ${more} more`);
	return lines.join("\n");
}
