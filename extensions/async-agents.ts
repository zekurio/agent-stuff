/**
 * Async Subagents - fire-and-forget delegation to background `pi` processes.
 *
 * Unlike the bundled `subagent` example (which blocks until the child exits),
 * every job here runs detached from the parent turn. `start` returns a job id
 * immediately so the main agent keeps working while children run.
 *
 * Actions:
 *   start  { task, model?, label?, cwd?, tools?, system? } -> job id (returns immediately)
 *   list   {}                                              -> table of all jobs
 *   check  { id }                                          -> snapshot, non-blocking
 *   wait   { ids?, timeout? }                              -> block until done/timeout
 *   cancel { id }                                          -> SIGTERM the child
 *
 * UI:
 *   - compact footer/status-bar line (setStatus) summarising running/done/failed
 *   - `/agents` (or ctrl+g) opens a full-screen overlay: arrow-key list, enter
 *     to inspect a live transcript, left/right to move between agents.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Message, StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_CONCURRENT = 6;
const OUTPUT_CAP = 48 * 1024;
const DEFAULT_WAIT_SECONDS = 300;
const POLL_INTERVAL_MS = 250;
const TRANSCRIPT_CAP = 400;
const PREVIEW_CHARS = 160;
const SCROLL_STEP = 6;
/** Status glyph shared by the footer, the overlay and tool results. */
const SQUARE = "■";

type JobStatus = "running" | "done" | "failed" | "canceled";

interface JobUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

type AssistantPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "toolCall"; name: string; preview: string };

type TranscriptItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; parts: AssistantPart[] }
	| { kind: "toolResult"; name: string; preview: string; isError: boolean };

interface LiveTool {
	name: string;
	preview: string;
	done: boolean;
	isError: boolean;
}

interface Job {
	id: string;
	sessionId: string;
	label: string;
	task: string;
	model: string;
	cwd: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	messages: Message[];
	toolCalls: { name: string; args: Record<string, unknown> }[];
	/** Normalized, render-ready conversation for the overlay viewer. */
	transcript: TranscriptItem[];
	/** Partially streamed assistant message (cleared once finalized). */
	liveAssistant?: { text: string; thinking: string };
	/** Tool calls currently executing, keyed by toolCallId. */
	liveTools: Map<string, LiveTool>;
	stderr: string;
	usage: JobUsage;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	proc?: ChildProcess;
	promise: Promise<void>;
	collected: boolean;
	finished: boolean;
	killTimer?: ReturnType<typeof setTimeout>;
}

interface AsyncAgentsRuntime {
	schemaVersion: 1;
	jobs: Map<string, Job>;
	jobCounter: number;
	listeners: Set<() => void>;
	notifyTimer?: ReturnType<typeof setTimeout>;
	statusTimer?: ReturnType<typeof setTimeout>;
	uiCtx?: ExtensionContext;
	sessionId?: string;
}

const RUNTIME_KEY = Symbol.for("zekurio.pi.async-agents.runtime");
const globalRuntime = globalThis as any;
const runtime: AsyncAgentsRuntime = globalRuntime[RUNTIME_KEY] ?? {
	schemaVersion: 1,
	jobs: new Map<string, Job>(),
	jobCounter: 0,
	listeners: new Set<() => void>(),
};
globalRuntime[RUNTIME_KEY] = runtime;
const jobs = runtime.jobs;

// --- Change notification -------------------------------------------------------
// The overlay views subscribe here so a streaming child repaints live.

const listeners = runtime.listeners;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Coalesce token-rate events into at most one repaint per 60ms. */
function notifyChanged(): void {
	if (!runtime.notifyTimer) {
		runtime.notifyTimer = setTimeout(() => {
			runtime.notifyTimer = undefined;
			for (const listener of listeners) listener();
		}, 60);
	}
	// The footer redraws the whole bar, so it gets a slower cadence than the
	// overlay: 500ms is enough for elapsed seconds and tool-name changes.
	if (!runtime.statusTimer) {
		runtime.statusTimer = setTimeout(() => {
			runtime.statusTimer = undefined;
			updateStatus();
		}, 500);
	}
}

function nextJobId(): string {
	runtime.jobCounter += 1;
	return `a${runtime.jobCounter}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(job: Job): string {
	const end = job.endedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - job.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatUsage(job: Job): string {
	const parts: string[] = [];
	if (job.usage.turns) parts.push(`${job.usage.turns} turn${job.usage.turns > 1 ? "s" : ""}`);
	if (job.usage.input) parts.push(`↑${formatTokens(job.usage.input)}`);
	if (job.usage.output) parts.push(`↓${formatTokens(job.usage.output)}`);
	if (job.usage.cacheRead) parts.push(`R${formatTokens(job.usage.cacheRead)}`);
	if (job.usage.cost) parts.push(`$${job.usage.cost.toFixed(4)}`);
	parts.push(formatDuration(job));
	return parts.join(" ");
}

function finalText(job: Job): string {
	for (let i = job.messages.length - 1; i >= 0; i--) {
		const message = job.messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim()) return part.text;
		}
	}
	return "";
}

function jobOutput(job: Job): string {
	const text =
		finalText(job) || job.errorMessage || job.stderr.trim() || (job.status === "running" ? "(running)" : "(no output)");
	if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP) return text;
	let truncated = text.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[truncated — full output kept in tool details]`;
}

/** Monochrome glyphs only — emoji clash with the nerdfont/unicode symbols used elsewhere. */
function statusIcon(status: JobStatus): string {
	if (status === "running") return SQUARE;
	if (status === "done") return "✓";
	if (status === "canceled") return "⊘";
	return "✗";
}

function statusColor(status: JobStatus): "warning" | "success" | "muted" | "error" {
	if (status === "running") return "warning";
	if (status === "done") return "success";
	if (status === "canceled") return "muted";
	return "error";
}

