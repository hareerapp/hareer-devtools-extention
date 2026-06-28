import { PersistentCache, swr, TTL } from "../cache";
import {
  fetchAllPRs,
  fetchOpenPRs,
  fetchPRChecks,
  fetchPRComments,
  fetchPRDetail,
  fetchPRFiles,
  fetchPRIssueComments,
  fetchPRReviews,
} from "./github-api";
import type {
  PRCheckRun,
  PRDetail,
  PRFile,
  PRIssueComment,
  PRReview,
  PullRequest,
  ReviewComment,
} from "./types";


let cache: PersistentCache | undefined;

export function configurePRCache(instance: PersistentCache): void {
  cache = instance;
}

interface ReadOptions {
  readonly force?: boolean;
}

const openPRsKey = (owner: string, repo: string): string => `openPRs.${owner}/${repo}`;
const allPRsKey = (owner: string, repo: string): string => `allPRs.${owner}/${repo}`;
const prDetailKey = (owner: string, repo: string, n: number): string =>
  `prDetail.${owner}/${repo}#${n}`;
const prFilesKey = (owner: string, repo: string, n: number): string =>
  `prFiles.${owner}/${repo}#${n}`;
const prBundleKey = (owner: string, repo: string, n: number): string =>
  `prBundle.${owner}/${repo}#${n}`;

export interface PRBundle {
  readonly detail: PRDetail;
  readonly reviews: PRReview[];
  readonly comments: PRIssueComment[];
  readonly lineComments: ReviewComment[];
  readonly files: PRFile[];
  readonly checks: PRCheckRun[];
}

export function getAllPRs(
  owner: string,
  repo: string,
  opts: ReadOptions = {},
  onUpdate?: (prs: PullRequest[]) => void,
): Promise<PullRequest[]> {
  const fetcher = (): Promise<PullRequest[]> => fetchAllPRs(owner, repo);
  if (!cache) return fetcher();
  return swr(cache, allPRsKey(owner, repo), fetcher, { ttlMs: TTL.openPRs, force: opts.force }, onUpdate);
}

export function getCachedPRDetail(
  owner: string,
  repo: string,
  n: number,
  opts: ReadOptions = {},
): Promise<PRDetail> {
  const fetcher = (): Promise<PRDetail> => fetchPRDetail(owner, repo, n);
  if (!cache) return fetcher();
  return swr(cache, prDetailKey(owner, repo, n), fetcher, { ttlMs: TTL.prBundle, force: opts.force });
}

export function getOpenPRs(
  owner: string,
  repo: string,
  opts: ReadOptions = {},
  onUpdate?: (prs: PullRequest[]) => void,
): Promise<PullRequest[]> {
  const fetcher = (): Promise<PullRequest[]> => fetchOpenPRs(owner, repo);
  if (!cache) return fetcher();
  return swr(cache, openPRsKey(owner, repo), fetcher, { ttlMs: TTL.openPRs, force: opts.force }, onUpdate);
}

export function getPRFiles(
  owner: string,
  repo: string,
  n: number,
  opts: ReadOptions = {},
  onUpdate?: (files: PRFile[]) => void,
): Promise<PRFile[]> {
  const fetcher = (): Promise<PRFile[]> => fetchPRFiles(owner, repo, n);
  if (!cache) return fetcher();
  return swr(cache, prFilesKey(owner, repo, n), fetcher, { ttlMs: TTL.prBundle, force: opts.force }, onUpdate);
}

export function getPRBundle(
  owner: string,
  repo: string,
  n: number,
  opts: ReadOptions = {},
  onUpdate?: (bundle: PRBundle) => void,
): Promise<PRBundle> {
  const fetcher = async (): Promise<PRBundle> => {
    const [detail, reviews, comments, files, lineComments] = await Promise.all([
      fetchPRDetail(owner, repo, n),
      fetchPRReviews(owner, repo, n),
      fetchPRIssueComments(owner, repo, n),
      fetchPRFiles(owner, repo, n),
      fetchPRComments(owner, repo, n),
    ]);
    const checks = await fetchPRChecks(owner, repo, detail.headSha);
    return { detail, reviews, comments, lineComments, files, checks };
  };
  if (!cache) return fetcher();
  return swr(cache, prBundleKey(owner, repo, n), fetcher, { ttlMs: TTL.prBundle, force: opts.force }, onUpdate);
}

/** Drop cached data for a PR (and the repo's open-PR list) after a mutation. */
export function invalidatePR(owner: string, repo: string, n?: number): void {
  if (!cache) return;
  cache.delete(openPRsKey(owner, repo));
  cache.delete(allPRsKey(owner, repo));
  if (n !== undefined) {
    cache.delete(prDetailKey(owner, repo, n));
    cache.delete(prFilesKey(owner, repo, n));
    cache.delete(prBundleKey(owner, repo, n));
  }
}

/** Drop all cached PR data (manual Code Review refresh). */
export function clearAllPRCache(): void {
  if (!cache) return;
  cache.deleteByPrefix("openPRs.");
  cache.deleteByPrefix("allPRs.");
  cache.deleteByPrefix("prDetail.");
  cache.deleteByPrefix("prFiles.");
  cache.deleteByPrefix("prBundle.");
}
