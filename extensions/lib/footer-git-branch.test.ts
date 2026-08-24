import assert from "node:assert/strict";
import test from "node:test";
import type { GitFlowFooterState } from "./git-flow-state.ts";
import { gitFlowStateAppliesToCwd, resolveFooterGitBranch } from "./footer-git-branch.ts";

const state: GitFlowFooterState = {
	root: "/work/repository",
	branch: "search-provider",
	revision: "1234567",
	gitStatus: "",
};

test("prefers Git flow's branch when Pi's cached branch is stale", () => {
	assert.equal(resolveFooterGitBranch(state, state.root, "main"), "search-provider");
});

test("uses Git flow state from a parent repository for nested working directories", () => {
	assert.equal(
		resolveFooterGitBranch(state, "/work/repository/packages/app", "main"),
		"search-provider",
	);
});

test("falls back to Pi's branch outside the Git flow repository", () => {
	assert.equal(resolveFooterGitBranch(state, "/work/other", "main"), "main");
	assert.equal(resolveFooterGitBranch(undefined, state.root, "main"), "main");
});

test("does not treat a sibling with the same path prefix as part of the repository", () => {
	assert.equal(gitFlowStateAppliesToCwd(state, "/work/repository-copy"), false);
});
