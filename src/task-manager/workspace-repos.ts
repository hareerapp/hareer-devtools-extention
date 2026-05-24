import * as path from "node:path";
import * as vscode from "vscode";
import { parseGitmodules } from "../code-review/submodule-parser";

export interface WorkspaceRepo {
  readonly name: string;
  /** Relative path from workspace root (or "." for the root itself). */
  readonly path: string;
  readonly absPath: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly isSubmodule: boolean;
}

/**
 * Resolve all git repos accessible from the active workspace.
 *
 * - If a `.gitmodules` file exists at the first workspace folder, returns its
 *   submodules (each with parsed owner/repo where the URL points at GitHub).
 * - Otherwise returns a single entry for the workspace root.
 * - Returns an empty array when no workspace folder is open.
 */
export async function getWorkspaceRepos(): Promise<WorkspaceRepo[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return [];
  const rootUri = folders[0].uri;
  const rootPath = rootUri.fsPath;

  const gitmodulesUri = vscode.Uri.joinPath(rootUri, ".gitmodules");
  try {
    const bytes = await vscode.workspace.fs.readFile(gitmodulesUri);
    const text = new TextDecoder("utf-8").decode(bytes);
    const submodules = parseGitmodules(text);
    if (submodules.length > 0) {
      return submodules.map((s) => ({
        name: s.name,
        path: s.path,
        absPath: path.join(rootPath, s.path),
        owner: s.owner,
        repo: s.repo,
        isSubmodule: true,
      }));
    }
  } catch {
    /* no .gitmodules — fall through to single-repo case */
  }

  return [
    {
      name: path.basename(rootPath),
      path: ".",
      absPath: rootPath,
      isSubmodule: false,
    },
  ];
}
