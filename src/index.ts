/**
 * zed2api — a PI/OMP extension that uses a Zed subscription as a native model
 * provider, with no local gateway process in the path.
 *
 * The host calls `streamSimple` for every turn; this module wires that entry
 * point to {@link streamZedTurn}, registers the account store, and exposes a
 * `/zed` command for account and catalog management. Zed sign-in is the
 * host's own `/login` (provider "Zed") or `omp login zed`; `/zed login` stays
 * available for adding or naming extra accounts.
 *
 * Accounts live in `~/.zed2api/accounts.json` — the same schema the reference
 * gateway writes, so one sign-in serves both:
 *   { "<name>": { "user_id": "<id>", "credential": <credential JSON> } }
 */

import { AccountStore, type AccountSummary } from "./accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./host/api.ts";
import { createZedProvider, probeAccount, type ProbeOutcome, type ZedProviderDeps } from "./provider.ts";
import { formatUsageReport, loadPlan, monthStart, normalizePlan, readUsage, summarizeUsage } from "./usage.ts";
import { loginToZed, openInBrowser } from "./zed/auth.ts";
import { dashboardCookie, dashboardUsageUrl, fetchDashboardUsage, type DashboardUsage } from "./zed/dashboard.ts";
import { writeCachedCatalog } from "./zed/catalog.ts";
import { createZedTransport, extractModelIds } from "./zed/client.ts";

const PROVIDER = "zed";
const SUBCOMMANDS = ["status", "login", "accounts", "switch", "forget", "models", "refresh", "probe", "usage"];

const USAGE = [
	"Usage: /zed <command>",
	"  status              accounts, active account, cooldowns (default)",
	"  login [name]        optional alternate sign-in (host /login is primary)",
	"  accounts            list stored accounts",
	"  switch <name>       make an account the active one",
	"  forget <name>       delete an account entry",
	"  models              list the models the account can see",
	"  refresh             re-fetch the model catalog",
	"  probe [name]        send a 32-token probe to one account (or all)",
	"  usage [--json] [--all]  local token spend at Zed rates; exact plan usage with a dashboard cookie",
].join("\n");

type Notify = (message: string, level?: "info" | "warning" | "error") => void;

/** Subcommands that write the store file; all of them are unsafe when load failed. */
const MUTATING_SUBCOMMANDS: Record<string, true> = { login: true, switch: true, forget: true };

/**
 * The one notice path: the host UI when there is one, stdout otherwise. The
 * host may expose `notify` as a no-op that throws without a UI runner, and the
 * session hook has no command context at all, so both cases stay contained.
 */
function commandNotify(ctx?: ExtensionCommandContext): Notify {
	return (message, level) => {
		try {
			if (ctx?.hasUI) ctx.ui.notify(message, level);
			else process.stdout.write(`${message}\n`);
		} catch {
			// A broken notice must never fail a command or a session hook.
		}
	};
}

function formatStoreError(store: AccountStore, message: string): string {
	return `${store.path}: ${message}`;
}

