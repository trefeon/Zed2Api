/**
 * Minimal HTTP wire for the upstream, with no runtime-injected headers.
 *
 * Node's and Bun's `fetch` both add headers the real client never sends
 * (`user-agent`, `accept`, `accept-language`, `sec-fetch-mode`), and the two
 * runtimes differ from each other - a fingerprint that survives even when the
 * plugin's own headers match. Production therefore goes through `node:http`
 * for local/mock HTTP and `node:http2` for the Zed HTTPS edge, with the same
 * `Zed/<version>` agent the real client installs. HTTP/2 sends the pseudo
 * headers plus the headers listed here; HTTP/1.1 also sends `Host`,
 * `Connection` and `Content-Length`. Tests keep injecting `fetchImpl`, which
 * is adapted to the same response surface.
 */

import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	connect as http2Connect,
	constants as http2Constants,
	type ClientHttp2Session,
	type ClientHttp2Stream,
	type SecureClientSessionOptions,
} from "node:http2";
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
	const url = new URL(request.url);
	const useHttp2 =
		url.protocol === "https:" &&
		url.hostname === "cloud.zed.dev" &&
		process.env.ZED2API_HTTP1 !== "1";
	if (useHttp2) {
		try {
			return await fromHttp2(request, url);
		} catch (error) {
			if (error instanceof Http2Unavailable && !request.signal?.aborted) return fromNode(request);
			throw error;
		}
	}
	return fromNode(request);
}

/** The HTTPS edge is reached over TLS only when the connection itself fails. */
class Http2Unavailable extends Error {
	override readonly name = "Http2Unavailable";
}

/**
 * The real client keeps one reqwest client: rustls TLS, HTTP/2, a 30s idle
 * pool, and the global `Zed/<version>` agent. This is the closest a Node
 * process can get: HTTP/2 with the same ALPN and cipher/curve preference.
 * A Node/OpenSSL JA3 is still not rustls's JA3, so this is a fingerprint
 * reduction, not an identity.
 */
const H2_TLS: SecureClientSessionOptions = {
	ALPNProtocols: ["h2"],
	minVersion: "TLSv1.2",
	maxVersion: "TLSv1.3",
	settings: {
		enablePush: false,
		initialWindowSize: 2 * 1024 * 1024,
		maxFrameSize: 16 * 1024,
		maxHeaderListSize: 16 * 1024,
	},
	// rustls/aws-lc-rs default suites, in the same preference order.
	ciphers: [
		"TLS_AES_256_GCM_SHA384",
		"TLS_AES_128_GCM_SHA256",
		"TLS_CHACHA20_POLY1305_SHA256",
		"ECDHE-ECDSA-AES256-GCM-SHA384",
		"ECDHE-ECDSA-AES128-GCM-SHA256",
		"ECDHE-ECDSA-CHACHA20-POLY1305",
		"ECDHE-RSA-AES256-GCM-SHA384",
		"ECDHE-RSA-AES128-GCM-SHA256",
		"ECDHE-RSA-CHACHA20-POLY1305",
	].join(":"),
	ecdhCurve: "X25519:prime256v1:secp384r1:X25519MLKEM768",
	sigalgs:
		"ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:ed25519:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512",
};

const h2Sessions = new Map<string, Promise<ClientHttp2Session>>();

/** reqwest's HTTP/2 keepalive: PING every 15s, drop after 10s without an ACK. */
function startKeepAlive(session: ClientHttp2Session): void {
	const timer = setInterval(() => {
		if (session.closed || session.destroyed) return;
		let answered = false;
		const deadline = setTimeout(() => {
			if (!answered) session.destroy();
		}, 10_000);
		deadline.unref?.();
		try {
			session.ping(Buffer.alloc(8), (error) => {
				answered = true;
				clearTimeout(deadline);
				if (error) session.destroy();
			});
		} catch {
			answered = true;
			clearTimeout(deadline);
			session.destroy();
		}
	}, 15_000);
	timer.unref?.();
	session.once("close", () => clearInterval(timer));
}

function h2Session(origin: string): Promise<ClientHttp2Session> {
	const existing = h2Sessions.get(origin);
	if (existing) return existing;

	const session = http2Connect(origin, H2_TLS);
	const ready = new Promise<ClientHttp2Session>((resolve, reject) => {
		session.once("connect", () => {
			// hyper uses a 5 MiB connection window and a 2 MiB stream window.
			session.setLocalWindowSize(5 * 1024 * 1024);
			startKeepAlive(session);
			resolve(session);
		});
		session.once("error", reject);
	});
	h2Sessions.set(origin, ready);

	ready.catch(() => {
		if (h2Sessions.get(origin) === ready) h2Sessions.delete(origin);
		session.destroy();
	});
	session.on("error", () => {
		if (h2Sessions.get(origin) === ready) h2Sessions.delete(origin);
	});
	session.on("close", () => {
		if (h2Sessions.get(origin) === ready) h2Sessions.delete(origin);
	});
	// reqwest's pool_idle_timeout is 30s. The timer closes an idle session,
	// not an active stream.
	session.setTimeout(30_000, () => session.close());
	session.unref?.();
	return ready;
}

function fromHttp2(request: WireRequest, url: URL): Promise<WireResponse> {
	return h2Session(url.origin).then(
		(session) =>
			new Promise<WireResponse>((resolve, reject) => {
				const headers: Record<string, string> = {
					":method": request.method,
					":path": `${url.pathname}${url.search}`,
					":scheme": "https",
					":authority": url.host,
					...request.headers,
				};
				if (request.body !== undefined) headers["content-length"] = String(Buffer.byteLength(request.body));
				let stream: ClientHttp2Stream;
				try {
					stream = session.request(headers, { endStream: request.body === undefined });
				} catch (error) {
					reject(new Http2Unavailable(String(error)));
					return;
				}

				let settled = false;
				let responded = false;
				const cleanup = () => {
					request.signal?.removeEventListener("abort", abort);
				};
				const abort = () => {
					cleanup();
					stream.close(http2Constants.NGHTTP2_CANCEL);
					if (!responded) {
						responded = true;
						settled = true;
						reject(new DOMException("The upstream request was aborted", "AbortError"));
					}
				};
				if (request.signal) {
					if (request.signal.aborted) {
						abort();
						return;
					}
					request.signal.addEventListener("abort", abort, { once: true });
				}

				stream.once("response", (rawHeaders) => {
					if (settled) return;
					responded = true;
					const status = Number(rawHeaders[":status"] ?? 0);
					const responseHeaders = new Headers();
					for (const [name, value] of Object.entries(rawHeaders)) {
						if (name.startsWith(":") || value === undefined) continue;
						if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, String(entry));
						else responseHeaders.set(name, String(value));
					}
					const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
					let consumed: Promise<string> | null = null;
					const text = () => (consumed ??= readAll(body));
					resolve({
						ok: status >= 200 && status < 300,
						status,
						headers: responseHeaders,
						body,
						text,
						async json() {
							return JSON.parse(await text());
						},
					});
				});
				stream.once("error", (error) => {
					if (settled) return;
					settled = true;
					responded = true;
					cleanup();
					reject(error);
				});
				stream.once("close", () => {
					cleanup();
					if (!responded) {
						responded = true;
						settled = true;
						reject(new Error("HTTP/2 stream closed before a response"));
					}
				});
				if (request.body !== undefined) stream.end(request.body);
			}),
		(error) => Promise.reject(new Http2Unavailable(String(error))),
	);
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
