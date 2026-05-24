import * as https from "node:https";
import * as vscode from "vscode";
import type {
  GitHubUser,
  PRCheckRun,
  PRDetail,
  PRFile,
  PRIssueComment,
  PRLabel,
  PRReview,
  PRReviewState,
  PullRequest,
  ReviewComment,
  SubmitReviewPayload,
} from "./types";

const GITHUB_AUTH_PROVIDER = "github";
const GITHUB_SCOPES = ["repo"];
const BASE_URL = "api.github.com";

let cachedToken: string | undefined;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER, GITHUB_SCOPES, {
    createIfNone: true,
  });
  cachedToken = session.accessToken;
  return session.accessToken;
}

export function invalidateToken(): void {
  cachedToken = undefined;
}

/**
 * Force a fresh GitHub sign-in dialog. Use this when the cached session was
 * granted with insufficient scopes (e.g. no access to private repos).
 */
export async function reconnectGitHub(): Promise<void> {
  cachedToken = undefined;
  const session = await vscode.authentication.getSession(
    GITHUB_AUTH_PROVIDER,
    GITHUB_SCOPES,
    { forceNewSession: true },
  );
  cachedToken = session.accessToken;
}

function githubRequest<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: BASE_URL,
      path,
      method,
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "hareer-devtools-vscode",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode === 204) {
          resolve(undefined as T);
          return;
        }
        try {
          const parsed = JSON.parse(raw) as T;
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            const baseMsg = (parsed as { message?: string }).message ?? `HTTP ${res.statusCode}`;
            const hint =
              res.statusCode === 404
                ? ` — verify the repo exists and your GitHub token has access to https://github.com${path.split("?")[0].replace("/repos", "")}`
                : res.statusCode === 401
                  ? " — your GitHub token is invalid or lacks the 'repo' scope"
                  : "";
            reject(new Error(`GitHub API error (${res.statusCode}): ${baseMsg}${hint}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse GitHub response: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface RawPR {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
}

interface RawComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: string | null;
  user: { login: string; avatar_url?: string };
  created_at: string;
  diff_hunk: string;
  commit_id: string;
  in_reply_to_id?: number;
  pull_request_review_id?: number | null;
}

interface RawContents {
  content: string;
  encoding: string;
}

export async function fetchOpenPRs(owner: string, repo: string): Promise<PullRequest[]> {
  const token = await getToken();
  const raw = await githubRequest<RawPR[]>(
    "GET",
    `/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
    token,
  );
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: "open",
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    url: pr.html_url,
  }));
}

export async function fetchPRByNumber(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  const token = await getToken();
  const pr = await githubRequest<RawPR>("GET", `/repos/${owner}/${repo}/pulls/${number}`, token);
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state === "open" ? "open" : "closed",
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    url: pr.html_url,
  };
}

export async function fetchPRFiles(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PRFile[]> {
  const token = await getToken();
  const raw = await githubRequest<RawFile[]>(
    "GET",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`,
    token,
  );
  return raw.map((f) => ({
    filename: f.filename,
    status: f.status as PRFile["status"],
    additions: f.additions,
    deletions: f.deletions,
    previousFilename: f.previous_filename,
  }));
}

export async function fetchPRComments(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewComment[]> {
  const token = await getToken();
  const raw = await githubRequest<RawComment[]>(
    "GET",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100`,
    token,
  );
  return raw.map((c) => ({
    id: c.id,
    body: c.body,
    path: c.path,
    line: c.line ?? c.original_line ?? 1,
    side: (c.side === "LEFT" ? "LEFT" : "RIGHT") as "LEFT" | "RIGHT",
    user: c.user.login,
    userAvatarUrl: c.user.avatar_url,
    createdAt: c.created_at,
    diffHunk: c.diff_hunk,
    commitId: c.commit_id,
    inReplyToId: c.in_reply_to_id,
    reviewId: c.pull_request_review_id ?? undefined,
  }));
}

export async function replyToReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  inReplyToId: number,
  body: string,
): Promise<ReviewComment> {
  const token = await getToken();
  const raw = await githubRequest<RawComment>(
    "POST",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
    token,
    { body, in_reply_to: inReplyToId },
  );
  return {
    id: raw.id,
    body: raw.body,
    path: raw.path,
    line: raw.line ?? raw.original_line ?? 1,
    side: (raw.side === "LEFT" ? "LEFT" : "RIGHT") as "LEFT" | "RIGHT",
    user: raw.user.login,
    userAvatarUrl: raw.user.avatar_url,
    createdAt: raw.created_at,
    diffHunk: raw.diff_hunk,
    commitId: raw.commit_id,
    inReplyToId: raw.in_reply_to_id,
    reviewId: raw.pull_request_review_id ?? undefined,
  };
}

