#!/usr/bin/env node
/**
 * Dependency-free stand-in for cloud.zed.dev, used to prove the `zed` provider
 * end to end inside a real host process (omp / pi) without a Zed subscription.
 *
 * It serves exactly the four endpoints the extension calls, in the wire shapes
 * its decoders expect:
 *
 *   POST /client/llm_tokens   → {"token": "<jwt with exp>"}
 *   GET  /models              → {"models": [{"id": …}, …]}
 *   GET  /client/users/me     → account JSON (exposed by the transport)
 *   POST /completions         → HTTP 200, newline-delimited JSON ending with
 *                               {"status":"stream_ended"} (the terminal marker
 *                               the decoder stops on)
 *
 * Auth is not checked: the point of the harness is the wire, not credentials.
 * Every request is logged as one line on stdout, and the sequence of those
 * lines is the evidence for what the host actually did.
 *
 * Env:
 *   MOCK_PORT            listen port (default 8787)
 *   MOCK_HOST            listen host (default 127.0.0.1)
 *   MOCK_REPLY           assistant reply text (default "OK"); streamed in two chunks
 *   MOCK_HTTP_ERROR      answer completions with this HTTP status and a text body
 *   MOCK_STREAM_FAILURE  emit {"status":{"failed":…}} instead of text
 *   MOCK_HOLD_OPEN=1     leave the completions body open after `stream_ended`,
 *                        as the real upstream does, instead of closing it
 */

import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";
const REPLY = process.env.MOCK_REPLY ?? "OK";
const HTTP_ERROR = Number(process.env.MOCK_HTTP_ERROR ?? 0);
const STREAM_FAILURE = process.env.MOCK_STREAM_FAILURE ?? "";
/** Keep the completions body open after `stream_ended` instead of closing it. */
const HOLD_OPEN = process.env.MOCK_HOLD_OPEN === "1";

/**
 * Ids the extension knows how to route. `claude-haiku-5` is deliberately absent
 * from the extension's built-in catalog, so selecting it forces the host to ask
 * `GET /models` before the turn — the only way to observe discovery end to end.
 */
const MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "claude-sonnet-5", "claude-haiku-5"];

const started = Date.now();

function log(line) {
	process.stdout.write(`[mock ${((Date.now() - started) / 1000).toFixed(2)}s] ${line}\n`);
}

function base64url(value) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An unsigned JWT: the extension only reads `exp`, and never verifies a signature. */
function mintJwt(lifetimeSeconds = 3600) {
	const now = Math.floor(Date.now() / 1000);
	return `${base64url({ alg: "none", typ: "JWT" })}.${base64url({ sub: "mock-zed-user", iat: now, exp: now + lifetimeSeconds })}.mock-signature`;
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(""));
	});
}

function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

/** Split the reply so the host has to assemble it from several deltas. */
function replyChunks(text) {
	if (text.length < 2) return [text];
	const middle = Math.ceil(text.length / 2);
	return [text.slice(0, middle), text.slice(middle)];
}

/** OpenAI Responses dialect (GPT routes). */
function responsesFrames(reply) {
	const frames = replyChunks(reply).map((delta) => ({
		event: { type: "response.output_text.delta", delta },
	}));
	frames.push({
		event: {
			type: "response.completed",
			response: { id: "resp_mock", status: "completed", stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 2 } },
		},
	});
	frames.push({ status: "stream_ended" });
	return frames;
}

/** Anthropic dialect (Claude routes). */
function anthropicFrames(reply) {
	const frames = [
		{ event: { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "claude-sonnet-5" } } },
		{ event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	];
	for (const text of replyChunks(reply)) {
		frames.push({ event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
	}
	frames.push({ event: { type: "content_block_stop", index: 0 } });
	frames.push({ event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 12, output_tokens: 2 } } });
	frames.push({ event: { type: "message_stop" } });
	frames.push({ status: "stream_ended" });
	return frames;
}

function family(model) {
	if (typeof model === "string" && model.startsWith("claude")) return "anthropic";
	return "open_ai";
}

/** Summarize the request body without dumping the whole prompt into the log. */
function describeEnvelope(envelope, body) {
	if (envelope === undefined) return `unparsable body (${body.length} bytes)`;
	const request = envelope?.provider_request ?? {};
	const prompt = typeof request.prompt === "string" ? request.prompt : JSON.stringify(request).slice(0, 80);
	const tools = Array.isArray(request.tools) ? request.tools.length : 0;
	return `model=${envelope?.model} provider=${envelope?.provider} intent=${envelope?.intent} tools=${tools} prompt=${JSON.stringify(prompt.slice(0, 60))}`;
}

