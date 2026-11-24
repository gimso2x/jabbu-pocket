// Request-sharing and reply-shape helpers of the dashboard snapshot build (moved out of snapshot.ts to keep it lean;
// both are snapshot-internal, nothing else imports them).

import type { StatusReport } from "../daemon/status";

/** GETs of one URL inside one snapshot share one request (the board's `/api/machines` once for every TASK link). */
export function sharedFetch(fetcher: typeof fetch): typeof fetch {
	const calls = new Map<string, Promise<Response>>();
	return ((input: string | URL | Request, init?: RequestInit) => {
		const key = input instanceof Request ? input.url : String(input);
		let call = calls.get(key);
		if (call === undefined) {
			call = fetcher(input, init);
			calls.set(key, call);
		}
		return call.then((response) => response.clone());
	}) as typeof fetch;
}

export function isStatusResponse(value: unknown): value is { ok: true; status: StatusReport } {
	return typeof value === "object" && value !== null && "ok" in value && value.ok === true && "status" in value;
}
