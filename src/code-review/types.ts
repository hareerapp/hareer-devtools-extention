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
  readonly createdAt: string;
  readonly diffHunk: string;
  readonly commitId: string;
  readonly inReplyToId?: number;
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
