/**
 * A finished turn must not keep the host process alive.
 *
 * `createZedTransport` arms a per-request wall-clock budget that, by design,
 * outlives the response headers (the completions body stays open until the
 * upstream's `stream_ended` line). A *referenced* timer then pins Node's event
 * loop for the whole budget — five minutes by default — after the answer has
 * already been delivered. That is observed from a child process, because Bun
 * (the test runner) exits regardless of stray timers and would hide the defect.
 */

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "transport-exit.mjs");
/** Generous: the healthy child takes ~1s, the defect takes an hour. */
const PATIENCE_MS = 15_000;

/** The child imports a `.ts` module, which needs Node's default type stripping. */
function nodeStripsTypesNatively(): boolean {
	const probe = spawnSync("node", ["--version"], { encoding: "utf8" });
	if (probe.status !== 0) return false;
	const [major = 0, minor = 0] = probe.stdout.trim().replace(/^v/, "").split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 18);
}

interface ChildRun {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	/** Set when the kill window fired and Node aborted the spawn. */
	spawnError: string | null;
	elapsedMs: number;
}

function runChild(): Promise<ChildRun> {
	const { promise, resolve } = Promise.withResolvers<ChildRun>();
	const startedAt = performance.now();
	// Integration exception to the no-real-timers rule: the property under test
	// *is* process exit against the platform clock, and the only bound available
	// is a kill window — 15s against a healthy run of ~1s.
	const proc = spawn("node", [CHILD], {
		stdio: ["ignore", "pipe", "pipe"],
		signal: AbortSignal.timeout(PATIENCE_MS),
	});
	let stdout = "";
	let stderr = "";
	let spawnError: string | null = null;
	proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	// Aborting the spawn raises an error event; keep it out of the runner's
	// unhandled-error path so the assertions below report the real failure.
	proc.on("error", (error) => {
		spawnError = error.message;
	});
	proc.on("close", (code, signal) =>
		resolve({ code, signal, stdout, stderr, spawnError, elapsedMs: performance.now() - startedAt }),
	);
	return promise;
}

test.skipIf(!nodeStripsTypesNatively())(
	"a completed transport call does not keep the process alive",
	async () => {
		const run = await runChild();

		expect(run.stdout).toContain('resolved "OK"');
		// A killed child (signal set, null code) is the defect: the request
		// resolved, the answer was read, and the process still could not exit.
		expect(run.spawnError, `child had to be killed after ${Math.round(run.elapsedMs)}ms`).toBeNull();
		expect(run.signal, `child was killed after ${Math.round(run.elapsedMs)}ms; stderr: ${run.stderr}`).toBeNull();
		expect(run.code, `child exited with ${run.code}; stderr: ${run.stderr}`).toBe(0);
		expect(run.elapsedMs).toBeLessThan(PATIENCE_MS);
	},
	// Above the child's kill window, so a lingering process fails on the
	// assertion above with its own diagnostic instead of as a runner timeout.
	PATIENCE_MS + 5_000,
);