/** Current activity of a running job: last tool, or "thinking"/"writing". */
function activityLine(job: Job): string {
	const live = [...job.liveTools.values()].filter((tool) => !tool.done);
	if (live.length) return live.map((tool) => tool.name).join(", ");
	if (job.liveAssistant?.text.trim()) return "writing";
	if (job.liveAssistant?.thinking.trim()) return "thinking";
	const lastCall = job.toolCalls[job.toolCalls.length - 1];
	return lastCall ? lastCall.name : "starting";
}

// --- Transcript ingestion ------------------------------------------------------

function clip(text: string, max = PREVIEW_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Strip ANSI/control chars: raw escapes desync the overlay's width math. */
function sanitize(text: string): string {
	return text
		// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sanitisation
		.replace(/[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]/g, "")
		.replaceAll("\t", "  ")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sanitisation
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function pushTranscript(job: Job, item: TranscriptItem): void {
	job.transcript.push(item);
	if (job.transcript.length > TRANSCRIPT_CAP) job.transcript.splice(0, job.transcript.length - TRANSCRIPT_CAP);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => part.text as string)
		.join("\n");
}

/** Fold one pi JSON-mode session event into the job's live state. */
function ingest(job: Job, event: any): void {
	switch (event.type) {
		case "message_start": {
			if (event.message?.role === "assistant") job.liveAssistant = { text: "", thinking: "" };
			break;
		}
		case "message_update": {
			// event.message is the in-progress message; re-deriving from it is
			// cheaper to keep correct than accumulating deltas by hand.
			const parts = event.message?.content ?? [];
			const live = { text: "", thinking: "" };
			for (const part of parts) {
				if (part.type === "text") live.text += part.text ?? "";
				else if (part.type === "thinking") live.thinking += part.thinking ?? "";
			}
			job.liveAssistant = live;
			break;
		}
		case "message_end": {
			const message = event.message as Message | undefined;
			if (!message) break;
			job.messages.push(message);
			if (message.role === "assistant") {
				job.liveAssistant = undefined;
				job.usage.turns += 1;
				const usage = (message as any).usage;
				if (usage) {
					job.usage.input += usage.input || 0;
					job.usage.output += usage.output || 0;
					job.usage.cacheRead += usage.cacheRead || 0;
					job.usage.cacheWrite += usage.cacheWrite || 0;
					job.usage.cost += usage.cost?.total || 0;
				}
				if ((message as any).stopReason) job.stopReason = (message as any).stopReason;
				if ((message as any).errorMessage) job.errorMessage = (message as any).errorMessage;

				const parts: AssistantPart[] = [];
				for (const part of message.content as any[]) {
					if (part.type === "text" && part.text?.trim()) parts.push({ type: "text", text: part.text });
					else if (part.type === "thinking" && part.thinking?.trim())
						parts.push({ type: "thinking", text: part.redacted ? "[redacted reasoning]" : part.thinking });
					else if (part.type === "toolCall") {
						job.toolCalls.push({ name: part.name, args: part.arguments });
						parts.push({ type: "toolCall", name: part.name, preview: clip(JSON.stringify(part.arguments ?? {}), 80) });
					}
				}
				if (parts.length) pushTranscript(job, { kind: "assistant", parts });
			} else if (message.role === "toolResult") {
				const result = message as any;
				job.liveTools.delete(result.toolCallId);
				pushTranscript(job, {
					kind: "toolResult",
					name: result.toolName ?? "tool",
					preview: clip(contentText(result.content)),
					isError: Boolean(result.isError),
				});
			} else if (message.role === "user") {
				pushTranscript(job, { kind: "user", text: clip(contentText((message as any).content), 400) });
			}
			break;
		}
		case "tool_execution_start": {
			job.liveTools.set(event.toolCallId, { name: event.toolName, preview: "", done: false, isError: false });
			break;
		}
		case "tool_execution_update": {
			const tool = job.liveTools.get(event.toolCallId);
			if (tool) tool.preview = clip(contentText(event.partialResult?.content ?? event.partialResult ?? ""), 80);
			break;
		}
		case "tool_execution_end": {
			const tool = job.liveTools.get(event.toolCallId);
			if (tool) {
				tool.done = true;
				tool.isError = Boolean(event.isError);
				tool.preview = clip(contentText(event.result?.content ?? event.result ?? ""), 80);
			}
			break;
		}
	}
	notifyChanged();
}

// --- Approved models / tiers ---------------------------------------------------

type TierName = "easy" | "medium" | "hard";

interface Tier {
	/** What kind of job this tier is for; shown to the caller verbatim. */
	blurb: string;
	/** Ordered "provider/id[:thinking]" candidates; the first one the registry has wins. */
	candidates: string[];
}

/**
 * The approved subagent models, grouped by how hard the job is. Callers pick a
 * tier, not a slug: exposing the whole registry made the caller anchor on
 * whatever cheap entry it happened to see first (haiku, gpt-5.4-mini) and hand
 * real work to it. Nothing outside this table is ever named to the model, and
 * an unapproved slug is rejected rather than fuzzy-matched into the registry.
 *
 * Candidates degrade in order, so an unauthenticated provider does not break a
 * tier. Edit this table to change what subagents may run on.
 */
const TIERS: Record<TierName, Tier> = {
	easy: {
		blurb: "search, recon, log/diff triage, summarising, mechanical edits",
		candidates: ["openai-codex/gpt-5.6-luna:high", "opencode-go/deepseek-v4-flash:max"],
	},
	medium: {
		blurb: "scoped implementation, tests, docs, reviewing a known-shape change",
		candidates: ["openai-codex/gpt-5.6-terra:xhigh", "opencode-go/glm-5.2:max"],
	},
	hard: {
		blurb: "design, cross-cutting refactors, ambiguous debugging, tricky code",
		candidates: ["openai-codex/gpt-5.6-sol:xhigh", "anthropic/claude-fable-5:high", "opencode-go/kimi-k3:max"],
	},
};

const TIER_NAMES = Object.keys(TIERS) as TierName[];
const DEFAULT_TIER: TierName = "medium";

/** Forgiving synonyms, so a near-miss tier name is not treated as a model slug. */
const TIER_ALIASES: Record<string, TierName> = {
	small: "easy",
	fast: "easy",
	cheap: "easy",
	scout: "easy",
	low: "easy",
	mid: "medium",
	normal: "medium",
	standard: "medium",
	default: "medium",
	big: "hard",
	deep: "hard",
	large: "hard",
	smart: "hard",
	complex: "hard",
};

function splitThinking(raw: string): { base: string; thinking?: string } {
	const i = raw.lastIndexOf(":");
	if (i <= 0 || i < raw.indexOf("/")) return { base: raw };
	return { base: raw.slice(0, i), thinking: raw.slice(i + 1) };
}

function tierModels(name: TierName): string[] {
	return TIERS[name].candidates.map((candidate) => splitThinking(candidate).base);
}

/** Tier list for descriptions and errors; never leaks the full registry. */
function tierHelp(): string {
	// Shows the raw first candidate, thinking suffix included: two tiers may share a
	// model and differ only in reasoning effort.
	return TIER_NAMES.map((name) => `'${name}' — ${TIERS[name].blurb} (${TIERS[name].candidates[0]})`).join("; ");
}

function approvedHelp(): string {
	return TIER_NAMES.map((name) => `${name}: ${tierModels(name).join(", ")}`).join(" | ");
}

/** Exact provider/id lookup in the live registry, preserving any thinking suffix. */
function findAvailable(ctx: ExtensionContext, slug: string): string | undefined {
	const { base, thinking } = splitThinking(slug);
	const [provider, ...rest] = base.split("/");
	const id = rest.join("/");
	const hit = ctx.modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === id);
	return hit ? `${hit.provider}/${hit.id}${thinking ? `:${thinking}` : ""}` : undefined;
}

