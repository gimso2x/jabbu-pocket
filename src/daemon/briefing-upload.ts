// The briefing render/upload tail of `Daemon#brief`, kept apart so `daemon.ts` stays under its LOC baseline.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorFields } from "../channel/error-fields";
import type { ChannelPort, PostTarget } from "../channel/port";
import type { JabbuConfig } from "../config";
import { briefingFileName, briefingSummaryLine, renderBriefingHtml } from "../dashboard/briefing";
import type { DashboardSnapshot } from "../dashboard/snapshot";
import type { ProcessRunner } from "../dispatch/omp";
import type { Logger } from "../log";
import { BRIEFING_TIMEOUT_MS, BRIEFING_WIDTH, renderPng } from "../ops/screenshot";
import { localIso } from "../time";

export interface BriefingUploadDeps {
	config: JabbuConfig;
	snapshot: DashboardSnapshot;
	route: { port: ChannelPort; target: PostTarget };
	now: number;
	originKey: string;
	isDiscarded?: (() => boolean) | undefined;
	log: Logger;
	run?: ProcessRunner | undefined;
}

/** Renders the briefing PNG, uploads it unless `isDiscarded()` fired mid-render, and always deletes the file. */
export async function uploadBriefing(deps: BriefingUploadDeps): Promise<void> {
	const { config, snapshot, route, now, originKey, isDiscarded, log } = deps;
	const dir = join(config.homeDir, "media", "briefing");
	mkdirSync(dir, { recursive: true });
	// `<YYYYMMDD-HHmmss in the bot's zone>-<suffix>`: the suffix is per render, so two briefings in the same second never collide.
	const out = join(dir, `${briefingFileName(now, config.timezone)}-${randomUUID().slice(0, 8)}.png`);
	const startedAt = Date.now();
	const size = await renderPng(renderBriefingHtml(snapshot, now), out, {
		chromium: config.briefing?.chromium ?? "chromium",
		width: BRIEFING_WIDTH,
		timeoutMs: BRIEFING_TIMEOUT_MS,
		...(deps.run === undefined ? {} : { run: deps.run }),
	});
	// A `!new` during the render discards the row: skip the upload, so the old epoch's picture never lands (the
	// render file stays for the hourly media sweep's 24h retention to collect).
	if (isDiscarded?.() === true) {
		log.info("briefing_discarded", { origin: originKey });
		return;
	}
	await route.port.uploadFile(route.target, {
		path: out,
		title: `jabbu 브리핑 ${localIso(now, config.timezone).slice(11, 16)}`,
		comment: briefingSummaryLine(snapshot),
	});
	// The PNG is only needed until the upload completes: delete it now (best effort) instead of leaving one file per
	// render for the hourly media sweep's 24h retention to collect.
	try {
		rmSync(out, { force: true });
	} catch (error) {
		log.warn("briefing_file_delete_failed", { origin: originKey, ...errorFields(error) });
	}
	log.info("briefing_rendered", { origin: originKey, ms: Date.now() - startedAt, height: size.height });
}
