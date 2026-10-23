/**
 * Constants and header builders for Zed's cloud API.
 *
 * The contract is copied from Zed's own client at tag v1.25.2:
 * `crates/cloud_api_client/src/cloud_api_client.rs` builds every account call
 * as `Content-Type: application/json` plus
 * `Authorization: <user_id> <access_token>`, with `x-zed-system-id` on the
 * token and user-info calls; `crates/language_models_cloud` adds the
 * capability flags the edge uses to gate model families and stream status.
 * There is no User-Agent and no Accept header anywhere in that path, so the
 * builders here add neither - a browser/Node/Bun default header is a tell the
 * upstream never sees from the real client.
 */

/**
 * Base URL every upstream call is built on. Production always talks to Zed's
 * cloud; `ZED_API_BASE` exists so the wire can be exercised against a local
 * stand-in (`tests/mock-upstream.mjs`) without a Zed subscription.
 */
export function zedCloudBase(): string {
	const override = process.env.ZED_API_BASE?.trim();
	if (!override) return "https://cloud.zed.dev";
	// A trailing slash would double up in the paths below.
	return override.replace(/\/+$/, "");
}

export const ZED_CLOUD = zedCloudBase();
export const ZED_APP = "https://zed.dev";

export const COMPLETIONS_URL = `${ZED_CLOUD}/completions`;
export const MODELS_URL = `${ZED_CLOUD}/models`;
export const LLM_TOKENS_URL = `${ZED_CLOUD}/client/llm_tokens`;
export const USER_INFO_URL = `${ZED_CLOUD}/client/users/me`;

/**
 * Completions headers, exactly as `language_models_cloud` sends them.
 * `appVersion` must be a released Zed version; the edge rejects stale clients.
 */
export function completionsHeaders(jwt: string, appVersion: string): Record<string, string> {
	return {
		authorization: `Bearer ${jwt}`,
		"content-type": "application/json",
		"x-zed-version": appVersion,
		"x-zed-client-supports-status-messages": "true",
		"x-zed-client-supports-stream-ended-request-completion-status": "true",
	};
}

/** The model list gates the xAI/Gemini rows behind this capability flag. */
export function modelsHeaders(jwt: string): Record<string, string> {
	return {
		authorization: `Bearer ${jwt}`,
		"x-zed-client-supports-x-ai": "true",
	};
}

/** The token and user-info endpoints authenticate with `<user_id> <credential blob>`. */
export function tokenHeaders(userId: string, credential: string, systemId: string): Record<string, string> {
	return {
		authorization: `${userId} ${credential}`,
		"content-type": "application/json",
		"x-zed-system-id": systemId,
	};
}