type Resolved = { slug: string; error?: undefined } | { slug?: undefined; error: string };

function resolveTier(ctx: ExtensionContext, name: TierName, thinkingOverride?: string): Resolved {
	for (const candidate of TIERS[name].candidates) {
		const found = findAvailable(ctx, candidate);
		if (!found) continue;
		if (!thinkingOverride) return { slug: found };
		return { slug: `${splitThinking(found).base}:${thinkingOverride}` };
	}
	return {
		error: `No model for tier '${name}' is available in this session (approved for it: ${TIERS[name].candidates.join(", ")}). Try another tier (${TIER_NAMES.join(", ")}) or edit TIERS in async-agents.ts.`,
	};
}

// --- Model resolution / spawning -----------------------------------------------

/** Resolve a tier name (preferred) or an approved slug to "provider/model[:thinking]". */
function resolveModel(ctx: ExtensionContext, slug: string | undefined): Resolved {
	const raw = slug?.trim();
	if (!raw) return resolveTier(ctx, DEFAULT_TIER);

	const { base, thinking } = splitThinking(raw);
	const key = base.toLowerCase();
	const tier = (TIER_NAMES as string[]).includes(key) ? (key as TierName) : TIER_ALIASES[key];
	if (tier) return resolveTier(ctx, tier, thinking);

	// Explicit slugs still work, but only for models on the approved list above.
	const approved = TIER_NAMES.flatMap(tierModels);
	const match =
		approved.find((s) => s === base) ??
		approved.find((s) => s.split("/").slice(1).join("/") === base) ??
		approved.find((s) => s.toLowerCase().includes(key));
	if (!match) {
		return {
			error: `"${raw}" is not an approved subagent model. Pass a difficulty tier instead — ${tierHelp()}. Approved slugs: ${approvedHelp()}.`,
		};
	}

	const found = findAvailable(ctx, thinking ? `${match}:${thinking}` : match);
	if (!found) {
		return { error: `Approved model "${match}" is not available in this session. Pass a tier instead: ${TIER_NAMES.join(", ")}.` };
	}
	return { slug: found };
}

/** Mirrors the bundled subagent example so this works from a compiled binary too. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function launch(
	ctx: ExtensionContext,
	options: { task: string; modelSlug: string; label: string; cwd: string; tools?: string[]; system?: string },
): Job {
	const id = nextJobId();
	const args = ["--mode", "json", "-p", "--no-session", "--model", options.modelSlug];
	if (options.tools?.length) args.push("--tools", options.tools.join(","));
	// Children discover this same extension, so block recursive delegation unless
	// the caller opted in explicitly. Extensions stay enabled otherwise because
	// provider auth may be supplied by one.
	if (!options.tools?.includes("agent")) args.push("--exclude-tools", "agent");

	let promptFile: string | undefined;
	if (options.system?.trim()) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-agent-"));
		promptFile = path.join(dir, "system.md");
		fs.writeFileSync(promptFile, options.system, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptFile);
	}
	args.push(`Task: ${options.task}`);

	const job: Job = {
		id,
		sessionId: ctx.sessionManager.getSessionId(),
		label: options.label,
		task: options.task,
		model: options.modelSlug,
		cwd: options.cwd,
		status: "running",
		startedAt: Date.now(),
		messages: [],
		toolCalls: [],
		transcript: [],
		liveTools: new Map(),
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		promise: Promise.resolve(),
		collected: false,
		finished: false,
	};

	job.promise = new Promise<void>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group: a Ctrl+C that aborts the parent turn must not kill
			// background jobs. Cleanup is explicit (cancel / session_shutdown).
			detached: true,
		});
		job.proc = proc;

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			ingest(job, event);
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			job.stderr = `${job.stderr}${data.toString()}`.slice(-8192);
		});

		const finish = (code: number | null) => {
			if (job.finished) return;
			job.finished = true;
			if (job.killTimer) clearTimeout(job.killTimer);
			job.killTimer = undefined;
			if (buffer.trim()) processLine(buffer);
			job.exitCode = code ?? 0;
			job.endedAt = Date.now();
			job.proc = undefined;
			job.liveAssistant = undefined;
			job.liveTools.clear();
			if (job.status !== "canceled") {
				const failed = job.exitCode !== 0 || job.stopReason === "error" || job.stopReason === "aborted";
				job.status = failed ? "failed" : "done";
			}
			if (promptFile) {
				try {
					fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
			const activeCtx = runtime.uiCtx;
			if (
				activeCtx?.hasUI &&
				runtime.sessionId === job.sessionId &&
				jobs.get(job.id) === job
			) {
				const verb = job.status === "done" ? "finished" : job.status;
				activeCtx.ui.notify(
					`Subagent ${job.id} (${job.label}) ${verb} in ${formatDuration(job)} — /agents to view`,
					job.status === "done" ? "info" : "warning",
				);
			}
			updateStatus();
			notifyChanged();
			resolve();
		};

		proc.on("close", (code) => finish(code));
		proc.on("error", (error) => {
			job.stderr += `\nspawn error: ${error.message}`;
			finish(1);
		});
	});

	jobs.set(id, job);
	updateStatus();
	return job;
}

// --- Footer status bar ---------------------------------------------------------

/**
 * The session UI context. Tool-execution contexts expose a reduced `ui` whose
 * status registration does not survive an overlay teardown, so every footer
 * write goes through the context captured at session_start. It lives in the
 * process-global runtime so running children can attach to the new UI on reload.
 */

