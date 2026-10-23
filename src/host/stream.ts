/**
 * A structural implementation of the host's assistant event stream.
 *
 * Providers hand `streamSimple` an object the host consumes as an async
 * iterable of assistant events plus a `result()` promise. Implementing that
 * contract here instead of importing the host class keeps the plugin runnable
 * from a linked package with no runtime resolution of the host's own
 * dependencies, and it works identically under both OMP and PI.
 *
 * Semantics mirror the host's EventStream exactly:
 *   - a terminal event (`done`/`error`) settles `result()` and closes the stream,
 *     and is still delivered to consumers;
 *   - `end()` without a value settles `result()` with a rejection rather than
 *     leaving callers awaiting forever;
 *   - `fail()` rejects both the iterator and `result()`.
 */

import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";

export interface AssistantEventStream extends AsyncIterable<AssistantMessageEvent> {
	push(event: AssistantMessageEvent): void;
	/** Close the stream; without a final message `result()` rejects. */
	end(result?: AssistantMessage): void;
	fail(error: unknown): void;
	result(): Promise<AssistantMessage>;
	readonly hasPendingLocalWork: boolean;
	readonly localWorkSettledAt: number;
	trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork>;
	forwardLocalWorkFrom(source: AssistantEventStream | undefined): void;
}

interface Waiter {
	resolve: (value: IteratorResult<AssistantMessageEvent>) => void;
	reject: (error: unknown) => void;
}

function terminalResult(event: AssistantMessageEvent): AssistantMessage | null {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return null;
}

export function createAssistantEventStream(): AssistantEventStream {
	const queue: AssistantMessageEvent[] = [];
	const waiters: Waiter[] = [];
	let done = false;
	let failure: unknown;
	let resultSettled = false;
	let resolveResult: (value: AssistantMessage) => void = () => {};
	let rejectResult: (error: unknown) => void = () => {};
	let pendingLocalWork = 0;
	let settledAt = 0;
	let delegate: AssistantEventStream | undefined;

	const finalResult = new Promise<AssistantMessage>((resolve, reject) => {
		resolveResult = (value) => {
			if (resultSettled) return;
			resultSettled = true;
			resolve(value);
		};
		rejectResult = (error) => {
			if (resultSettled) return;
			resultSettled = true;
			reject(error);
		};
	});
	// The promise is inspected through result(); nothing else observes it early.
	finalResult.catch(() => {});

	const deliver = (event: AssistantMessageEvent): void => {
		const waiter = waiters.shift();
		if (waiter) waiter.resolve({ value: event, done: false });
		else queue.push(event);
	};

	return {
		push(event: AssistantMessageEvent): void {
			if (done) return;
			const result = terminalResult(event);
			if (result) {
				done = true;
				resolveResult(result);
			}
			deliver(event);
		},
		end(result?: AssistantMessage): void {
			if (done) return;
			done = true;
			if (result !== undefined) resolveResult(result);
			else if (!resultSettled) rejectResult(new Error("Zed stream ended without a final result"));
			for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
		},
		fail(error: unknown): void {
			if (done) return;
			done = true;
			failure = error;
			for (const waiter of waiters.splice(0)) waiter.reject(error);
			rejectResult(error);
		},
		async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
			for (;;) {
				const queued = queue.shift();
				if (queued) {
					yield queued;
					continue;
				}
				if (done) {
					if (failure !== undefined) throw failure;
					return;
				}
				const event = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
					waiters.push({ resolve, reject });
				});
				if (event.done) {
					if (failure !== undefined) throw failure;
					return;
				}
				yield event.value;
			}
		},
		result(): Promise<AssistantMessage> {
			return finalResult;
		},
		get hasPendingLocalWork(): boolean {
			return pendingLocalWork > 0 || (delegate?.hasPendingLocalWork ?? false);
		},
		get localWorkSettledAt(): number {
			return Math.max(settledAt, delegate?.localWorkSettledAt ?? 0);
		},
		trackLocalWork<TWork>(work: Promise<TWork>): Promise<TWork> {
			pendingLocalWork += 1;
			return work.finally(() => {
				pendingLocalWork -= 1;
				settledAt = Date.now();
			});
		},
		forwardLocalWorkFrom(source: AssistantEventStream | undefined): void {
			delegate = source;
		},
	};
}
