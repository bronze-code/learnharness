"use client";

import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Tail-first transcript mounting.
 *
 * Opening a long session used to build the entire transcript in one
 * synchronous render: a 179-message record is ~290 parts / ~54k DOM nodes,
 * which cost ~2s of server render plus ~5s of main-thread work on every
 * switch (markdown, math and code highlighting are re-run per part). The
 * reader lands at the BOTTOM, so the newest parts are the only ones that
 * must exist for the first paint.
 *
 * The window is a count of leading PARTS that are not mounted yet. It starts
 * just above the tail and walks back to zero in idle slices, so the whole
 * transcript is in the DOM shortly after — find, anchors and citations read
 * the same markup as before. Anything that needs older content immediately
 * (a #hash arrival, opening find) reveals everything at once.
 */

/** Parts mounted for the first paint (roughly two screens of lesson). */
export const TRANSCRIPT_TAIL_PARTS = 12;
/** Parts added per idle slice while the history fills in. */
export const TRANSCRIPT_CHUNK_PARTS = 8;

/** Idle slices wait this long after the reader's last click or key. */
const INPUT_QUIET_MS = 1000;

type Weighted = { readonly parts: readonly unknown[] };

/** Part offset of each message: offsets[i] = parts before message i. */
export function transcriptOffsets(messages: readonly Weighted[]): number[] {
	const offsets: number[] = [];
	let total = 0;
	for (const message of messages) {
		offsets.push(total);
		// An empty message still occupies a slot so it is never skipped forever.
		total += Math.max(1, message.parts.length);
	}
	return offsets;
}

export function transcriptPartCount(messages: readonly Weighted[]): number {
	let total = 0;
	for (const message of messages) total += Math.max(1, message.parts.length);
	return total;
}

/** Leading parts left unmounted on the first render. Short transcripts mount
 * whole: windowing them only adds a second commit. */
export function initialHiddenParts(messages: readonly Weighted[]): number {
	const total = transcriptPartCount(messages);
	return total <= TRANSCRIPT_TAIL_PARTS * 2 ? 0 : total - TRANSCRIPT_TAIL_PARTS;
}

export function nextHiddenParts(hidden: number): number {
	return hidden <= TRANSCRIPT_CHUNK_PARTS ? 0 : hidden - TRANSCRIPT_CHUNK_PARTS;
}

type IdleHandle = { cancel: () => void };

function whenIdle(run: () => void): IdleHandle {
	if (typeof window.requestIdleCallback === "function") {
		const id = window.requestIdleCallback(run, { timeout: 250 });
		return { cancel: () => window.cancelIdleCallback(id) };
	}
	const id = window.setTimeout(run, 32);
	return { cancel: () => window.clearTimeout(id) };
}

export function useTranscriptWindow(
	messages: readonly Weighted[],
	/** The transcript scroller, read lazily (its ref attaches after mount). */
	getScroller: () => HTMLElement | null,
	/** Window events that need the whole transcript at once (e.g. find). */
	revealEvents: readonly string[],
): { hidden: number; offsets: number[] } {
	const [hidden, setHidden] = useState(() => initialHiddenParts(messages));
	const getScrollerRef = useRef(getScroller);
	getScrollerRef.current = getScroller;
	// Scroll geometry read in the render that shrinks the window (the DOM is
	// still the previous commit there) and restored once the prepend commits.
	// Reading it at render, not when the slice was scheduled, keeps a scroll
	// made while the transition was pending.
	const snapshot = useRef<{ top: number; height: number } | null>(null);
	const committedHidden = useRef(hidden);
	if (hidden !== committedHidden.current && typeof window !== "undefined") {
		const scroller = getScrollerRef.current();
		snapshot.current = scroller ? { top: scroller.scrollTop, height: scroller.scrollHeight } : null;
	}

	// Older content mounts ABOVE the viewport: keep what the reader sees
	// still by moving the scroller down by exactly the height that was added.
	useLayoutEffect(() => {
		const before = snapshot.current;
		snapshot.current = null;
		committedHidden.current = hidden;
		const scroller = getScrollerRef.current();
		if (!before || !scroller) return;
		const top = before.top + (scroller.scrollHeight - before.height);
		if (Math.abs(scroller.scrollTop - top) > 0.5) scroller.scrollTop = top;
	}, [hidden]);

	// A #hash arrival targets a passage that may sit above the tail.
	useLayoutEffect(() => {
		if (window.location.hash) setHidden(0);
	}, []);

	const revealKey = revealEvents.join("\n");
	useEffect(() => {
		const reveal = () => setHidden(0);
		const events = ["hashchange", "popstate", ...revealKey.split("\n").filter(Boolean)];
		for (const type of events) window.addEventListener(type, reveal);
		return () => {
			for (const type of events) window.removeEventListener(type, reveal);
		};
	}, [revealKey]);

	// Fill the history in idle slices. A transition keeps each slice
	// interruptible; a slice is also postponed right after a click or key so
	// it never competes with what the reader just asked for — a navigation
	// started from this page is itself a transition and would otherwise
	// re-render alongside every slice of the session being left.
	const lastInput = useRef(0);
	useEffect(() => {
		const stamp = () => {
			lastInput.current = performance.now();
		};
		const events = ["pointerdown", "click", "keydown"] as const;
		for (const type of events) window.addEventListener(type, stamp, { capture: true, passive: true });
		return () => {
			for (const type of events) window.removeEventListener(type, stamp, { capture: true });
		};
	}, []);
	useEffect(() => {
		if (hidden === 0) return;
		let handle: IdleHandle;
		const slice = () => {
			const quietFor = performance.now() - lastInput.current;
			if (quietFor < INPUT_QUIET_MS) {
				const id = window.setTimeout(() => {
					handle = whenIdle(slice);
				}, INPUT_QUIET_MS - quietFor);
				handle = { cancel: () => window.clearTimeout(id) };
				return;
			}
			startTransition(() => setHidden(nextHiddenParts));
		};
		handle = whenIdle(slice);
		return () => handle.cancel();
	}, [hidden]);

	return { hidden, offsets: transcriptOffsets(messages) };
}
