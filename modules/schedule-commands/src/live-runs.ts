/**
 * In-memory live copies of the runs in flight (a shell job's output tail, an agent job's conversation) for the Jobs
 * overlay. Presentation only: nothing is written, parsed for state or sent to a model, and a copy is released the
 * moment its run ends, so it lives exactly as long as the run.
 */
import type { TranscriptSource } from "../../../shared/src/background/index.js";

export class LiveRuns {
	readonly #copies = new Map<string, TranscriptSource>();
	/** Called when a copy appears or goes away, so the panel can show or drop the "live" detail. */
	constructor(private readonly changed: () => void = () => {}) {}

	get(jobId: string): TranscriptSource | undefined {
		const copy = this.#copies.get(jobId);
		return copy && !copy.isReleased ? copy : undefined;
	}

	set(jobId: string, copy: TranscriptSource): void {
		this.#copies.get(jobId)?.release();
		this.#copies.set(jobId, copy);
		this.#notify();
	}

	/** Drops the copy of a run; only the given copy is removed, so a newer run of the same job is untouched. */
	release(jobId: string, copy: TranscriptSource): void {
		copy.release();
		if (this.#copies.get(jobId) === copy) this.#copies.delete(jobId);
		this.#notify();
	}

	releaseAll(): void {
		for (const copy of this.#copies.values()) copy.release();
		this.#copies.clear();
	}

	#notify(): void {
		try { this.changed(); } catch { /* display only */ }
	}
}
