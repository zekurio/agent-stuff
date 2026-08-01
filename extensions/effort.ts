import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

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

const THINKING_COLORS: Record<ModelThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

class EffortPicker {
	private selectedIndex: number;

	constructor(
		private readonly levels: ModelThinkingLevel[],
		current: ModelThinkingLevel,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly onSelect: (level: ModelThinkingLevel) => void,
		private readonly onCancel: () => void,
	) {
		this.selectedIndex = Math.max(0, levels.indexOf(current));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "left") || matchesKey(data, "up") || data === "h") {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || data === "l") {
			this.move(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.selectedIndex = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.selectedIndex = this.levels.length - 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			const selected = this.levels[this.selectedIndex];
			if (selected) this.onSelect(selected);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onCancel();
	}

	render(width: number): string[] {
		const selected = this.levels[this.selectedIndex] ?? this.levels[0] ?? "off";
		const trackWidth = Math.max(1, Math.min(72, width - 4));
		const firstLabel = this.levels[0] ?? "";
		const lastLabel = this.levels.at(-1) ?? "";
		const leftInset = Math.min(trackWidth - 1, Math.floor(firstLabel.length / 2));
		const rightInset = Math.min(trackWidth - 1 - leftInset, Math.floor(lastLabel.length / 2));
		const usableTrackWidth = Math.max(0, trackWidth - 1 - leftInset - rightInset);
		const positions = this.levels.map((_, index) =>
			this.levels.length === 1
				? Math.floor((trackWidth - 1) / 2)
				: leftInset + Math.round((index * usableTrackWidth) / (this.levels.length - 1)),
		);
		const selectedPosition = positions[this.selectedIndex] ?? 0;
		const color = THINKING_COLORS[selected];

		const speedCharacters = Array<string>(trackWidth).fill(" ");
		for (const [index, character] of [..."Faster"].entries()) speedCharacters[index] = character;
		for (const [index, character] of [..."Smarter"].entries()) {
			speedCharacters[Math.max(0, trackWidth - "Smarter".length) + index] = character;
		}

		const labelCharacters = Array.from({ length: trackWidth }, () => ({ character: " ", selected: false }));
		const widestLabel = Math.max(...this.levels.map((level) => level.length));
		const step = this.levels.length > 1 ? (trackWidth - 1) / (this.levels.length - 1) : trackWidth;
		const labeledLevels = step >= widestLabel + 1 ? this.levels.map((_, index) => index) : [this.selectedIndex];
		for (const index of labeledLevels) {
			const label = this.levels[index] ?? "";
			const position = positions[index] ?? 0;
			const start = Math.max(0, Math.min(trackWidth - label.length, Math.round(position - (label.length - 1) / 2)));
			for (let offset = 0; offset < label.length; offset++) {
				labelCharacters[start + offset] = { character: label[offset] ?? " ", selected: index === this.selectedIndex };
			}
		}

		const track = Array.from({ length: trackWidth }, (_, index) =>
			index === selectedPosition
				? this.theme.fg(color, "▲")
				: this.theme.fg("borderMuted", "─"),
		).join("");
		const labels = labelCharacters
			.map(({ character, selected: isSelected }) =>
				isSelected ? this.theme.fg(color, this.theme.bold(character)) : this.theme.fg("dim", character),
			)
			.join("");

		return [
			truncateToWidth(`  ${this.theme.bold("Effort")}`, width, ""),
			"",
			truncateToWidth(`  ${this.theme.fg("muted", speedCharacters.join(""))}`, width, ""),
			truncateToWidth(`  ${track}`, width, ""),
			truncateToWidth(`  ${labels}`, width, ""),
			"",
			truncateToWidth(`  ${this.theme.fg("dim", "←/→ choose  ·  enter set  ·  esc cancel")}`, width, ""),
		];
	}

	private move(offset: number): void {
		const next = Math.max(0, Math.min(this.levels.length - 1, this.selectedIndex + offset));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.requestRender();
	}
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

	function setEffort(level: ModelThinkingLevel, ctx: ExtensionContext, notify = true): void {
		const key = modelKey(ctx);
		if (!key || !ctx.model) {
			if (notify && ctx.hasUI) ctx.ui.notify("No active model.", "warning");
			return;
		}

		const levels = availableLevels(ctx);
		if (!levels.includes(level)) {
			if (notify && ctx.hasUI) {
				ctx.ui.notify(`Effort ${level} is unavailable for ${ctx.model.id}. Available: ${levels.join(", ")}.`, "warning");
			}
			return;
		}

		activeModelKey = key;
		pi.setThinkingLevel(level);
		persist(key, level, ctx);
		if (notify && ctx.hasUI) ctx.ui.notify(`Effort: ${level} (${ctx.model.id})`, "info");
	}

	function cycleEffort(ctx: ExtensionContext): void {
		if (!ctx.model?.reasoning) {
			if (ctx.hasUI) ctx.ui.notify(`${ctx.model?.id ?? "The current model"} does not support effort levels.`, "warning");
			return;
		}

		const levels = availableLevels(ctx);
		const current = pi.getThinkingLevel() as ModelThinkingLevel;
		const currentIndex = levels.indexOf(current);
		const next = levels[(currentIndex + 1 + levels.length) % levels.length] ?? levels[0];
		if (next) setEffort(next, ctx);
	}

	async function showEffortPicker(ctx: ExtensionContext): Promise<void> {
		if (!ctx.model?.reasoning) {
			if (ctx.hasUI) ctx.ui.notify(`${ctx.model?.id ?? "The current model"} does not support effort levels.`, "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			cycleEffort(ctx);
			return;
		}

		const levels = availableLevels(ctx);
		const current = pi.getThinkingLevel() as ModelThinkingLevel;
		const selected = await ctx.ui.custom<ModelThinkingLevel | null>((tui, theme, _keybindings, done) =>
			new EffortPicker(
				levels,
				current,
				theme,
				() => tui.requestRender(),
				(level) => done(level),
				() => done(null),
			),
		);
		if (selected) setEffort(selected, ctx);
	}

	pi.registerCommand("effort", {
		description: "Choose model effort; accepts off/minimal/low/medium/high/xhigh/max/status",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const options = [...ALL_LEVELS, "status"];
			const matches = options.filter((value) => value.startsWith(prefix.toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				await showEffortPicker(ctx);
				return;
			}
			if (arg === "cycle" || arg === "next") {
				cycleEffort(ctx);
				return;
			}
			if (arg === "status") {
				const key = modelKey(ctx);
				const saved = key ? state.models[key] : undefined;
				ctx.ui.notify(`Effort: ${pi.getThinkingLevel()}${saved ? ` (remembered for ${key})` : ""}.`, "info");
				return;
			}
			if (isLevel(arg)) {
				setEffort(arg, ctx);
				return;
			}
			ctx.ui.notify("Usage: /effort [off|minimal|low|medium|high|xhigh|max|status]", "warning");
		},
	});

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
