/**
 * Zed sign-in: the native-app OAuth handshake, ported from the reference
 * gateway.
 *
 * Flow:
 *   1. Generate a 2048-bit RSA keypair in-process.
 *   2. Serve a one-shot HTTP callback on 127.0.0.1 and open
 *      https://zed.dev/native_app_signin?native_app_port=<port>&native_app_public_key=<b64url>
 *   3. Zed redirects the browser to the callback with `user_id` and an
 *      RSA-OAEP(SHA-256) ciphertext in `access_token` (base64url), which
 *      decrypts to the credential blob stored for later token requests.
 *   4. Reply 302 to https://zed.dev/native_app_signin_succeeded.
 *
 * Public key material matches the reference implementation: PKCS#1 DER,
 * base64url, unpadded.
 */

import { createServer } from "node:http";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { spawn } from "node:child_process";

import { resolveSystemId } from "./system.ts";

export interface ZedCredentials {
	/** Zed user id reported by the sign-in callback. */
	userId: string;
	/** Decrypted credential blob, verbatim as Zed issued it. */
	credential: string;
}

export interface LoginOptions {
	/** Milliseconds to wait for the browser to come back. Default 5 minutes. */
	timeoutMs?: number;
	/** Called with the sign-in URL as soon as it is known. */
	onUrl: (url: string) => void;
	/** Open a URL in the user's browser; defaults to the platform opener. */
	openBrowser?: (url: string) => void;
	signal?: AbortSignal;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const SIGNIN_HOST = "https://zed.dev";
const SUCCESS_REDIRECT = `${SIGNIN_HOST}/native_app_signin_succeeded`;

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url without requiring padding, as the callback may omit it. */
function decodeBase64Url(value: string): Buffer {
	return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface BrowserOpenCommand {
	command: string;
	args: string[];
}

/**
 * Windows' `cmd /c start` splits its command line at `&`, so a sign-in URL
 * loses its public key after the first query parameter. `rundll32` receives
 * the URL as a plain argument and hands it to the protocol handler intact.
 */
export function browserOpenCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
	if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
	return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

export function openInBrowser(url: string): void {
	const { command, args } = browserOpenCommand(url);
	spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * Run the sign-in handshake and return the decrypted credential blob.
 * Rejects on timeout, on a malformed callback, or when the RSA blob does not
 * decrypt — never resolves with a partial credential.
 */
export async function loginToZed(options: LoginOptions): Promise<ZedCredentials> {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "der" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	});
	const publicKeyB64 = base64Url(publicKey);

	let settle: (result: ZedCredentials | Error) => void = () => {};
	const outcome = new Promise<ZedCredentials>((resolve, reject) => {
		settle = (result) => (result instanceof Error ? reject(result) : resolve(result));
	});

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const userId = url.searchParams.get("user_id");
		const encrypted = url.searchParams.get("access_token");

		response.writeHead(302, { location: SUCCESS_REDIRECT, "content-length": 0 });
		response.end();

		if (!userId || !encrypted) {
			settle(new Error("Zed sign-in callback was missing user_id or access_token"));
			return;
		}

		try {
			const plaintext = privateDecrypt(
				{ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
				decodeBase64Url(encrypted),
			);
			settle({ userId, credential: plaintext.toString("utf8") });
		} catch (error) {
			settle(new Error(`Could not decrypt the Zed credential: ${String(error)}`));
		}
	});

	const listening = new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("Zed sign-in server did not expose a port"));
		});
	});

	const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
	const timer = setTimeout(() => settle(new Error("Timed out waiting for the Zed sign-in to finish")), timeoutMs);
	const onAbort = () => settle(new Error("Zed sign-in cancelled"));
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const port = await listening;
		const signinUrl = `${SIGNIN_HOST}/native_app_signin?native_app_port=${port}&native_app_public_key=${encodeURIComponent(publicKeyB64)}&system_id=${resolveSystemId()}`;
		options.onUrl(signinUrl);
		(options.openBrowser ?? openInBrowser)(signinUrl);
		return await outcome;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		server.close();
	}
}
