/** What the remote POSIX shell makes of one single-quoted ssh word (`remoteShellQuote`'s inverse; bare words pass through). */
export function unquoteRemote(word: string): string {
	return word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word;
}
