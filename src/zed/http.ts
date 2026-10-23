/**
 * Minimal HTTP wire for the upstream, with no runtime-injected headers.
 *
 * Node's and Bun's `fetch` both add headers the real client never sends
 * (`user-agent`, `accept`, `accept-language`, `sec-fetch-mode`), and the two
 * runtimes differ from each other - a fingerprint that survives even when the
 * plugin's own headers match. Production therefore goes through `node:http(s)`,
 * which sends only the headers listed here plus `Host`, `Connection` and
 * `Content-Length`. Tests keep injecting `fetchImpl`, which is adapted to the
 * same response surface.
 */

import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** The response surface the transport consumes; a fetch `Response` satisfies it. */
export interface WireResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: Headers;
	readonly body: ReadableStream<Uint8Array> | null;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

export interface WireRequest {
	method: "GET" | "POST";
	url: string;
	headers: Record<string, string>;
	/** Omitted for GET; an empty string is a real, zero-length body. */
	body?: string;
	signal?: AbortSignal;
}

export async function wireRequest(request: WireRequest, fetchImpl?: typeof fetch): Promise<WireResponse> {
	if (fetchImpl) {
		const response = await fetchImpl(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: request.signal,
		});
		return fromFetch(response);
	}
	return fromNode(request);
}

function fromFetch(response: Response): WireResponse {
	let consumed: Promise<string> | null = null;
	const text = () => (consumed ??= response.text());
	return {
		ok: response.ok,
		status: response.status,
		headers: response.headers,
		body: response.body,
		text,
		async json() {
			return JSON.parse(await text());
		},
	};
}

function fromNode(request: WireRequest): Promise<WireResponse> {
	const url = new URL(request.url);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return Promise.reject(new Error(`unsupported upstream protocol: ${url.protocol}`));
	}
	const send = url.protocol === "http:" ? httpRequest : httpsRequest;
	const headers: Record<string, string> = { ...request.headers };
	if (request.body !== undefined) headers["content-length"] = String(Buffer.byteLength(request.body));

	return new Promise<WireResponse>((resolve, reject) => {
		let response: IncomingMessage | null = null;
		const abort = () => {
			const error = new DOMException("The upstream request was aborted", "AbortError");
			client.destroy(error);
			response?.destroy(error);
		};
		const client = send(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || undefined,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers,
			},
			(incoming) => {
				response = incoming;
				const body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
				let consumed: Promise<string> | null = null;
				const text = () => (consumed ??= readAll(body));
				incoming.once("end", () => request.signal?.removeEventListener("abort", abort));
				incoming.once("close", () => request.signal?.removeEventListener("abort", abort));
				resolve({
					ok: incoming.statusCode !== undefined && incoming.statusCode >= 200 && incoming.statusCode < 300,
					status: incoming.statusCode ?? 0,
					headers: toHeaders(incoming.headers),
					body,
					text,
					async json() {
						return JSON.parse(await text());
					},
				});
			},
		);
		client.once("error", reject);
		if (request.signal) {
			if (request.signal.aborted) abort();
			else request.signal.addEventListener("abort", abort, { once: true });
		}
		client.end(request.body);
	});
}

function toHeaders(headers: IncomingHttpHeaders): Headers {
	const out = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const entry of value) out.append(name, entry);
		else out.set(name, value);
	}
	return out;
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
