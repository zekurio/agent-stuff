import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	GIT_FLOW_REFRESH_EVENT,
	GIT_FLOW_STATE_EVENT,
	type GitFlowFooterState,
	type PullRequestStatus,
} from "./lib/git-flow-state.ts";

type Routing = {
	label: string;
	payload: Record<string, unknown>;
	headers?: Record<string, string>;
	supportsModel?: (modelId: string) => boolean;
};

type RoutingState = {
	models: Record<string, boolean>;
	legacyEnabled?: boolean;
};

// Provider-specific high-priority tiers. Add custom gateways here.
const STATE_PATH = join(getAgentDir(), "priority-routing.json");

const ROUTES: Record<string, Routing> = {
	"openai-codex": {
		label: "Codex priority service tier",
		payload: { service_tier: "priority" },
	},
	openai: {
		label: "OpenAI priority service tier",
		payload: { service_tier: "priority" },
	},
	"azure-openai": {
		label: "Azure OpenAI priority service tier",
		payload: { service_tier: "priority" },
	},
	anthropic: {
		label: "Anthropic fast mode",
		payload: { speed: "fast" },
		headers: { "anthropic-beta": "fast-mode-2026-02-01" },
		supportsModel: (modelId) => /^claude-opus-4-(?:7|8)(?:-|$)/.test(modelId.toLowerCase()),
	},
	google: {
		label: "Google priority service tier",
		payload: { serviceTier: "priority" },
	},
	"google-vertex": {
		label: "Vertex AI priority service tier",
		payload: { serviceTier: "priority" },
		headers: { "X-Vertex-AI-LLM-Shared-Request-Type": "priority" },
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadState(): RoutingState {
	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as unknown;
		if (!isRecord(parsed)) return { models: {} };

		const models: Record<string, boolean> = {};
		if (isRecord(parsed.models)) {
			for (const [key, value] of Object.entries(parsed.models)) {
				if (typeof value === "boolean") models[key] = value;
			}
		}
		return { models, legacyEnabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined };
	} catch {
		return { models: {} };
	}
}

function saveState(state: RoutingState): string | undefined {
	const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify({ models: state.models }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, STATE_PATH);
		return undefined;
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {}
		return error instanceof Error ? error.message : String(error);
	}
}

function modelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function configuredRouteFor(ctx: ExtensionContext): Routing | undefined {
	return ctx.model ? ROUTES[ctx.model.provider] : undefined;
}

function routeFor(ctx: ExtensionContext): Routing | undefined {
	if (!ctx.model) return undefined;
	const route = configuredRouteFor(ctx);
	return route && (!route.supportsModel || route.supportsModel(ctx.model.id)) ? route : undefined;
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const fromHome = relative(resolvedHome, resolvedCwd);
	const insideHome =
		fromHome === "" ||
		(fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
	if (!insideHome) return cwd;
	return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

const OSC8_CLOSE = "\u001B]8;;\u001B\\";

function columns(left: string, right: string, width: number, ellipsis = "..."): string {
	if (!right) return truncateToWidth(left, width, `${OSC8_CLOSE}${ellipsis}`);

	// Keep the right-hand metadata subordinate to the repository/PR details.
	// At tiny widths, drop the right side entirely before sacrificing a PR label.
	const minimumLeftWidth = Math.min(width, visibleWidth(left), 10);
	const rightWidth = Math.max(
		0,
		Math.min(Math.floor(width * 0.45), width - minimumLeftWidth - 2),
	);
	const fittedRight = truncateToWidth(right, rightWidth, "");
	const gap = fittedRight ? 2 : 0;
	const leftWidth = Math.max(0, width - visibleWidth(fittedRight) - gap);
	// If truncation lands inside the PR link, close OSC 8 before the ellipsis so
	// the padding and right-hand column never inherit the link target.
	const fittedLeft = truncateToWidth(
		left,
		leftWidth,
		leftWidth >= 3 ? `${OSC8_CLOSE}${ellipsis}` : OSC8_CLOSE,
	);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)));
	return fittedLeft + padding + fittedRight;
}

