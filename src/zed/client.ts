/**
 * HTTP transport for Zed's cloud API.
 *
 * One request per upstream call: `POST /completions` answers HTTP 200 with a
 * newline-delimited JSON body that never closes on its own — the
 * `{"status":"stream_ended"}` marker ends it, so the reader is cancelled at
 * that point instead of waiting for a body that will not finish.
 *
 * Failures reach this layer in two shapes, both normalized into
 * {@link ZedHttpError}: a non-2xx status with a plain-text body, or HTTP 200
 * carrying a `{"status":{"failed":{...}}}` line.
 */

import { asRecord } from "../json.ts";
import { COMPLETIONS_URL, MODELS_URL, USER_INFO_URL, completionsHeaders, modelsHeaders, tokenHeaders } from "./constants.ts";
import { currentClientVersion, noteMinimumVersion, resolveClientVersion } from "./clientVersion.ts";
import { wireRequest, type WireResponse } from "./http.ts";
import { resolveSystemId } from "./system.ts";
import { createLineSplitter, parseZedLine, type ZedDelta } from "./wire.ts";

export class ZedHttpError extends Error {
	override readonly name = "ZedHttpError";
	readonly status: number;
	readonly body: string;
	/** Set when the body named a plan restriction: the model is unavailable, the account is fine. */
	readonly planRestricted: boolean;

	constructor(status: number, body: string) {
		super(`Zed upstream responded HTTP ${status}: ${body.slice(0, 300)}`);
		this.status = status;
		this.body = body;
		this.planRestricted = status === 403 && body.includes("plan");
	}
}

/** Upstream calls the provider needs; injectable so tests can stub Zed's cloud. */
export interface ZedTransport {
	completions(jwt: string, body: unknown, signal?: AbortSignal): Promise<WireResponse>;
	models(jwt: string, signal?: AbortSignal): Promise<unknown>;
	userInfo(userId: string, credential: string, signal?: AbortSignal): Promise<unknown>;
}

export interface TransportOptions {
	fetchImpl?: typeof fetch;
	/** Wall-clock budget for a single upstream call; the upstream holds the body open. */
	timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

async function readErrorBody(response: WireResponse): Promise<string> {
	noteMinimumVersion(response.headers.get("x-zed-minimum-required-version"));
	try {
		return await response.text();
	} catch {
		return "";
	}
}

export function createZedTransport(options: TransportOptions = {}): ZedTransport {
	const fetchImpl = options.fetchImpl;
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	// A lookup of the latest stable Zed release is a real upstream concern only:
	// tests inject a fetch and the mock upstream sets ZED_API_BASE, so neither
	// ever reaches GitHub.
	const allowVersionRefresh = !fetchImpl && !process.env.ZED_API_BASE;

	const withTimeout = (signal: AbortSignal | undefined): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } => {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		// The budget covers the whole call — the completions body stays open until
		// the upstream's `stream_ended` line — so the timer deliberately outlives a
		// resolved response. It must never outlive the process: a referenced timer
		// keeps Node's event loop alive for the full 300s after a finished turn.
		timer.unref?.();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal) {
			if (signal.aborted) controller.abort(signal.reason);
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		return {
			signal: controller.signal,
			timedOut: () => timedOut,
			cancel: () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			},
		};
	};

	/** A timeout is an upstream fault, not a caller cancellation. */
	const translate = (error: unknown, scoped: { timedOut: () => boolean; cancel: () => void }): never => {
		scoped.cancel();
		if (scoped.timedOut()) {
			throw new ZedHttpError(504, `Zed upstream request timed out after ${Math.round(timeoutMs / 1000)}s`);
		}
		throw error;
	};

	return {
		async completions(jwt: string, body: unknown, signal?: AbortSignal): Promise<WireResponse> {
			const scoped = withTimeout(signal);
			try {
				const version = allowVersionRefresh ? await resolveClientVersion() : currentClientVersion();
				const response = await wireRequest(
					{
						method: "POST",
						url: COMPLETIONS_URL,
						headers: completionsHeaders(jwt, version),
						body: JSON.stringify(body),
						signal: scoped.signal,
					},
					fetchImpl,
				);
				if (!response.ok) throw new ZedHttpError(response.status, await readErrorBody(response));
				noteMinimumVersion(response.headers.get("x-zed-minimum-required-version"));
				return response;
			} catch (error) {
				if (error instanceof ZedHttpError) {
					scoped.cancel();
					throw error;
				}
				return translate(error, scoped);
			}
		},

		async models(jwt: string, signal?: AbortSignal): Promise<unknown> {
			const scoped = withTimeout(signal);
			try {
				const response = await wireRequest(
					{ method: "GET", url: MODELS_URL, headers: modelsHeaders(jwt), signal: scoped.signal },
					fetchImpl,
				);
				if (!response.ok) throw new ZedHttpError(response.status, await readErrorBody(response));
				return await response.json();
			} catch (error) {
				if (error instanceof ZedHttpError) {
					scoped.cancel();
					throw error;
				}
				return translate(error, scoped);
			} finally {
				scoped.cancel();
			}
		},

		async userInfo(userId: string, credential: string, signal?: AbortSignal): Promise<unknown> {
			const scoped = withTimeout(signal);
			try {
				const response = await wireRequest(
					{
						method: "GET",
						url: USER_INFO_URL,
						headers: tokenHeaders(userId, credential, resolveSystemId()),
						signal: scoped.signal,
					},
					fetchImpl,
				);
				if (!response.ok) throw new ZedHttpError(response.status, await readErrorBody(response));
				return await response.json();
			} finally {
				scoped.cancel();
			}
		},
	};
}

/**
 * Decode the NDJSON body of a completions response into normalized deltas.
 * Stops at the `stream_ended` marker and cancels the underlying reader; the
 * reader's cancellation aborts the in-flight body without touching the caller's
 * signal, so an aborted turn is reported separately.
 */
export async function* readCompletionStream(response: WireResponse): AsyncGenerator<ZedDelta> {
	const body = response.body;
	if (!body) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const splitter = createLineSplitter();
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			for (const line of splitter.push(decoder.decode(chunk.value, { stream: true }))) {
				for (const delta of parseZedLine(line)) {
					yield delta;
					if (delta.kind === "ended") {
						await reader.cancel().catch(() => {});
						return;
					}
				}
			}
		}
		for (const line of splitter.flush()) {
			for (const delta of parseZedLine(line)) {
				yield delta;
				if (delta.kind === "ended") return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Model ids available to the account, as reported by `GET /models`. */
export function extractModelIds(payload: unknown): string[] {
	const record = asRecord(payload);
	if (!record) return [];
	const models = record["models"];
	if (!Array.isArray(models)) return [];
	const ids: string[] = [];
	for (const entry of models) {
		const model = asRecord(entry);
		if (!model) continue;
		const id = model["id"];
		if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}