export default async function zed2api(pi: ExtensionAPI): Promise<void> {
	const store = new AccountStore();
	let storeError: string | null = null;
	try {
		store.load();
	} catch (error) {
		// A store the user broke by hand must not take the command down with it:
		// /zed is what reports the problem and tells them how to repair it.
		storeError = describe(error);
	}
	const transport = createZedTransport();
	const deps: ZedProviderDeps = { store, transport };

	try {
		pi.registerProvider(PROVIDER, createZedProvider({ store, transport }));
	} catch (error) {
		commandNotify()(`Could not register the "${PROVIDER}" provider: ${describe(error)}`, "error");
	}

	pi.registerCommand("zed", {
		description: "Manage Zed accounts behind the zed2api provider",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trim();
			const separator = trimmed.indexOf(" ");
			const head = separator < 0 ? trimmed : trimmed.slice(0, separator);
			const tail = separator < 0 ? "" : trimmed.slice(separator + 1);
			if (head === "switch" || head === "forget" || head === "probe") {
				return store
					.names()
					.filter((name) => name.startsWith(tail))
					.map((name) => ({ value: `${head} ${name}`, label: name }));
			}
			return SUBCOMMANDS.filter((command) => command.startsWith(head)).map((command) => ({ value: command, label: command }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await runCommand(deps, args.trim(), commandNotify(ctx), storeError);
		},
	});

	// Reference plugins re-read hand-edited state on every session start; here
	// that is how a repaired store file comes back without a restart. Kept
	// after registration so a host that rejects the hook cannot lose /zed.
	pi.on?.("session_start", (_event, ctx) => {
		try {
			store.load();
			storeError = null;
		} catch (error) {
			storeError = describe(error);
			commandNotify(ctx)(formatStoreError(store, storeError), "error");
		}
	});
}

async function runCommand(deps: ZedProviderDeps, args: string, notify: Notify, storeError: string | null): Promise<void> {
	const [command = "status", ...rest] = args.split(/\s+/);
	const store = deps.store;

	if (storeError !== null && MUTATING_SUBCOMMANDS[command] === true) {
		notify(`${formatStoreError(store, storeError)} — move or delete ${store.path} to continue`, "error");
		return;
	}

	switch (command) {
		case "status": {
			reportStatus(store, notify, storeError);
			return;
		}
		case "accounts": {
			if (store.length === 0) {
				reportNoAccounts(notify);
				return;
			}
			notify(store.summaries().map(formatSummary).join("\n"));
			return;
		}
		case "login": {
			const name = rest[0] || "default";
			notify(`Opening the Zed sign-in page for account "${name}"…`);
			try {
				const credentials = await loginToZed({
					onUrl: (url) => notify(`If the browser does not open, visit:\n${url}`),
					openBrowser: openInBrowser,
				});
				const account = store.add(name, credentials.userId, credentials.credential);
				store.switchTo(name);
				try {
					await store.ensureOrganization(account);
					const jwt = await store.tokenFor(account);
					writeCachedCatalog(account.userId, extractModelIds(await deps.transport.models(jwt)));
				} catch {
					// The first token request resolves the organization again, and
					// the catalog is refreshed on demand.
				}
				notify(`Account "${name}" connected (Zed user ${credentials.userId}).`);
			} catch (error) {
				notify(`Sign-in failed: ${describe(error)}`, "error");
			}
			return;
		}
		case "switch": {
			const name = rest[0];
			if (!name) {
				notify(`Usage: /zed switch <name>\nKnown accounts: ${store.names().join(", ") || "(none)"}`, "warning");
				return;
			}
			if (store.switchTo(name)) notify(`Active account: ${name}`);
			else notify(`No such account: ${name}`, "error");
			return;
		}
		case "forget": {
			const name = rest[0];
			if (!name) {
				notify("Usage: /zed forget <name>", "warning");
				return;
			}
			if (store.remove(name)) notify(`Removed account "${name}" from ${store.path}`);
			else notify(`No such account: ${name}`, "error");
			return;
		}
		case "models":
		case "refresh": {
			const account = store.current();
			if (!account) {
				reportNoAccounts(notify);
				return;
			}
			notify(await describeCatalog(deps, notify));
			return;
		}
		case "usage": {
			const allTime = rest.includes("--all");
			const asJson = rest.includes("--json");
			const summary = summarizeUsage(readUsage(store.path), allTime ? 0 : monthStart());
			const cookie = dashboardCookie(store.path);
			let dashboard: DashboardUsage | null = null;
			let dashboardError: string | null = null;
			if (cookie !== null) {
				try {
					dashboard = await fetchDashboardUsage(deps.fetchImpl ?? fetch, cookie);
				} catch (error) {
					dashboardError = describe(error);
				}
			}
			const account = store.current();
			const dashboardUrl = dashboardUsageUrl(account?.organizationId ?? null);
			const plan = normalizePlan(dashboard?.plan) ?? loadPlan(store.path);
			if (asJson) {
				notify(JSON.stringify({ plan, summary, dashboard, dashboardError, dashboardUrl }, null, 2));
			} else {
				notify(formatUsageReport(summary, { plan, dashboard, dashboardError, dashboardUrl }));
			}
			return;
		}
		case "probe": {
			const targets = rest[0] ? [store.find(rest[0])].filter((entry) => entry !== null) : store.tryOrder();
			if (targets.length === 0) {
				notify(rest[0] ? `No such account: ${rest[0]}` : "No accounts to probe.", "warning");
				return;
			}
			for (const account of targets) {
				const outcome = await probeAccount(deps, account);
				notify(formatProbe(account.name, outcome), outcome.state === "healthy" ? "info" : "warning");
			}
			return;
		}
		default: {
			notify(USAGE, "warning");
		}
	}
}

function reportNoAccounts(notify: Notify): void {
	notify(
		`No Zed account is connected. Run /login for provider "${PROVIDER}" (OMP: omp login zed), or /zed login <name>.`,
		"warning",
	);
}

function reportStatus(store: AccountStore, notify: Notify, storeError: string | null): void {
	if (storeError !== null) notify(formatStoreError(store, storeError), "error");
	if (store.length === 0) {
		if (storeError === null) reportNoAccounts(notify);
		return;
	}
	const lines = [`zed2api — ${store.length} account(s) in ${store.path}`];
	for (const summary of store.summaries()) lines.push(formatSummary(summary));
	lines.push(`Run /zed models for the live catalog, /zed probe to test an account.`);
	notify(lines.join("\n"));
}

/** Fetch and describe the account's live model list. */
async function describeCatalog(deps: ZedProviderDeps, notify: Notify): Promise<string> {
	const account = deps.store.current();
	if (!account) return "No Zed account is connected; serving the built-in catalog.";
	try {
		const jwt = await deps.store.tokenFor(account);
		const ids = extractModelIds(await deps.transport.models(jwt));
		writeCachedCatalog(account.userId, ids);
		if (ids.length === 0) {
			notify("Zed returned no models for this account.", "warning");
			return "Context: /zed refresh";
		}
		return `Models for "${account.name}" (${ids.length}):\n${ids.join("\n")}`;
	} catch (error) {
		return `Model refresh failed: ${describe(error)}`;
	}
}

function formatSummary(summary: AccountSummary): string {
	const marker = summary.current ? "*" : " ";
	const health = summary.healthy ? "ready" : `cooling down ${summary.cooldownSeconds}s`;
	const probe = summary.probeState === "unchecked" ? "" : `, last probe: ${summary.probeState}`;
	const status = summary.lastStatus > 0 ? `, last HTTP ${summary.lastStatus}` : "";
	return `${marker} ${summary.name} — ${health}${probe}${status}`;
}

function formatProbe(name: string, outcome: ProbeOutcome): string {
	const status = outcome.status > 0 ? `HTTP ${outcome.status}` : "network";
	return `${name}: ${outcome.state} (${status}, ${outcome.latencyMs}ms) — ${outcome.detail}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
