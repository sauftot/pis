import { describe, expect, it } from "vitest";
import { Semaphore } from "../../../src/core/agents/index.ts";

describe("Semaphore", () => {
	it("grants permits up to its limit without waiting", async () => {
		const semaphore = new Semaphore(2);
		await semaphore.acquire();
		await semaphore.acquire();
	});

	it("makes a further acquire wait until a release, in arrival order", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const order: string[] = [];
		const first = semaphore.acquire().then(() => order.push("first"));
		const second = semaphore.acquire().then(() => order.push("second"));

		await Promise.resolve();
		expect(order).toEqual([]);
		semaphore.release();
		await first;
		expect(order).toEqual(["first"]);
		semaphore.release();
		await second;
		expect(order).toEqual(["first", "second"]);
	});

	it("returns an unused permit to the pool", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		semaphore.release();
		await semaphore.acquire();
	});
});
