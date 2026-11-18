// Counting semaphore that bounds how many subagent runs execute at once.

export class Semaphore {
	private limit: number;
	private held = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(limit: number) {
		this.limit = limit;
	}

	/** Resolve when a permit is held. The holder must call `release` exactly once. */
	acquire(): Promise<void> {
		if (this.held < this.limit) {
			this.held++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Return a permit; the longest waiter gets it if the limit allows. */
	release(): void {
		this.held--;
		this.grant();
	}

	/** Change the limit. A higher one starts waiters at once; a lower one lets current holders finish. */
	setLimit(limit: number): void {
		this.limit = limit;
		this.grant();
	}

	private grant(): void {
		while (this.held < this.limit && this.waiters.length > 0) {
			this.held++;
			this.waiters.shift()?.();
		}
	}
}