export async function fetchFileContent(
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const token = await getToken();
  const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
  const encodedRef = encodeURIComponent(ref);
  try {
    const raw = await githubRequest<RawContents>(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodedRef}`,
      token,
    );
    if (raw.encoding === "base64") {
      return Buffer.from(raw.content.replace(/\n/g, ""), "base64").toString("utf-8");
    }
    return raw.content;
  } catch {
    return "";
  }
}

export async function createReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  filePath: string,
  line: number,
  body: string,
): Promise<void> {
  const token = await getToken();
  await githubRequest<unknown>(
    "POST",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
    token,
    { body, commit_id: commitId, path: filePath, line, side: "RIGHT" },
  );
}

export async function submitReview(payload: SubmitReviewPayload): Promise<void> {
  const token = await getToken();
  await githubRequest<unknown>(
    "POST",
    `/repos/${payload.owner}/${payload.repo}/pulls/${payload.pullNumber}/reviews`,
    token,
    {
      body: payload.body,
      event: payload.event,
      comments: payload.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    },
  );
}

interface RawGitHubUser {
  login: string;
  avatar_url: string;
}

interface RawLabel {
  name: string;
  color: string;
}

interface RawPRDetail {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  html_url: string;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: RawGitHubUser;
  assignees: RawGitHubUser[];
  requested_reviewers: RawGitHubUser[];
  labels: RawLabel[];
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
}

const GHOST_USER: GitHubUser = { login: "ghost", avatarUrl: "" };

function mapUser(u: RawGitHubUser | null | undefined): GitHubUser {
  if (!u) return GHOST_USER;
  return { login: u.login ?? "ghost", avatarUrl: u.avatar_url ?? "" };
}

function mapLabel(l: RawLabel): PRLabel {
  return { name: l.name, color: l.color };
}

export async function fetchPRDetail(
  owner: string,
  repo: string,
  number: number,
): Promise<PRDetail> {
  const token = await getToken();
  const raw = await githubRequest<RawPRDetail>(
    "GET",
    `/repos/${owner}/${repo}/pulls/${number}`,
    token,
  );
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "open" ? "open" : "closed",
    draft: Boolean(raw.draft),
    merged: raw.merged,
    mergeable: raw.mergeable,
    mergeableState: raw.mergeable_state,
    htmlUrl: raw.html_url,
    headSha: raw.head.sha,
    baseSha: raw.base.sha,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    author: mapUser(raw.user),
    assignees: raw.assignees.map(mapUser),
    requestedReviewers: raw.requested_reviewers.map(mapUser),
    labels: raw.labels.map(mapLabel),
    milestone: raw.milestone?.title,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commitsCount: raw.commits,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changed_files,
  };
}

interface RawReview {
  id: number;
  user: RawGitHubUser;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

export async function fetchPRReviews(
  owner: string,
  repo: string,
  number: number,
): Promise<PRReview[]> {
  const token = await getToken();
  const raw = await githubRequest<RawReview[]>(
    "GET",
    `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
    token,
  );
  return raw.map((r) => ({
    id: r.id,
    user: mapUser(r.user),
    state: r.state as PRReviewState,
    body: r.body ?? "",
    submittedAt: r.submitted_at ?? undefined,
  }));
}

interface RawIssueComment {
  id: number;
  user: RawGitHubUser;
  body: string;
  created_at: string;
}

export async function fetchPRIssueComments(
  owner: string,
  repo: string,
  number: number,
): Promise<PRIssueComment[]> {
  const token = await getToken();
  const raw = await githubRequest<RawIssueComment[]>(
    "GET",
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    token,
  );
  return raw.map((c) => ({
    id: c.id,
    user: mapUser(c.user),
    body: c.body,
    createdAt: c.created_at,
  }));
}

export async function createIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  const token = await getToken();
  await githubRequest<unknown>(
    "POST",
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    token,
    { body },
  );
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at?: string;
  completed_at?: string;
}

interface RawCheckRunsResponse {
  total_count: number;
  check_runs: RawCheckRun[];
}

export async function fetchPRChecks(
  owner: string,
  repo: string,
  sha: string,
): Promise<PRCheckRun[]> {
  const token = await getToken();
  try {
    const raw = await githubRequest<RawCheckRunsResponse>(
      "GET",
      `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
      token,
    );
    return raw.check_runs.map((c) => ({
      name: c.name,
      status: c.status as PRCheckRun["status"],
      conclusion: (c.conclusion as PRCheckRun["conclusion"]) ?? null,
      htmlUrl: c.html_url,
      startedAt: c.started_at,
      completedAt: c.completed_at,
    }));
  } catch {
    return [];
  }
}

export async function mergePR(
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: "merge" | "squash" | "rebase",
): Promise<void> {
  const token = await getToken();
  await githubRequest<unknown>(
    "PUT",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
    token,
    { merge_method: mergeMethod },
  );
}
