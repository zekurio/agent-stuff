export interface ModelRef {
	provider: string;
	id: string;
}

export interface ScopedModelRef {
	model: ModelRef;
	thinkingLevel?: string;
}

export interface ModelChoice {
	slug: string;
	base: string;
}

/** Mirror Pi's explicit scope, or all available models when no scope exists. */
export function buildModelChoices(
	scopedModels: readonly ScopedModelRef[],
	availableModels: readonly ModelRef[],
): ModelChoice[] {
	const candidates = scopedModels.length
		? scopedModels
		: availableModels.map((model) => ({ model, thinkingLevel: undefined }));
	const seen = new Set<string>();
	const choices: ModelChoice[] = [];

	for (const { model, thinkingLevel } of candidates) {
		const base = `${model.provider}/${model.id}`;
		const slug = `${base}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
		if (seen.has(slug)) continue;
		seen.add(slug);
		choices.push({ slug, base });
	}

	return choices;
}

/** Prefer the current session model, then preserve Pi's configured scope order. */
export function chooseDefaultModel(
	currentModel: ModelRef | undefined,
	choices: readonly ModelChoice[],
): string | undefined {
	const current = currentModel
		? `${currentModel.provider}/${currentModel.id}`
		: undefined;
	return (
		choices.find((choice) => choice.base === current)?.slug ?? choices[0]?.slug
	);
}
