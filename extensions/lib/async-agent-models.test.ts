import assert from "node:assert/strict";
import test from "node:test";
import { buildModelChoices, chooseDefaultModel } from "./async-agent-models.ts";

const available = [
	{ provider: "openai-codex", id: "gpt-5.6-luna" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
];

test("uses every scoped model in configured order with thinking levels", () => {
	const choices = buildModelChoices(
		[
			{ model: available[1], thinkingLevel: "xhigh" },
			{ model: available[0], thinkingLevel: "max" },
		],
		available,
	);

	assert.deepEqual(choices, [
		{
			base: "openai-codex/gpt-5.6-sol",
			slug: "openai-codex/gpt-5.6-sol:xhigh",
		},
		{
			base: "openai-codex/gpt-5.6-luna",
			slug: "openai-codex/gpt-5.6-luna:max",
		},
	]);
});

test("falls back to all available models when Pi has no explicit scope", () => {
	assert.deepEqual(
		buildModelChoices([], available).map((choice) => choice.slug),
		["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"],
	);
});

test("defaults to the current model and otherwise the first scoped model", () => {
	const choices = buildModelChoices(
		[
			{ model: available[1], thinkingLevel: "xhigh" },
			{ model: available[0], thinkingLevel: "max" },
		],
		available,
	);

	assert.equal(
		chooseDefaultModel(available[0], choices),
		"openai-codex/gpt-5.6-luna:max",
	);
	assert.equal(
		chooseDefaultModel({ provider: "other", id: "missing" }, choices),
		"openai-codex/gpt-5.6-sol:xhigh",
	);
});

test("deduplicates identical scoped entries", () => {
	const duplicate = { model: available[0], thinkingLevel: "max" };
	assert.deepEqual(buildModelChoices([duplicate, duplicate], available), [
		{
			base: "openai-codex/gpt-5.6-luna",
			slug: "openai-codex/gpt-5.6-luna:max",
		},
	]);
});
