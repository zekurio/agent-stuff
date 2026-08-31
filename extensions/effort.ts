import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_PATH = join(getAgentDir(), "effort.json");
const ALL_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type EffortState = {
	models: Record<string, ModelThinkingLevel>;
};

function isLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && ALL_LEVELS.includes(value as ModelThinkingLevel);
}

function loadState(): EffortState {
	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { models?: unknown };
		if (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models)) return { models: {} };

		const models: Record<string, ModelThinkingLevel> = {};
		for (const [key, value] of Object.entries(parsed.models)) {
			if (isLevel(value)) models[key] = value;
		}
		return { models };
	} catch {
		return { models: {} };
	}
}

function saveState(state: EffortState): string | undefined {
	const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

function availableLevels(ctx: ExtensionContext): ModelThinkingLevel[] {
	return ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"];
}

export default function effortExtension(pi: ExtensionAPI): void {
	const state = loadState();
	let activeModelKey: string | undefined;

	function persist(key: string, level: ModelThinkingLevel, ctx?: ExtensionContext): void {
		state.models[key] = level;
		const error = saveState(state);
		if (error && ctx?.hasUI) ctx.ui.notify(`Could not remember effort: ${error}`, "warning");
	}

	function applySaved(ctx: ExtensionContext): void {
		const key = modelKey(ctx);
		activeModelKey = key;
		if (!key || !ctx.model) return;

		const saved = state.models[key];
		if (!saved) return;
		if (!availableLevels(ctx).includes(saved)) return;
		pi.setThinkingLevel(saved);
	}

	pi.on("session_start", (_event, ctx) => applySaved(ctx));
	pi.on("model_select", (_event, ctx) => applySaved(ctx));
	pi.on("thinking_level_select", (event, ctx) => {
		const key = modelKey(ctx);
		// Model switches clamp effort before model_select; do not let that temporary
		// clamp overwrite either model's remembered setting.
		if (!key || key !== activeModelKey) return;
		persist(key, event.level as ModelThinkingLevel, ctx);
	});
}
