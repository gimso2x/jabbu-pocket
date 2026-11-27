/** Epoch ms of an ISO timestamp, `undefined` when it does not parse. */
export function parseIsoMs(text: string): number | undefined {
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms;
}
