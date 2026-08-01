export const GIT_FLOW_STATE_EVENT = "zekurio:git-flow-state";
export const GIT_FLOW_REFRESH_EVENT = "zekurio:git-flow-refresh";

export type PullRequestStatus =
	| "draft"
	| "mergeable"
	| "not-mergeable"
	| "merged"
	| "unknown";

export type PullRequestLink = {
	number: number;
	url: string;
	status: PullRequestStatus;
};

export type GitFlowFooterState = {
	root: string;
	branch: string;
	revision: string;
	/** Plain-text output of the configured Starship git_status module. */
	gitStatus: string;
	pullRequest?: PullRequestLink;
};
