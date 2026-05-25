import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

interface RemoteRef {
  readonly name: string;
  readonly url?: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

interface Ref {
  readonly name?: string;
  readonly type: number;
  readonly remote?: string;
}

interface RepoState {
  readonly HEAD?: Ref;
  readonly remotes: RemoteRef[];
  readonly workingTreeChanges: unknown[];
  readonly indexChanges: unknown[];
}

interface InputBox {
  value: string;
}

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: InputBox;
  readonly state: RepoState;
  fetch(remote?: string, ref?: string): Promise<void>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  checkout(treeish: string): Promise<void>;
  add(resources: vscode.Uri[]): Promise<void>;
  commit(message: string, opts?: { all?: boolean }): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  getBranch(name: string): Promise<unknown>;
}

interface GitAPI {
  readonly repositories: Repository[];
  getRepository(uri: vscode.Uri): Repository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

let cached: GitAPI | undefined;

export async function getGitApi(): Promise<GitAPI> {
  if (cached) return cached;
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) throw new Error("Built-in Git extension is not installed.");
  if (!ext.isActive) await ext.activate();
  const api = ext.exports.getAPI(1);
  cached = api;
  return api;
}

export async function pickRepository(options?: {
  placeHolder?: string;
}): Promise<Repository | undefined> {
  const api = await getGitApi();
  if (api.repositories.length === 0) {
    void vscode.window.showWarningMessage("Hareer: No git repository found in the workspace.");
    return undefined;
  }
  if (api.repositories.length === 1) return api.repositories[0];

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const match = api.getRepository(editor.document.uri);
    if (match) return match;
  }

  const picked = await vscode.window.showQuickPick(
    api.repositories.map((r) => ({
      label: vscode.workspace.asRelativePath(r.rootUri.fsPath),
      description: r.state.HEAD?.name ?? "(detached)",
      repo: r,
    })),
    { placeHolder: options?.placeHolder ?? "Select repository for this task" },
  );
  return picked?.repo;
}

/** Pick the repo whose changes the commit / generate flow should target. */
export async function pickRepositoryForChanges(): Promise<Repository | undefined> {
  const api = await getGitApi();
  if (api.repositories.length === 0) {
    void vscode.window.showWarningMessage("Hareer: No git repository found in the workspace.");
    return undefined;
  }
  if (api.repositories.length === 1) return api.repositories[0];

  const picked = await vscode.window.showQuickPick(
    api.repositories.map((r) => ({
      label: vscode.workspace.asRelativePath(r.rootUri.fsPath),
      description: r.state.HEAD?.name ?? "(detached)",
      repo: r,
    })),
    { placeHolder: "Select repo of main changes" },
  );
  return picked?.repo;
}

