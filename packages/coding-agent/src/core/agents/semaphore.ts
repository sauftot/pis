// Counting semaphore that bounds how many subagent runs execute at once.

export class Semaphore {
	private permits: number;
	private readonly waiters: Array<() => void> = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	/** Resolve when a permit is held. The holder must call `release` exactly once. */
	acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Hand the permit to the longest waiter, or return it to the pool. */
	release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.permits++;
	}
}
