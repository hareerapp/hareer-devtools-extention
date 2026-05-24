import { execFile } from "node:child_process";
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

interface Repository {
  readonly rootUri: vscode.Uri;
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

export async function pickRepository(): Promise<Repository | undefined> {
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
    { placeHolder: "Select repository for this task" },
  );
  return picked?.repo;
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

export async function getDefaultBranch(repo: Repository): Promise<string> {
  const remote = repo.state.remotes.find((r) => r.name === "origin") ?? repo.state.remotes[0];
  if (!remote) return "main";
  try {
    const out = await execGit(repo.rootUri.fsPath, [
      "symbolic-ref",
      `refs/remotes/${remote.name}/HEAD`,
      "--short",
    ]);
    const parts = out.split("/");
    return parts[parts.length - 1] || "main";
  } catch {
    return "main";
  }
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

export type { Repository, GitAPI };
