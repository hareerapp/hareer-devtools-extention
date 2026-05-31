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

const fileContentCache = new Map<string, string>();

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

export async function reconnectGitHub(): Promise<void> {
  cachedToken = undefined;
  const session = await vscode.authentication.getSession(
    GITHUB_AUTH_PROVIDER,
    GITHUB_SCOPES,
    { forceNewSession: true },
  );
  cachedToken = session.accessToken;
}

interface GitHubErrorItem {
  resource?: string;
  field?: string;
  code?: string;
  message?: string;
}

interface GitHubErrorResponse {
  message?: string;
  errors?: unknown[];
}

function formatGitHubErrorItem(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return undefined;
  const item = error as GitHubErrorItem;
  if (item.message) return item.message;
  if (item.field && item.code) return `${item.field}: ${item.code}`;
  return item.code ?? item.field;
}

function formatGitHubError(
  statusCode: number,
  path: string,
  parsed: GitHubErrorResponse,
  raw: string,
): string {
  const baseMsg = parsed.message ?? `HTTP ${statusCode}`;
  const details = parsed.errors
    ?.map(formatGitHubErrorItem)
    .filter((msg): msg is string => Boolean(msg));
  let detailSuffix = details && details.length > 0 ? ` — ${details.join("; ")}` : "";
  if (!detailSuffix && baseMsg === "Unprocessable Entity" && raw.length > 0) {
    detailSuffix = ` — ${raw.slice(0, 400)}`;
  }
  const hint =
    statusCode === 404
      ? ` — verify the repo exists and your GitHub token has access to https://github.com${path.split("?")[0].replace("/repos", "")}`
      : statusCode === 401
        ? " — your GitHub token is invalid or lacks the 'repo' scope"
        : statusCode === 422 && detailSuffix.includes("pending review")
          ? " — finish or discard your in-progress review on GitHub first"
          : statusCode === 422 &&
            `${baseMsg} ${detailSuffix}`.toLowerCase().includes("could not be resolved")
          ? " — comment only on lines shown in the PR diff (changed or nearby context). Re-open the file diff if the PR was updated"
            : "";
  return `GitHub API error (${statusCode}): ${baseMsg}${detailSuffix}${hint}`;
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
            reject(
              new Error(
                formatGitHubError(res.statusCode, path, parsed as GitHubErrorResponse, raw),
              ),
            );
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
  patch?: string;
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
    patch: f.patch,
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
  const cacheKey = `${owner}/${repo}/${ref}/${filePath}`;
  const cached = fileContentCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const token = await getToken();
  const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, "/");
  const encodedRef = encodeURIComponent(ref);
  try {
    const raw = await githubRequest<RawContents>(
      "GET",
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodedRef}`,
      token,
    );
    const content =
      raw.encoding === "base64"
        ? Buffer.from(raw.content.replace(/\n/g, ""), "base64").toString("utf-8")
        : raw.content;

    fileContentCache.set(cacheKey, content);
    return content;
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

export async function fetchAuthenticatedUser(): Promise<GitHubUser> {
  const token = await getToken();
  const raw = await githubRequest<RawGitHubUser>("GET", "/user", token);
  return mapUser(raw);
}

export async function deletePendingReview(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
): Promise<void> {
  const token = await getToken();
  await githubRequest<unknown>(
    "DELETE",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`,
    token,
  );
}

async function findMyPendingReview(
  owner: string,
  repo: string,
  pullNumber: number,
  login: string,
): Promise<PRReview | undefined> {
  const reviews = await fetchPRReviews(owner, repo, pullNumber);
  return reviews.find((r) => r.state === "PENDING" && r.user.login === login);
}

async function deleteMyPendingReviews(
  owner: string,
  repo: string,
  pullNumber: number,
  login: string,
): Promise<void> {
  const reviews = await fetchPRReviews(owner, repo, pullNumber);
  const pending = reviews.filter((r) => r.state === "PENDING" && r.user.login === login);
  await Promise.all(
    pending.map((r) => deletePendingReview(owner, repo, pullNumber, r.id)),
  );
}

async function submitPendingReviewEvent(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  event: SubmitReviewPayload["event"],
  body: string | undefined,
): Promise<void> {
  const token = await getToken();
  const requestBody: Record<string, unknown> = { event };
  if (body !== undefined && body.length > 0) {
    requestBody.body = body;
  }
  await githubRequest<unknown>(
    "POST",
    `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}/events`,
    token,
    requestBody,
  );
}

async function createAndSubmitReview(payload: SubmitReviewPayload): Promise<void> {
  const token = await getToken();
  const requestBody: Record<string, unknown> = {
    commit_id: payload.commitId,
    event: payload.event,
  };
  if (payload.body.length > 0) {
    requestBody.body = payload.body;
  }
  await githubRequest<unknown>(
    "POST",
    `/repos/${payload.owner}/${payload.repo}/pulls/${payload.pullNumber}/reviews`,
    token,
    requestBody,
  );
}

/**
 * Post inline comments individually, then submit the pending review — avoids
 * batch payload validation failures from POST /pulls/{n}/reviews.
 */
export async function submitReview(payload: SubmitReviewPayload): Promise<void> {
  const me = await fetchAuthenticatedUser();
  await deleteMyPendingReviews(payload.owner, payload.repo, payload.pullNumber, me.login);

  for (const comment of payload.comments) {
    try {
      await createReviewComment(
        payload.owner,
        payload.repo,
        payload.pullNumber,
        payload.commitId,
        comment.path,
        comment.line,
        comment.body,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${comment.path}:${comment.line} — ${detail}`);
    }
  }

  const pending = await findMyPendingReview(
    payload.owner,
    payload.repo,
    payload.pullNumber,
    me.login,
  );

  const reviewBody = payload.body.length > 0 ? payload.body : undefined;

  if (pending) {
    const eventBody =
      reviewBody ??
      (payload.event === "APPROVE" ? undefined : "See inline comments.");
    await submitPendingReviewEvent(
      payload.owner,
      payload.repo,
      payload.pullNumber,
      pending.id,
      payload.event,
      eventBody,
    );
    return;
  }

  if (payload.event !== "APPROVE" && !reviewBody) {
    throw new Error(
      "Review summary is required when requesting changes or commenting without inline comments.",
    );
  }

  await createAndSubmitReview(payload);
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