async function serveCompletions(req, res) {
	const body = await readBody(req);
	let envelope;
	try {
		envelope = JSON.parse(body);
	} catch {
		envelope = undefined;
	}
	const model = envelope?.model;
	log(`POST /completions (${family(model)}) ${describeEnvelope(envelope, body)}`);

	if (HTTP_ERROR > 0) {
		const text = `mock upstream rejected the request with HTTP ${HTTP_ERROR}`;
		res.writeHead(HTTP_ERROR, { "content-type": "text/plain", "content-length": Buffer.byteLength(text) });
		res.end(text);
		return;
	}

	res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
	res.write(": mock upstream stream open\n");

	if (STREAM_FAILURE.length > 0) {
		res.write(`${JSON.stringify({ status: { failed: { code: STREAM_FAILURE, message: "mock stream failure" } } })}\n`);
	} else {
		const frames = family(model) === "anthropic" ? anthropicFrames(REPLY) : responsesFrames(REPLY);
		for (const frame of frames) {
			res.write(`${JSON.stringify(frame)}\n`);
			// Separate TCP chunks so the extension's line splitter is exercised.
			await delay(20);
		}
	}
	log(`     -> streamed ${family(model)} ${HOLD_OPEN ? "frames; holding the body open" : "frames and closed the body"}`);

	if (HOLD_OPEN) {
		// The real body can stay open after the terminal marker; the client is
		// expected to cancel. Off by default because a host on undici (PI) keeps
		// its process alive on an unclosed response and never exits.
		res.on("close", () => log(`     -> client closed the completions stream`));
		return;
	}
	res.end();
}

const server = createServer(async (req, res) => {
	const { pathname } = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
	const authorization = req.headers.authorization ?? "";

	try {
		if (req.method === "POST" && pathname === "/client/llm_tokens") {
			const raw = await readBody(req);
			let organization;
			try {
				organization = JSON.parse(raw.toString("utf8")).organization_id;
			} catch {
				organization = undefined;
			}
			const scheme = authorization.includes(" ") ? authorization.slice(0, authorization.indexOf(" ")) : "(none)";
			log(`POST /client/llm_tokens user=${scheme || "(empty)"} org=${organization ?? "(none)"} system-id=${req.headers["x-zed-system-id"] ?? "(none)"}`);
			if (typeof organization !== "string" || organization.length === 0) {
				json(res, 400, { message: "organization_id must be a string" });
				return;
			}
			json(res, 200, { token: mintJwt() });
			return;
		}

		if (req.method === "GET" && pathname === "/models") {
			const bearer = authorization.startsWith("Bearer ") ? "bearer" : `missing (got "${authorization.slice(0, 20)}")`;
			log(`GET /models auth=${bearer} x-ai=${req.headers["x-zed-client-supports-x-ai"] ?? "(none)"}`);
			json(res, 200, { models: MODELS.map((id) => ({ id })) });
			return;
		}

		if (req.method === "GET" && pathname === "/client/users/me") {
			log(`GET /client/users/me`);
			json(res, 200, {
				user: { id: 1, id_v2: "user_mock", username: "mock", plan: "mock-pro" },
				organizations: [{ id: "org_mock_zed" }],
			});
			return;
		}

		if (req.method === "POST" && pathname === "/completions") {
			await serveCompletions(req, res);
			return;
		}

		const body = await readBody(req);
		log(`UNHANDLED ${req.method} ${pathname} (${body.length} bytes)`);
		json(res, 404, { error: `mock upstream has no route for ${req.method} ${pathname}` });
	} catch (error) {
		log(`ERROR ${req.method} ${pathname}: ${error instanceof Error ? error.message : String(error)}`);
		if (!res.headersSent) json(res, 500, { error: "mock upstream failure" });
		else res.destroy();
	}
});

server.listen(PORT, HOST, () => {
	log(`mock upstream listening on http://${HOST}:${PORT} (models: ${MODELS.join(", ")}; reply: ${JSON.stringify(REPLY)})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		log(`${signal} — shutting down`);
		server.close(() => process.exit(0));
		// Completions keep their sockets open on purpose, so do not wait for them.
		setTimeout(() => process.exit(0), 200).unref();
	});
}
