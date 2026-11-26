import { describe, expect, test } from "bun:test";
import { answerFooter, finishDeliveryStatus } from "../src/channel/pump";
import type { DeliveryItem } from "../src/channel/types";

const THREAD = "200000000000000001:700000000000000001";
const ORIGIN = "discord/dm/200000000000000001";

function item(body: string, extra: Partial<DeliveryItem> = {}): DeliveryItem {
	return { deliveryId: 1, originKey: ORIGIN, threadRef: THREAD, body, redelivered: false, ...extra };
}

/** The notice a peer-opened turn's failure posts (mailbox-notices `failedNotice` with a peer). */
const PEER_NOTICE =
	"<@111000000000000000> <@222000000000000000> 응답 실패(omp_exited code=137) — 다시 요청하거나 직접 검토해 주세요";
/** The same notice before `renderMentions` (no thread source at hand): raw mention tokens. */
const PEER_NOTICE_RAW =
	"{{mention:111000000000000000}} {{mention:222000000000000000}} 응답 실패(omp_exited code=137) — 다시 요청하거나 직접 검토해 주세요";

describe("a peer-opened turn's failure notice finishes the thread status as failed, not done", () => {
	test("answerFooter classifies rendered and raw peer failure notices as failed", () => {
		for (const body of [PEER_NOTICE, PEER_NOTICE_RAW]) {
			let outcome: string | undefined;
			answerFooter(item(body), (_ref, _origin, o) => {
				outcome = o;
				return undefined;
			});
			expect(outcome).toBe("failed");
		}
	});

	test("finishDeliveryStatus marks a peer failure notice's thread failed (delete), like an owner failure", async () => {
		const finished: string[] = [];
		const finisher = {
			finishStatus: async (threadRef: string, _originKey: string, outcome: string, action: string) => {
				finished.push(`${threadRef}:${outcome}:${action}`);
			},
		};
		await finishDeliveryStatus(item(PEER_NOTICE), "sent", finisher);
		expect(finished).toEqual([`${THREAD}:failed:delete`]);
	});

	test("an answer merely quoting the failure mark later in the body is still done", async () => {
		const quoting = item('이전 로그에서 "응답 실패(500)"가 보이면 이렇게 하세요.');
		let outcome: string | undefined;
		answerFooter(quoting, (_ref, _origin, o) => {
			outcome = o;
			return undefined;
		});
		expect(outcome).toBe("done");
		const finished: string[] = [];
		await finishDeliveryStatus(quoting, "sent", {
			finishStatus: async (threadRef: string, _originKey: string, o: string, action: string) => {
				finished.push(`${threadRef}:${o}:${action}`);
			},
		});
		expect(finished).toEqual([`${THREAD}:done:delete`]);
	});

	test("the owner-shaped notice keeps its failed classification; undelivered still wins over both", async () => {
		const owner = item("[turn failed] omp_exited code=137 — 다시 보내 주세요");
		let outcome: string | undefined;
		answerFooter(owner, (_ref, _origin, o) => {
			outcome = o;
			return undefined;
		});
		expect(outcome).toBe("failed");
		const finished: string[] = [];
		await finishDeliveryStatus(item(PEER_NOTICE), "undelivered", {
			finishStatus: async (threadRef: string, _originKey: string, o: string, action: string) => {
				finished.push(`${threadRef}:${o}:${action}`);
			},
		});
		expect(finished).toEqual([`${THREAD}:undelivered:update`]);
	});
});
