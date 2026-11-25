import { describe, expect, test } from "bun:test";
import { NamespacedDriver } from "../src/daemon/opref";
import type { OmpEvent } from "../src/omp/driver";
import { FakeOmpDriver } from "../src/omp/fake-driver";

describe("NamespacedDriver", () => {
	test("events carry the namespaced opRef, so a consumer can match them to the turn prompt() opened", async () => {
		const inner = new FakeOmpDriver({
			events: [
				{ type: "tail_wait_start", opRef: "fake_req_1" },
				{ type: "message_start" },
				{ type: "tail_wait_end", opRef: "fake_req_1" },
			],
		});
		const driver = new NamespacedDriver(inner, "lane-7");
		const seen: OmpEvent[] = [];
		driver.onEvent((event) => seen.push(event));
		const finals = Promise.withResolvers<void>();
		driver.onFinal(() => finals.resolve());
		await driver.start();
		const opRef = await driver.prompt("작업해줘");
		await finals.promise;
		// The mailbox's tail-wait match compares the event's opRef with the turn's: they must be the same string.
		expect(opRef).toBe("lane-7:fake_req_1");
		expect(seen.filter((event) => event.type.startsWith("tail_wait"))).toEqual([
			{ type: "tail_wait_start", opRef: "lane-7:fake_req_1" },
			{ type: "tail_wait_end", opRef: "lane-7:fake_req_1" },
		]);
		// An event without an opRef passes through untouched.
		expect(seen.find((event) => event.type === "message_start")).toEqual({ type: "message_start" });
		await driver.stop();
	});
});
