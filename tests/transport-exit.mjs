/**
 * Child half of `tests/transport-exit.test.ts`.
 *
 * Performs one real `completions()` call against a throwaway local server and
 * then simply stops: nothing calls `process.exit`, so the process may only
 * finish when the event loop has nothing left to wait for. Run under Node (a
 * Bun parent exits regardless of stray timers, which is why this runs as a
 * child process at all).
 *
 * Prints `resolved "<text>"` on success.
 */

import { createServer } from "node:http";

const server = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(200, { "content-type": "application/x-ndjson", connection: "close" });
		res.end(`{"event":{"type":"response.output_text.delta","delta":"OK"}}\n{"status":"stream_ended"}\n`);
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

// The transport module resolves its base URL at import time, so set this first.
process.env.ZED_API_BASE = `http://127.0.0.1:${port}`;

const { createZedTransport, readCompletionStream } = await import("../src/zed/client.ts");

// A budget far beyond the parent's patience: if the timer stays referenced the
// process lives for an hour, so the assertion window is what fails, not timing.
const transport = createZedTransport({ timeoutMs: 3_600_000 });
const response = await transport.completions("mock-jwt", { model: "gpt-5.6-luna", provider: "open_ai" });
let text = "";
for await (const delta of readCompletionStream(response)) {
	if (delta.kind === "text") text += delta.text;
}
server.close();
console.log(`resolved ${JSON.stringify(text)}`);
