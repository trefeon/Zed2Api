/**
 * The sign-in URL carries its key and system id in query parameters. Windows
 * must not route it through `cmd`, which splits at `&` and drops everything
 * after the port.
 */

import { describe, expect, test } from "bun:test";

import { browserOpenCommand } from "../src/zed/auth.ts";

const URL_WITH_QUERY =
	"https://zed.dev/native_app_signin?native_app_port=8774&native_app_public_key=abc&system_id=def";

describe("browser launcher", () => {
	test("Windows hands the whole URL to the protocol handler", () => {
		expect(browserOpenCommand(URL_WITH_QUERY, "win32")).toEqual({
			command: "rundll32",
			args: ["url.dll,FileProtocolHandler", URL_WITH_QUERY],
		});
	});

	test("macOS and Linux pass the URL as one argument", () => {
		expect(browserOpenCommand(URL_WITH_QUERY, "darwin")).toEqual({ command: "open", args: [URL_WITH_QUERY] });
		expect(browserOpenCommand(URL_WITH_QUERY, "linux")).toEqual({ command: "xdg-open", args: [URL_WITH_QUERY] });
	});
});