/** Compact one-liner rendered in pi's bottom bar via ui.setStatus. */
function updateStatus(): void {
	const ctx = runtime.uiCtx;
	if (!ctx?.hasUI || ctx.mode !== "tui") return;
	const all = [...jobs.values()];
	if (all.length === 0) {
		ctx.ui.setStatus("agents", undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const running = all.filter((job) => job.status === "running");
	const failed = all.filter((job) => job.status === "failed" || job.status === "canceled").length;
	const done = all.length - running.length - failed;

	const parts: string[] = [];
	if (running.length) parts.push(theme.fg("warning", `${SQUARE} ${running.length} running`));
	if (done) parts.push(theme.fg("success", `${SQUARE} ${done} done`));
	if (failed) parts.push(theme.fg("error", `${SQUARE} ${failed} failed`));
	// Show what the most recent running agent is up to, like a live tail.
	const newest = running[running.length - 1];
	if (newest) parts.push(theme.fg("dim", `${newest.id} ${activityLine(newest)} ${formatDuration(newest)}`));
	parts.push(theme.fg("accent", "/agents") + theme.fg("dim", " to view"));

	ctx.ui.setStatus("agents", `${theme.fg("dim", "agents:")} ${parts.join(theme.fg("dim", " · "))}`);
}

function jobSummaryLine(job: Job): string {
	return `${statusIcon(job.status)} ${job.id} [${job.status}] ${job.label} · ${job.model} · ${formatUsage(job)}`;
}

/**
 * Subagents are scoped to the thread that started them. The module stays loaded
 * across session swaps, so wipe the registry explicitly instead of relying on a
 * fresh module instance.
 */
function resetJobs(): void {
	for (const job of jobs.values()) if (job.status === "running") killJob(job);
	jobs.clear();
	runtime.jobCounter = 0;
	updateStatus();
}

function killJob(job: Job): void {
	if (!job.proc) return;
	job.status = "canceled";
	const proc = job.proc;
	try {
		// Negative pid targets the detached process group.
		process.kill(-(proc.pid as number), "SIGTERM");
	} catch {
		try {
			proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	}
	if (job.killTimer) clearTimeout(job.killTimer);
	job.killTimer = setTimeout(() => {
		try {
			if (proc.pid) process.kill(-proc.pid, "SIGKILL");
		} catch {
			/* ignore */
		}
	}, 5000);
	notifyChanged();
}

// --- Overlay UI ----------------------------------------------------------------

function themeStatus(theme: Theme, status: JobStatus): string {
	return theme.fg(statusColor(status), SQUARE);
}

const CTRL_C = "\x03";

function keyLabel(keybindings: KeybindingsManager, binding: any): string {
	try {
		return keybindings.getKeys(binding).join("/") || "unbound";
	} catch {
		return "?";
	}
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function columns(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, width);
}

/** Render one job's conversation as wrapped, themed lines. */
function buildTranscriptLines(job: Job, width: number, theme: Theme): string[] {
	const out: string[] = [];
	const push = (line: string) => out.push(truncateToWidth(line, width));

	for (const item of job.transcript) {
		const before = out.length;
		if (item.kind === "user") {
			for (const [i, line] of wrapTextWithAnsi(sanitize(item.text), Math.max(10, width - 2)).entries()) {
				push((i === 0 ? theme.fg("accent", "> ") : "  ") + theme.fg("userMessageText", line));
			}
		} else if (item.kind === "assistant") {
			for (const part of item.parts) {
				if (part.type === "text") {
					for (const line of wrapTextWithAnsi(sanitize(part.text).trim(), width)) push(line);
				} else if (part.type === "thinking") {
					for (const [i, line] of wrapTextWithAnsi(sanitize(part.text).trim(), Math.max(10, width - 2)).entries()) {
						push((i === 0 ? theme.fg("dim", "~ ") : "  ") + theme.fg("muted", theme.italic(line)));
					}
				} else {
					push(
						theme.fg("muted", "→ ") +
							theme.fg("toolTitle", part.name) +
							(part.preview && part.preview !== "{}" ? theme.fg("dim", ` ${sanitize(part.preview)}`) : ""),
					);
				}
			}
		} else {
			const label = item.isError ? theme.fg("error", "  error: ") : theme.fg("dim", "  output: ");
			push(label + theme.fg("dim", sanitize(item.preview) || "(no output)"));
		}
		if (out.length > before) out.push("");
	}
	while (out.length && out[out.length - 1] === "") out.pop();

	if (job.liveAssistant) {
		const { thinking, text } = job.liveAssistant;
		if (thinking.trim() || text.trim()) out.push("");
		if (thinking.trim()) {
			for (const [i, line] of wrapTextWithAnsi(sanitize(thinking).trim(), Math.max(10, width - 2)).entries()) {
				push((i === 0 ? theme.fg("dim", "~ ") : "  ") + theme.fg("muted", theme.italic(line)));
			}
		}
		if (text.trim()) for (const line of wrapTextWithAnsi(sanitize(text).trim(), width)) push(line);
	}

	for (const tool of job.liveTools.values()) {
		out.push("");
		const marker = tool.done
			? tool.isError
				? theme.fg("error", "error")
				: theme.fg("success", "done")
			: theme.fg("warning", "running");
		push(theme.fg("toolTitle", tool.name) + ` · ${marker}` + (tool.preview ? theme.fg("dim", ` · ${sanitize(tool.preview)}`) : ""));
	}

	if (job.status !== "running" && !job.transcript.length) {
		push(theme.fg("dim", job.stderr.trim() || "(no output)"));
	}
	return out;
}

interface Selection {
	id?: string;
	index: number;
}

function reconcile(selection: Selection, list: Job[]): void {
	const stable = selection.id ? list.findIndex((job) => job.id === selection.id) : -1;
	selection.index = stable >= 0 ? stable : Math.min(Math.max(0, selection.index), Math.max(0, list.length - 1));
	selection.id = list[selection.index]?.id;
}

/** Full-screen list of every job; enter opens the detail viewer. */
class AgentDashboard implements Component {
	private ticker: ReturnType<typeof setInterval>;
	private unsubscribe: () => void;
	private closed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private selection: Selection,
		private done: (id: string | null) => void,
	) {
		this.ticker = setInterval(() => this.tui.requestRender(), 1000);
		this.unsubscribe = subscribe(() => this.tui.requestRender());
	}

	private list(): Job[] {
		return [...jobs.values()];
	}

	private cleanup(): boolean {
		if (this.closed) return false;
		this.closed = true;
		clearInterval(this.ticker);
		this.unsubscribe();
		return true;
	}

	dispose(): void {
		this.cleanup();
	}

	private close(result: string | null): void {
		if (this.cleanup()) this.done(result);
	}

	handleInput(data: string): void {
		const list = this.list();
		reconcile(this.selection, list);
		const kb = this.keybindings;

		// `app.interrupt` is also bound to escape, so matching it here would be
		// redundant: tui.select.cancel already covers escape and ctrl+c.
		if (data === "q" || kb.matches(data, "tui.select.cancel")) return this.close(null);
		if (kb.matches(data, "tui.select.confirm")) {
			const job = list[this.selection.index];
			if (job) this.close(job.id);
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") {
			if (list.length) {
				this.selection.index = (this.selection.index - 1 + list.length) % list.length;
				this.selection.id = list[this.selection.index]?.id;
				this.tui.requestRender();
			}
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			if (list.length) {
				this.selection.index = (this.selection.index + 1) % list.length;
				this.selection.id = list[this.selection.index]?.id;
				this.tui.requestRender();
			}
			return;
		}
		if (data === "x") {
			const job = list[this.selection.index];
			if (job?.status === "running") killJob(job);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const list = this.list();
		reconcile(this.selection, list);

		const rows = this.tui.terminal.rows || 30;
		const bodyHeight = Math.max(6, rows - 5);
		const inner = width - 2;
		const lines: string[] = [];

		const running = list.filter((job) => job.status === "running").length;
		lines.push(
			columns(
				`  ${theme.fg("accent", theme.bold("Background agents"))}`,
				`${theme.fg("muted", `${running} running · ${list.length} total`)}  `,
				width,
			),
		);
		lines.push(theme.fg("border", `╭${"─".repeat(inner)}╮`));

		const bar = theme.fg("border", "│");
		const rowLines = this.rows(list, inner, bodyHeight);
		for (let i = 0; i < bodyHeight; i++) lines.push(bar + pad(rowLines[i] ?? "", inner) + bar);

		lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`  ↑↓/jk select · ${keyLabel(this.keybindings, "tui.select.confirm")} open · x cancel agent · esc/q close`,
				),
				width,
			),
		);
		return lines;
	}

	private rows(list: Job[], width: number, height: number): string[] {
		const theme = this.theme;
		const out: string[] = [];
		let start = 0;
		if (list.length > height) {
			start = Math.min(Math.max(0, this.selection.index - Math.floor(height / 2)), list.length - height);
		}

		for (const [offset, job] of list.slice(start, start + height).entries()) {
			const index = start + offset;
			const selected = index === this.selection.index;
			const marker = selected ? theme.fg("accent", "❯") : " ";
			const title = selected ? theme.fg("accent", job.label) : theme.fg("text", job.label);
			const left = ` ${marker} ${themeStatus(theme, job.status)} ${title} ${theme.fg("dim", job.id)}`;

			const dot = theme.fg("dim", " · ");
			const detail = job.status === "running" ? activityLine(job) : job.status;
			const right = `${[
				theme.fg("muted", job.model.split("/").pop() ?? job.model),
				theme.fg("muted", `${job.usage.turns}t ${formatTokens(job.usage.output)}↓`),
				theme.fg("muted", formatDuration(job)),
				job.status === "running" ? theme.fg("warning", detail) : themeWord(theme, job.status),
			].join(dot)} `;

			out.push(columns(truncateToWidth(left, Math.max(0, width - visibleWidth(right) - 2)), right, width));
		}

		if (start > 0) out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
		if (start + height < list.length) {
			out[out.length - 1] = truncateToWidth(theme.fg("dim", `   ... ${list.length - start - height} more`), width);
		}
		return out;
	}

	invalidate(): void {}
}

