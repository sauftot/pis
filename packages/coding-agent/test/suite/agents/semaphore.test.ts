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

	it("starts waiters when the limit rises, and lets holders finish when it falls", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		let started = 0;
		const waiting = [semaphore.acquire(), semaphore.acquire()].map((p) => p.then(() => started++));
		semaphore.setLimit(3);
		await Promise.all(waiting);
		expect(started).toBe(2);

		// Three held, limit now 1: two releases free nothing, the third makes room for one more.
		semaphore.setLimit(1);
		let next = false;
		void semaphore.acquire().then(() => {
			next = true;
		});
		semaphore.release();
		semaphore.release();
		await Promise.resolve();
		expect(next).toBe(false);
		semaphore.release();
		await Promise.resolve();
		expect(next).toBe(true);
	});

	it("returns an unused permit to the pool", async () => {
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		semaphore.release();
		await semaphore.acquire();
	});
});
