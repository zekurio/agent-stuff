import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitFlowFooterState } from "./git-flow-state.ts";

export function gitFlowStateAppliesToCwd(
	state: GitFlowFooterState | undefined,
	cwd: string,
): state is GitFlowFooterState {
	if (!state) return false;
	const fromRoot = relative(resolve(state.root), resolve(cwd));
	return (
		fromRoot === "" ||
		(fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
	);
}

/**
 * Prefer Git flow's actively polled branch over Pi's filesystem-watcher cache.
 * Pi's FooterDataProvider can remain stale when it misses an atomic .git/HEAD
 * replacement, while Git flow refreshes its state after commands and by poll.
 */
export function resolveFooterGitBranch(
	state: GitFlowFooterState | undefined,
	cwd: string,
	cachedBranch: string | null,
): string | null {
	return gitFlowStateAppliesToCwd(state, cwd) ? state.branch : cachedBranch;
}
