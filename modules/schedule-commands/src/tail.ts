/** Keeps the last `limit` bytes of a byte stream without ever holding more than about twice that. */
export class TailBuffer {
	#chunks: Buffer[] = [];
	#size = 0;
	#cut = false;
	constructor(readonly limit: number) {}

	push(data: Buffer): void {
		this.#chunks.push(data);
		this.#size += data.length;
		if (this.#size > this.limit * 2) {
			const all = Buffer.concat(this.#chunks);
			this.#chunks = [all.subarray(all.length - this.limit)];
			this.#size = this.limit;
			this.#cut = true;
		}
	}

	/** The retained tail as text; a cut that lands inside a multi-byte character drops the partial bytes. */
	text(): string {
		let all = Buffer.concat(this.#chunks);
		if (all.length > this.limit) { all = all.subarray(all.length - this.limit); this.#cut = true; }
		let start = 0;
		if (this.#cut) while (start < all.length && start < 4 && (all[start] & 0xc0) === 0x80) start++;
		return all.subarray(start).toString("utf8").trim();
	}
}
