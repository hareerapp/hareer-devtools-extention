export interface Submodule {
  readonly name: string;
  readonly path: string;
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly headSha: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly url: string;
}

export type PRFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface PRFile {
  readonly filename: string;
  readonly status: PRFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly previousFilename?: string;
}

export interface ReviewComment {
  readonly id: number;
  readonly body: string;
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly user: string;
  readonly userAvatarUrl?: string;
  readonly createdAt: string;
  readonly diffHunk: string;
  readonly commitId: string;
  readonly inReplyToId?: number;
  readonly reviewId?: number;
}

export interface ReviewLineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

export interface SubmitReviewPayload {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  readonly body: string;
  readonly comments: readonly ReviewLineComment[];
}

export interface GitHubUser {
  readonly login: string;
  readonly avatarUrl: string;
}

export interface PRLabel {
  readonly name: string;
  readonly color: string;
}

export type PRReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";

export interface PRReview {
  readonly id: number;
  readonly user: GitHubUser;
  readonly state: PRReviewState;
  readonly body: string;
  readonly submittedAt: string | undefined;
}

export interface PRIssueComment {
  readonly id: number;
  readonly user: GitHubUser;
  readonly body: string;
  readonly createdAt: string;
}

export interface PRCheckRun {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  readonly htmlUrl: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface PRDetail {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly mergeableState: string;
  readonly htmlUrl: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly author: GitHubUser;
  readonly assignees: readonly GitHubUser[];
  readonly requestedReviewers: readonly GitHubUser[];
  readonly labels: readonly PRLabel[];
  readonly milestone: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commitsCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}