/** Resolve a vscode.git Repository by root path, opening it in SCM if needed. */
export async function findRepositoryByRoot(rootPath: string): Promise<Repository | undefined> {
  const api = await getGitApi();
  const normalized = path.normalize(rootPath);

  const match = (repos: Repository[]): Repository | undefined =>
    repos.find((r) => path.normalize(r.rootUri.fsPath) === normalized);

  let repo = match(api.repositories);
  if (repo) return repo;

  repo = api.getRepository(vscode.Uri.file(rootPath)) ?? undefined;
  if (repo) return repo;

  try {
    await vscode.commands.executeCommand("git.openRepository", rootPath);
  } catch {
    /* repo may already be open under a different discovery path */
  }

  await sleep(300);
  const refreshed = await getGitApi();
  return match(refreshed.repositories) ?? refreshed.getRepository(vscode.Uri.file(rootPath)) ?? undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Find a local or remote branch in the given repo whose name contains the
 * substring (typically a ClickUp task id). Returns the local-style branch
 * name (no `origin/` prefix) so the caller can hand it to `git checkout`.
 */
export async function findTaskBranch(cwd: string, taskId: string): Promise<string | undefined> {
  try {
    const out = await execGit(cwd, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
    ]);
    const needle = taskId.toLowerCase();
    const all = out.split("\n").filter(Boolean);
    const local = all.find((b) => !b.includes("/") && b.toLowerCase().includes(needle));
    if (local) return local;
    const origin = all.find(
      (b) => b.startsWith("origin/") && !b.includes("HEAD") && b.toLowerCase().includes(needle),
    );
    if (origin) return origin.slice("origin/".length);
    const other = all.find(
      (b) => b.includes("/") && !b.includes("HEAD") && b.toLowerCase().includes(needle),
    );
    return other ? other.split("/").slice(1).join("/") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Direct shell-out checkout (used when we need to operate on submodule paths
 * that the vscode.git extension may not track as separate repositories).
 * Tries plain checkout first; falls back to creating a tracking branch from
 * origin if the branch only exists remotely.
 */
export async function checkoutBranchInDir(cwd: string, branch: string): Promise<void> {
  try {
    await execGit(cwd, ["fetch", "origin"]);
  } catch {
    /* tolerate fetch failure (offline, no remote) */
  }
  try {
    await execGit(cwd, ["checkout", branch]);
  } catch {
    await execGit(cwd, ["checkout", "-b", branch, `origin/${branch}`]);
  }
}

/**
 * Create a branch (off origin/<base>) and check it out, via shell.
 * Used for multi-repo branch creation where vscode.git Repository objects
 * aren't available for each submodule. When `baseRef` is omitted falls back
 * to `develop`, then `origin/HEAD`, then `main`.
 */
export async function createAndCheckoutBranchInDir(
  cwd: string,
  branchName: string,
  baseRef?: string,
): Promise<void> {
  try {
    await execGit(cwd, ["fetch", "origin"]);
  } catch {
    /* offline or no remote */
  }

  const base = baseRef ?? (await resolveDefaultBase(cwd));

  try {
    await execGit(cwd, ["checkout", "-b", branchName, `origin/${base}`]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("already exists")) {
      await execGit(cwd, ["checkout", branchName]);
      return;
    }
    throw err;
  }
}

async function resolveDefaultBase(cwd: string): Promise<string> {
  // Prefer develop (umbrella convention) when it exists on origin.
  try {
    await execGit(cwd, ["rev-parse", "--verify", "refs/remotes/origin/develop"]);
    return "develop";
  } catch {
    /* no develop branch */
  }
  try {
    const head = await execGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
    const tip = head.split("/").pop();
    if (tip) return tip;
  } catch {
    /* no origin HEAD */
  }
  return "main";
}

export async function getDefaultBranch(repo: Repository): Promise<string> {
  return resolveDefaultBase(repo.rootUri.fsPath);
}

export async function createAndCheckoutBranch(
  repo: Repository,
  branchName: string,
  baseRef?: string,
): Promise<void> {
  await repo.fetch();
  const base = baseRef ?? (await getDefaultBranch(repo));
  try {
    await repo.createBranch(branchName, true, `origin/${base}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("already exists")) {
      await repo.checkout(branchName);
      return;
    }
    throw err;
  }
}

export async function checkoutBranch(repo: Repository, branchName: string): Promise<void> {
  await repo.fetch();
  try {
    await repo.checkout(branchName);
  } catch {
    try {
      await execGit(repo.rootUri.fsPath, ["checkout", "-b", branchName, `origin/${branchName}`]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to checkout ${branchName}: ${msg}`);
    }
  }
}

export interface DirtyStatus {
  readonly staged: number;
  readonly unstaged: number;
  readonly branch: string;
}

export function getDirtyStatus(repo: Repository): DirtyStatus {
  return {
    staged: repo.state.indexChanges.length,
    unstaged: repo.state.workingTreeChanges.length,
    branch: repo.state.HEAD?.name ?? "(detached)",
  };
}

export async function stageAll(repo: Repository): Promise<void> {
  await execGit(repo.rootUri.fsPath, ["add", "-A"]);
}

/** True when the index has staged diffs (uses git, not vscode.git cache). */
export async function hasStagedChanges(repo: Repository): Promise<boolean> {
  try {
    await execGit(repo.rootUri.fsPath, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

export async function commit(
  repo: Repository,
  message: string,
  stageAllBefore: boolean,
): Promise<void> {
  if (stageAllBefore) await stageAll(repo);
  await repo.commit(message);
}

export async function push(repo: Repository): Promise<void> {
  const branch = repo.state.HEAD?.name;
  if (!branch) throw new Error("Cannot push from a detached HEAD.");
  await repo.push("origin", branch, true);
}

export function getOriginRemote(repo: Repository): { owner: string; repo: string } | undefined {
  const remote =
    repo.state.remotes.find((r) => r.name === "origin") ?? repo.state.remotes[0];
  const url = remote?.fetchUrl ?? remote?.pushUrl ?? remote?.url;
  if (!url) return undefined;
  return parseGitHubRemote(url);
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return undefined;
}

// ---------------------------------------------------------------------------
// Multi-repo shell helpers (used when iterating over submodule paths
// directly, without needing a vscode.git Repository object per submodule).
// ---------------------------------------------------------------------------

export async function isDirtyInDir(cwd: string): Promise<boolean> {
  try {
    const out = await execGit(cwd, ["status", "--porcelain"]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export async function currentBranchInDir(cwd: string): Promise<string | undefined> {
  try {
    const out = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return out === "HEAD" ? undefined : out;
  } catch {
    return undefined;
  }
}

export async function stageAllInDir(cwd: string): Promise<void> {
  await execGit(cwd, ["add", "-A"]);
}

export async function hasStagedChangesInDir(cwd: string): Promise<boolean> {
  try {
    await execGit(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

export async function commitInDir(cwd: string, message: string): Promise<void> {
  await execGit(cwd, ["commit", "-m", message]);
}

export async function pushInDir(cwd: string, branch: string): Promise<void> {
  // -u so the first push from a fresh task branch sets upstream.
  await execGit(cwd, ["push", "-u", "origin", branch]);
}

export async function aheadOfOriginInDir(cwd: string, branch: string): Promise<boolean> {
  try {
    // Returns count of commits on local that origin doesn't have.
    const out = await execGit(cwd, [
      "rev-list",
      "--count",
      `origin/${branch}..${branch}`,
    ]);
    return Number(out.trim()) > 0;
  } catch {
    // No upstream → treat as ahead so the caller pushes with -u.
    return true;
  }
}

export async function originBranchExistsInDir(cwd: string, branch: string): Promise<boolean> {
  try {
    await execGit(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function localBranchExistsInDir(cwd: string, branch: string): Promise<boolean> {
  try {
    await execGit(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function fetchOriginInDir(cwd: string): Promise<void> {
  try {
    await execGit(cwd, ["fetch", "origin", "--prune"]);
  } catch {
    /* offline / no remote */
  }
}

export async function pushRecurseSubmodulesInDir(cwd: string): Promise<void> {
  await execGit(cwd, ["push", "--recurse-submodules=on-demand"]);
}

export async function hasUnpushedCommitsInDir(cwd: string): Promise<boolean> {
  try {
    const out = await execGit(cwd, ["log", "@{u}..", "--oneline"]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export type { Repository, GitAPI };