function themeWord(theme: Theme, status: JobStatus): string {
	if (status === "done") return theme.fg("success", "done");
	if (status === "running") return theme.fg("warning", "running");
	if (status === "canceled") return theme.fg("muted", "canceled");
	return theme.fg("error", "failed");
}

type DetailResult = { kind: "close" } | { kind: "back" };

/** Live transcript of a single job, with ←/→ to walk between agents. */
class AgentDetail implements Component {
	private scrollOffset = 0;
	private ticker: ReturnType<typeof setInterval>;
	private unsubscribe: () => void;
	private closed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private selection: Selection,
		private done: (result: DetailResult) => void,
	) {
		this.ticker = setInterval(() => this.tui.requestRender(), 1000);
		this.unsubscribe = subscribe(() => this.tui.requestRender());
	}

	private list(): Job[] {
		return [...jobs.values()];
	}

	private job(): Job | undefined {
		const list = this.list();
		reconcile(this.selection, list);
		return list[this.selection.index];
	}

	private cleanup(): boolean {
		if (this.closed) return false;
		this.closed = true;
		clearInterval(this.ticker);
		this.unsubscribe();
		return true;
	}

	dispose(): void {
		this.cleanup();
	}

	private close(result: DetailResult): void {
		if (this.cleanup()) this.done(result);
	}

	private step(delta: number): void {
		const list = this.list();
		if (!list.length) return;
		this.selection.index = (this.selection.index + delta + list.length) % list.length;
		this.selection.id = list[this.selection.index]?.id;
		this.scrollOffset = 0;
		this.tui.requestRender();
	}

	private viewport(): number {
		return Math.max(6, (this.tui.terminal.rows || 30) - 7);
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		// ctrl+c must be tested first: it is part of tui.select.cancel, and escape
		// is bound to both tui.select.cancel and app.interrupt. Testing bindings
		// here would make one of the two branches unreachable.
		if (data === CTRL_C || data === "q") return this.close({ kind: "close" });
		if (kb.matches(data, "tui.select.cancel")) return this.close({ kind: "back" });

		if (kb.matches(data, "tui.editor.cursorLeft") || data === "h") return this.step(-1);
		if (kb.matches(data, "tui.editor.cursorRight") || data === "l") return this.step(1);

		if (kb.matches(data, "tui.editor.cursorUp") || data === "k") {
			this.scrollOffset += SCROLL_STEP;
			return this.tui.requestRender();
		}
		if (kb.matches(data, "tui.editor.cursorDown") || data === "j") {
			this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
			return this.tui.requestRender();
		}
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.scrollOffset += this.viewport();
			return this.tui.requestRender();
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewport());
			return this.tui.requestRender();
		}
		if (data === "g") {
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
			return this.tui.requestRender();
		}
		if (data === "G") {
			this.scrollOffset = 0;
			return this.tui.requestRender();
		}
		if (data === "x") {
			const job = this.job();
			if (job?.status === "running") killJob(job);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const theme = this.theme;
		const job = this.job();
		const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		if (!job) return [border, theme.fg("dim", "no agents"), border];

		const list = this.list();
		const position = `${this.selection.index + 1}/${list.length}`;
		const lines: string[] = [border];
		lines.push(
			columns(
				`${themeStatus(theme, job.status)} ${theme.fg("accent", theme.bold(`${job.id} · ${job.label}`))}` +
					theme.fg("muted", ` · ${job.status} · ${formatDuration(job)}`),
				theme.fg("dim", `${job.model} · ${formatUsage(job)} · ${position}`),
				width,
			),
		);
		lines.push(truncateToWidth(theme.fg("dim", `task: ${clip(job.task, Math.max(20, width - 8))}`), width));
		lines.push(border);

		// Fixed-height viewport: streaming must never change the overlay height.
		const viewport = this.viewport();
		const transcript = buildTranscriptLines(job, width, theme);
		const maxOffset = Math.max(0, transcript.length - viewport);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

		const end = transcript.length - this.scrollOffset;
		const visible = transcript.slice(Math.max(0, end - viewport), end);
		const body = visible.length ? [...visible] : [theme.fg("dim", "(no output yet)")];
		if (this.scrollOffset > 0) {
			body[body.length - 1] = truncateToWidth(theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`), width);
		}
		while (body.length < viewport) body.push("");
		lines.push(...body.slice(0, viewport));

		lines.push(border);
		lines.push(
			truncateToWidth(
				theme.fg("dim", "←→ agent · ↑↓ scroll · pgup/pgdn · g/G top/end · x cancel · esc list · q close"),
				width,
			),
		);
		return lines;
	}

	invalidate(): void {}
}

const OVERLAY = {
	overlay: true,
	overlayOptions: { anchor: "center" as const, width: "100%" as const, maxHeight: "100%" as const },
};

/** List -> detail -> list loop, mirroring how the built-in pickers behave. */
async function openAgentUI(ctx: ExtensionCommandContext | ExtensionContext, startId?: string): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui?.notify?.("The agents overlay needs the interactive TUI.", "warning");
		return;
	}
	if (jobs.size === 0) {
		ctx.ui.notify("No background agents yet.", "info");
		return;
	}

	const selection: Selection = { index: 0, id: startId };
	let inDetail = Boolean(startId);

	while (true) {
		if (jobs.size === 0) return;
		if (inDetail) {
			const result = await ctx.ui.custom<DetailResult>(
				(tui, theme, keybindings, done) => new AgentDetail(tui, theme, keybindings, selection, done),
				OVERLAY,
			);
			if (result.kind === "close") return;
			inDetail = false;
			continue;
		}
		const picked = await ctx.ui.custom<string | null>(
			(tui, theme, keybindings, done) => new AgentDashboard(tui, theme, keybindings, selection, done),
			OVERLAY,
		);
		if (!picked) return;
		selection.id = picked;
		inDetail = true;
	}
}

// --- Tool ----------------------------------------------------------------------

const ActionSchema = StringEnum(["start", "list", "check", "wait", "cancel"] as const, {
	description: "start: launch a background agent. list: all jobs. check: snapshot. wait: block for results. cancel: kill.",
});

const Params = Type.Object({
	action: ActionSchema,
	task: Type.Optional(Type.String({ description: "The task for the subagent. Required for 'start'. Be specific and self-contained: the subagent sees none of this conversation." })),
	model: Type.Optional(
		StringEnum(TIER_NAMES, {
			description: `Difficulty tier of the job, which selects the model: ${tierHelp()}. Defaults to '${DEFAULT_TIER}'. Match the tier to the work, not to cost.`,
			default: DEFAULT_TIER,
		}),
	),
	label: Type.Optional(Type.String({ description: "Short name for this job, shown in the UI. Defaults to a slug of the task." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to the current directory." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Allowlist of tool names, e.g. ['read','grep','find','ls']. Omit for all default tools." })),
	system: Type.Optional(Type.String({ description: "Extra system prompt text appended for this subagent only." })),
	id: Type.Optional(Type.String({ description: "Job id for 'check' and 'cancel'." })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "Job ids for 'wait'. Omit to wait for every running job." })),
	timeout: Type.Optional(Type.Number({ description: `Seconds to wait before giving up. Default ${DEFAULT_WAIT_SECONDS}.` })),
});

interface Details {
	action: string;
	jobs: {
		id: string;
		label: string;
		task: string;
		model: string;
		status: JobStatus;
		output: string;
		toolCalls: { name: string; args: Record<string, unknown> }[];
		usage: string;
	}[];
}

function toDetails(action: string, list: Job[]): Details {
	return {
		action,
		jobs: list.map((job) => ({
			id: job.id,
			label: job.label,
			task: job.task,
			model: job.model,
			status: job.status,
			output: jobOutput(job),
			toolCalls: job.toolCalls,
			usage: formatUsage(job),
		})),
	};
}

function text(body: string, details: Details): AgentToolResult<Details> {
	return { content: [{ type: "text", text: body }], details };
}

/**
 * pi only flags a tool result as failed when execute() throws; a returned
 * object is always treated as success regardless of its fields.
 */
function fail(message: string): never {
	throw new Error(message);
}

export default function asyncAgents(pi: ExtensionAPI): void {
	let unbindHotkey: (() => void) | undefined;
	let overlayOpen = false;

	const openUI = async (ctx: ExtensionCommandContext | ExtensionContext, id?: string) => {
		if (overlayOpen) return;
		overlayOpen = true;
		try {
			await openAgentUI(ctx, id);
		} finally {
			overlayOpen = false;
			// Closing an overlay drops extension statuses from the footer; put ours back.
			updateStatus();
		}
	};

	pi.on("session_start", (event, ctx) => {
		// New/resumed/forked thread: never inherit the previous thread's jobs or footer.
		// "startup" and "reload" keep the current thread, so they keep their agents.
		if (event.reason !== "startup" && event.reason !== "reload") resetJobs();
		runtime.sessionId = ctx.sessionManager.getSessionId();
		runtime.uiCtx = ctx;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		updateStatus();
		// ctrl+g mirrors /agents without stealing an existing pi binding.
		unbindHotkey = ctx.ui.onTerminalInput((data) => {
			if (data !== "\x07") return undefined;
			void openUI(ctx);
			return { consume: true };
		});
	});

	pi.registerTool({
		name: "agent",
		label: "Async Agent",
		description: [
			"Run subagents in background `pi` processes with isolated context windows.",
			"'start' returns a job id immediately and does NOT block — keep working, then 'wait' to collect results.",
			"Launch several jobs back-to-back to parallelize, then 'wait' once for all of them.",
			"Each subagent starts with a blank context: put every needed detail in `task` and ask for a concrete written answer.",
			`Set \`model\` to the difficulty tier of the job — ${tierHelp()} — not to a model name; the tier picks an approved model.`,
		].join(" "),
		promptSnippet: "agent: delegate work to background subagents (start/list/check/wait/cancel) with a per-task difficulty tier",
		promptGuidelines: [
			"Use the agent tool for independent, well-scoped work (codebase recon, test runs, doc drafting) so it overlaps with your own work.",
			"Prefer starting several agents at once and calling wait a single time over interleaving start/wait pairs.",
			`Choose the agent \`model\` tier by task difficulty (${TIER_NAMES.join(" < ")}); do not downgrade a hard task to a cheaper tier.`,
		],
		parameters: Params,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action;

			if (action === "start") {
				if (!params.task?.trim()) fail("`task` is required for action 'start'.");

				const running = [...jobs.values()].filter((job) => job.status === "running");
				if (running.length >= MAX_CONCURRENT) {
					fail(
						`Too many running agents (${running.length}/${MAX_CONCURRENT}): ${running.map((job) => job.id).join(", ")}. Wait for or cancel some first.`,
					);
				}

				const resolved = resolveModel(ctx, params.model);
				if (resolved.error) fail(resolved.error);

				const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
				if (!fs.existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);

				const label =
					params.label?.trim() ||
					params.task.trim().split(/\s+/).slice(0, 5).join(" ").slice(0, 48).replace(/[^\w\s.-]/g, "");

				const job = launch(ctx, {
					task: params.task,
					modelSlug: resolved.slug as string,
					label: label || "task",
					cwd,
					tools: params.tools,
					system: params.system,
				});

				return text(
					`Started ${job.id} (${job.label}) on ${job.model}. Running in the background — continue with other work, then call agent{action:"wait"} to collect the result.`,
					toDetails(action, [job]),
				);
			}

			if (action === "list") {
				const all = [...jobs.values()];
				if (all.length === 0) return text("No agents started yet.", toDetails(action, []));
				return text(all.map(jobSummaryLine).join("\n"), toDetails(action, all));
			}

			if (action === "check") {
				if (!params.id) fail("`id` is required for action 'check'.");
				const job = jobs.get(params.id);
				if (!job) fail(`Unknown job id "${params.id}". Known ids: ${[...jobs.keys()].join(", ") || "none"}.`);
				job.collected = job.status !== "running";
				const body =
					job.status === "running"
						? `${jobSummaryLine(job)}\n${job.toolCalls.length} tool calls so far (now: ${activityLine(job)}). Still running.`
						: `${jobSummaryLine(job)}\n\n${jobOutput(job)}`;
				return text(body, toDetails(action, [job]));
			}

			if (action === "cancel") {
				if (!params.id) fail("`id` is required for action 'cancel'.");
				const job = jobs.get(params.id);
				if (!job) fail(`Unknown job id "${params.id}". Known ids: ${[...jobs.keys()].join(", ") || "none"}.`);
				if (job.status !== "running") return text(`${job.id} already ${job.status}.`, toDetails(action, [job]));
				killJob(job);
				await job.promise;
				updateStatus();
				return text(`Canceled ${job.id}.`, toDetails(action, [job]));
			}

			// action === "wait"
			const targets = params.ids?.length
				? params.ids.map((id) => jobs.get(id)).filter((job): job is Job => Boolean(job))
				: [...jobs.values()].filter((job) => job.status === "running" || !job.collected);

			if (targets.length === 0) return text("Nothing to wait for.", toDetails(action, []));

			const timeoutMs = Math.max(1, params.timeout ?? DEFAULT_WAIT_SECONDS) * 1000;
			const deadline = Date.now() + timeoutMs;

			while (targets.some((job) => job.status === "running")) {
				if (signal?.aborted) break;
				if (Date.now() > deadline) break;
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			const stillRunning = targets.filter((job) => job.status === "running");
			for (const job of targets) if (job.status !== "running") job.collected = true;

			const sections = targets.map((job) => `### ${statusIcon(job.status)} ${job.id} — ${job.label} (${job.status})\n\n${jobOutput(job)}`);
			const header = stillRunning.length
				? `${targets.length - stillRunning.length}/${targets.length} finished; ${stillRunning.map((job) => job.id).join(", ")} still running (waited ${Math.round(timeoutMs / 1000)}s).`
				: `All ${targets.length} finished.`;

			return text(`${header}\n\n${sections.join("\n\n---\n\n")}`, toDetails(action, targets));
		},

		renderCall(args, theme) {
			const head = theme.fg("toolTitle", theme.bold("agent ")) + theme.fg("accent", args.action ?? "...");
			if (args.action === "start") {
				const preview = (args.task ?? "").slice(0, 60);
				return new Text(
					`${head} ${theme.fg("muted", args.model ?? DEFAULT_TIER)}\n  ${theme.fg("dim", preview)}`,
					0,
					0,
				);
			}
			const target = args.id ?? args.ids?.join(", ") ?? "all";
			return new Text(`${head} ${theme.fg("dim", target)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Details | undefined;
			if (!details || details.jobs.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const container = new Container();
			for (const job of details.jobs) {
				const icon = theme.fg(statusColor(job.status), statusIcon(job.status));
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(job.id))} ${theme.fg("accent", job.label)} ${theme.fg("muted", job.model)}`,
						0,
						0,
					),
				);
				if (expanded) {
					container.addChild(new Text(theme.fg("dim", `task: ${job.task}`), 0, 0));
					for (const call of job.toolCalls.slice(-20)) {
						container.addChild(new Text(theme.fg("muted", `→ ${call.name}`), 0, 0));
					}
					if (job.status !== "running") {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(job.output.trim(), 0, 0, getMarkdownTheme()));
					}
				} else if (job.status !== "running") {
					const preview = job.output.split("\n").slice(0, 3).join("\n");
					container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
				}
				container.addChild(new Text(theme.fg("dim", `${job.usage}  ${theme.fg("dim", "(/agents for live view)")}`), 0, 0));
			}
			if (!expanded) container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			return container;
		},
	});

	pi.registerCommand("agents", {
		description: "Open the background subagents overlay (/agents cancel <id> to kill one)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "cancel" && parts[1]) {
				const job = jobs.get(parts[1]);
				if (!job) return ctx.ui.notify(`Unknown job "${parts[1]}".`, "warning");
				killJob(job);
				updateStatus();
				return ctx.ui.notify(`Canceled ${job.id}.`, "info");
			}
			if (parts[0] === "list") {
				const all = [...jobs.values()];
				return ctx.ui.notify(all.length ? all.map(jobSummaryLine).join("\n") : "No background agents.", "info");
			}
			await openUI(ctx, parts[0] && jobs.has(parts[0]) ? parts[0] : undefined);
		},
		getArgumentCompletions: (prefix) =>
			[...jobs.values()]
				.filter((job) => job.id.startsWith(prefix) || job.label.startsWith(prefix))
				.map((job) => ({ value: job.id, label: `${job.id} ${job.label}`, description: job.status })),
	});

	// Statuses are cleared whenever pi rebuilds the footer (overlays, /clear,
	// session switches), so re-assert ours at the natural redraw points.
	pi.on("agent_settled", () => updateStatus());
	pi.on("turn_end", () => updateStatus());

	pi.on("session_shutdown", (event) => {
		unbindHotkey?.();
		unbindHotkey = undefined;
		if (event.reason !== "reload" && runtime.uiCtx?.hasUI) {
			runtime.uiCtx.ui.setStatus("agents", undefined);
		}
		runtime.uiCtx = undefined;
		if (runtime.notifyTimer) clearTimeout(runtime.notifyTimer);
		if (runtime.statusTimer) clearTimeout(runtime.statusTimer);
		runtime.notifyTimer = undefined;
		runtime.statusTimer = undefined;
		listeners.clear();
		// Reload only detaches the old UI. Children and job history remain in the
		// process-global runtime and session_start immediately reattaches them.
		if (event.reason !== "reload") {
			for (const job of jobs.values()) if (job.status === "running") killJob(job);
			jobs.clear();
			runtime.jobCounter = 0;
			runtime.sessionId = undefined;
		}
	});
}