function isInside(root: string, path: string): boolean {
	const fromRoot = relative(resolve(root), resolve(path));
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function terminalLink(label: string, url: string): string {
	return getCapabilities().hyperlinks ? hyperlink(label, url) : `${label} (${url})`;
}

function pullRequestColor(status: PullRequestStatus): "dim" | "success" | "error" | "thinkingHigh" {
	if (status === "mergeable") return "success";
	if (status === "not-mergeable") return "error";
	if (status === "merged") return "thinkingHigh";
	return "dim";
}

function gitFlowDetails(
	theme: Theme,
	state: GitFlowFooterState | undefined,
	cwd: string,
	branch: string | null,
): string[] {
	if (!state || state.branch !== branch || !isInside(state.root, cwd)) return [];

	const parts: string[] = [];
	if (state.gitStatus) parts.push(theme.fg("error", state.gitStatus));
	if (state.pullRequest) {
		parts.push(
			theme.fg(
				pullRequestColor(state.pullRequest.status),
				terminalLink(`#${state.pullRequest.number}`, state.pullRequest.url),
			),
		);
	}
	return parts;
}

function appendHeader(headers: Record<string, string | null>, name: string, value: string): void {
	const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
	if (!existingKey) {
		headers[name] = value;
		return;
	}

	const existing = headers[existingKey];
	if (!existing) {
		headers[existingKey] = value;
		return;
	}

	const values = existing.split(",").map((item) => item.trim());
	if (!values.includes(value)) headers[existingKey] = `${existing},${value}`;
}

export default function priorityRouting(pi: ExtensionAPI): void {
	const state = loadState();
	let startupEnabledModelKey: string | undefined;
	let gitFlowState: GitFlowFooterState | undefined;
	let requestFooterRender: (() => void) | undefined;

	const unsubscribeGitFlow = pi.events.on(GIT_FLOW_STATE_EVENT, (data) => {
		if (data !== undefined && !isRecord(data)) return;
		gitFlowState = data as GitFlowFooterState | undefined;
		requestFooterRender?.();
	});

	function isEnabled(ctx: ExtensionContext): boolean {
		const key = modelKey(ctx);
		return key !== undefined && (state.models[key] === true || startupEnabledModelKey === key);
	}

	function isEffective(ctx: ExtensionContext): boolean {
		return isEnabled(ctx) && routeFor(ctx) !== undefined;
	}

	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				gitFlowState = undefined;
				requestRender();
				pi.events.emit(GIT_FLOW_REFRESH_EVENT, undefined);
			});
			return {
				dispose() {
					unsubscribeBranch();
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						input += usage.input;
						output += usage.output;
						cacheRead += usage.cacheRead;
						cacheWrite += usage.cacheWrite;
						cost += usage.cost.total;
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
					}

					const extensionStatuses = footerData.getExtensionStatuses();
					const cwd = formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					const gitAndSessionParts = [theme.fg("dim", cwd)];
					if (branch) gitAndSessionParts.push(theme.fg("dim", branch));
					gitAndSessionParts.push(...gitFlowDetails(theme, gitFlowState, ctx.cwd, branch));
					const gitFlowOperation = sanitize(extensionStatuses.get("git-flow") ?? "");
					if (gitFlowOperation) gitAndSessionParts.push(theme.fg("dim", gitFlowOperation));
					const sessionName = pi.getSessionName();
					if (sessionName) gitAndSessionParts.push(theme.fg("dim", sessionName));
					const gitAndSession = gitAndSessionParts.join(theme.fg("dim", " • "));

					const traffic: string[] = [];
					if (input) traffic.push(`↑${formatTokens(input)}`);
					if (output) traffic.push(`↓${formatTokens(output)}`);
					if (cacheRead) traffic.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) traffic.push(`W${formatTokens(cacheWrite)}`);
					if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) {
						traffic.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}

					const billingAndContext: string[] = [];
					const subscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (cost || subscription) billingAndContext.push(`$${cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percent = context?.percent;
					billingAndContext.push(
						`${percent === null || percent === undefined ? "?" : percent.toFixed(1)}/${formatTokens(contextWindow)} (auto)`,
					);

					const lightning = isEffective(ctx) ? " ⚡" : "";
					const modelName = `${ctx.model?.id ?? "no-model"}${lightning}`;
					let modelAndThinking = modelName;
					if (ctx.model?.reasoning) {
						const thinking = pi.getThinkingLevel();
						modelAndThinking = thinking === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinking}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${modelAndThinking}`;
						if (visibleWidth(withProvider) <= Math.max(20, Math.floor(width * 0.45))) modelAndThinking = withProvider;
					}

					const lines = [
						columns(
							gitAndSession,
							theme.fg("dim", modelAndThinking),
							width,
							theme.fg("dim", "..."),
						),
						theme.fg("dim", columns(traffic.join(" "), billingAndContext.join(" • "), width)),
					];

					const statuses = [...extensionStatuses.entries()]
						.filter(([key]) => key !== "git-flow")
						.map(([, value]) => sanitize(value))
						.filter(Boolean);
					if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
					return lines;
				},
			};
		});
	}

	function refresh(ctx: ExtensionContext): void {
		installFooter(ctx);
	}

	function unavailableReason(ctx: ExtensionContext): string {
		if (!ctx.model) return "No active model.";
		if (!configuredRouteFor(ctx)) return `Priority routing is not mapped for ${ctx.model.provider}.`;
		return `${ctx.model.id} does not support ${configuredRouteFor(ctx)!.label.toLowerCase()}.`;
	}

	function setEnabled(next: boolean, ctx: ExtensionContext, notify = true): void {
		const key = modelKey(ctx);
		if (!key) {
			if (notify && ctx.hasUI) ctx.ui.notify("No active model.", "warning");
			return;
		}
		if (next && !routeFor(ctx)) {
			refresh(ctx);
			if (notify && ctx.hasUI) ctx.ui.notify(unavailableReason(ctx), "warning");
			return;
		}

		state.models[key] = next;
		if (startupEnabledModelKey === key) startupEnabledModelKey = undefined;
		const persistenceError = saveState(state);
		refresh(ctx);
		if (!notify || !ctx.hasUI) return;

		if (next) ctx.ui.notify(`Priority routing enabled for ${key}: ${routeFor(ctx)!.label}.`, "info");
		else ctx.ui.notify(`Priority routing disabled for ${key}.`, "info");
		if (persistenceError) ctx.ui.notify(`Could not remember priority routing: ${persistenceError}`, "warning");
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const arg = args.trim().toLowerCase();
		if (["on", "enable", "enabled"].includes(arg)) setEnabled(true, ctx);
		else if (["off", "disable", "disabled"].includes(arg)) setEnabled(false, ctx);
		else if (arg === "status") {
			const route = routeFor(ctx);
			ctx.ui.notify(
				route
					? `Priority routing is ${isEnabled(ctx) ? "enabled" : "disabled"} for ${modelKey(ctx)}: ${route.label}.`
					: unavailableReason(ctx),
				route ? "info" : "warning",
			);
		} else if (!arg) setEnabled(!isEnabled(ctx), ctx);
		else ctx.ui.notify("Usage: /priority [on|off|status]", "warning");
	}

	pi.registerFlag("priority", {
		description: "Start with provider priority/fast routing enabled",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("fast", {
		description: "Alias for --priority",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("priority", {
		description: "Toggle provider priority routing; accepts on/off/status",
		handler: handleCommand,
	});
	pi.registerCommand("fast", {
		description: "Alias for /priority",
		handler: handleCommand,
	});
	pi.on("session_start", (_event, ctx) => {
		gitFlowState = undefined;
		const key = modelKey(ctx);
		if (state.legacyEnabled !== undefined) {
			if (state.legacyEnabled && key && routeFor(ctx)) state.models[key] = true;
			state.legacyEnabled = undefined;
			saveState(state);
		}
		startupEnabledModelKey =
			(pi.getFlag("priority") === true || pi.getFlag("fast") === true) && key && routeFor(ctx) ? key : undefined;
		installFooter(ctx);
	});
	pi.on("model_select", (_event, ctx) => refresh(ctx));
	pi.on("thinking_level_select", (_event, ctx) => refresh(ctx));

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isEffective(ctx)) return;
		for (const [name, value] of Object.entries(routeFor(ctx)?.headers ?? {})) {
			appendHeader(event.headers, name, value);
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isEffective(ctx) || !isRecord(event.payload)) return;
		return { ...event.payload, ...routeFor(ctx)!.payload };
	});

	pi.on("session_shutdown", () => {
		requestFooterRender = undefined;
		unsubscribeGitFlow();
	});
}
