// 데몬 기동 시 남은 `sending`·`uncertain` 행 중 세션 저널로 도구 미호출 실패가 증명되는 항목을 안전 종료한다.
import { type DriverFactory, openOriginSession, sessionToResume } from "../core/mailbox-types";
import { closeToolFreeRow, proveToolFreeFailure, tryCloseToolFreeFromFile } from "../core/tool-free-recovery";
import { promptTextOf } from "../core/types";
import type { Logger } from "../log";
import type { OmpSessionDriver } from "../omp/driver";
import type { Store } from "../store/db";
import type { InboundRow } from "../store/db-rows";

export interface BootToolFreeDeps {
	store: Store;
	driverFactory: DriverFactory;
	log: Logger;
}

/**
 * 기동 복구 단계에서 `sending` 행과 커서가 있는 `uncertain` 행을 세션 저널과 대조해 도구 미호출 실패를 닫는다.
 * 디스크 `.jsonl` 파일을 먼저 확인해 불필요한 자식 프로세스 기동을 피하고, 파일이 없을 때만 `sending` 행용 드라이버를 연다.
 */
export async function settleBootToolFreeRows(deps: BootToolFreeDeps): Promise<number> {
	const { store, log } = deps;
	const sending = store.listInbound({ state: "sending" });
	const uncertain = store.listInbound({ state: "uncertain" }).filter((row) => row.entryCursor !== null);
	if (sending.length === 0 && uncertain.length === 0) return 0;

	const byOrigin = new Map<string, InboundRow[]>();
	for (const row of [...sending, ...uncertain]) {
		const list = byOrigin.get(row.originKey) ?? [];
		list.push(row);
		byOrigin.set(row.originKey, list);
	}

	let closed = 0;
	for (const [originKey, rows] of byOrigin) {
		const origin = store.getOrigin(originKey);
		if (origin === undefined) continue;
		const sessionFile = sessionToResume(origin);
		const unresolvedSending: InboundRow[] = [];

		for (const row of rows) {
			const stage = row.state === "sending" ? "boot_sending" : "boot_uncertain";
			if (tryCloseToolFreeFromFile(store, log, row, sessionFile, stage) !== undefined) {
				closed += 1;
			} else if (row.state === "sending" && sessionFile === undefined && row.entryCursor !== null) {
				unresolvedSending.push(row);
			}
		}

		if (unresolvedSending.length === 0) continue;
		let driver: OmpSessionDriver | undefined;
		try {
			driver = deps.driverFactory(originKey, origin.sessionDir);
			await driver.start();
			await openOriginSession(driver, origin, sessionFile);
			for (const row of unresolvedSending) {
				if (row.entryCursor === null) continue;
				const { entries } = await driver.entriesSince(row.entryCursor);
				const proof = proveToolFreeFailure(entries, promptTextOf(row.textRef));
				if (proof !== undefined && closeToolFreeRow(store, log, row, proof, "boot_sending")) {
					closed += 1;
				}
			}
		} catch (error) {
			log.warn("recovery_tool_free_failed", { origin: originKey, error: String(error) });
		} finally {
			await driver?.stop().catch(() => undefined);
		}
	}
	return closed;
}
