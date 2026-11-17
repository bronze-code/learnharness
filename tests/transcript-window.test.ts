import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	TRANSCRIPT_CHUNK_PARTS,
	TRANSCRIPT_TAIL_PARTS,
	initialHiddenParts,
	nextHiddenParts,
	transcriptOffsets,
	transcriptPartCount,
} from "../components/transcript-window.ts";

const message = (parts: number) => ({ parts: Array.from({ length: parts }, () => ({})) });

describe("transcript window", () => {
	it("mounts a short transcript whole", () => {
		assert.equal(initialHiddenParts([]), 0);
		assert.equal(initialHiddenParts([message(3), message(1), message(TRANSCRIPT_TAIL_PARTS)]), 0);
		assert.equal(initialHiddenParts([message(TRANSCRIPT_TAIL_PARTS * 2)]), 0);
	});

	it("leaves only the tail of a long transcript for the first paint", () => {
		const messages = [message(40), message(1), message(38), message(5)];
		const total = transcriptPartCount(messages);
		assert.equal(total, 84);
		assert.equal(initialHiddenParts(messages), total - TRANSCRIPT_TAIL_PARTS);
	});

	it("counts an empty message as one slot so it is revealed like any other", () => {
		const messages = [message(0), message(2), message(0)];
		assert.deepEqual(transcriptOffsets(messages), [0, 1, 3]);
		assert.equal(transcriptPartCount(messages), 4);
	});

	it("walks back to zero in bounded steps and stays there", () => {
		let hidden = initialHiddenParts([message(100)]);
		let steps = 0;
		while (hidden > 0) {
			const next = nextHiddenParts(hidden);
			assert.ok(next < hidden && hidden - next <= TRANSCRIPT_CHUNK_PARTS);
			hidden = next;
			steps++;
		}
		assert.equal(steps, Math.ceil((100 - TRANSCRIPT_TAIL_PARTS) / TRANSCRIPT_CHUNK_PARTS));
		assert.equal(nextHiddenParts(0), 0);
	});

	it("places the window edge inside a long block by part offset", () => {
		const messages = [message(10), message(30), message(4)];
		const offsets = transcriptOffsets(messages);
		const hidden = initialHiddenParts(messages); // 44 - 12 = 32
		assert.equal(hidden, 32);
		// message 0 is wholly above the window, message 1 is cut at its part 22.
		assert.ok(offsets[0]! + 10 <= hidden);
		assert.ok(offsets[1]! + 21 < hidden && offsets[1]! + 22 >= hidden);
		assert.ok(offsets[2]! >= hidden);
	});
});
