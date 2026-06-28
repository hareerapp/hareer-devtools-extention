import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { Submodule } from "./types";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function resolveSubmodulePath(submodule: Submodule): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return undefined;
  const root = workspaceFolders[0].uri.fsPath;
  return `${root}/${submodule.path}`;
}

export function readBlobAtRef(
  submodule: Submodule,
  ref: string,
  filePath: string,
): Promise<string | undefined> {
  const cwd = resolveSubmodulePath(submodule);
  if (!cwd) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", "show", `${ref}:${filePath}`],
      { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}


export async function checkoutPRBranch(
  submodule: Submodule,
  headRef: string,
): Promise<void> {
  const cwd = resolveSubmodulePath(submodule);
  if (!cwd) {
    void vscode.window.showWarningMessage(
      "Hareer: No workspace folder found for git checkout.",
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking out ${headRef} in ${submodule.path}…`,
      cancellable: false,
    },
    async () => {
      try {
        await git(cwd, ["fetch", "origin"]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
          `Hareer: git fetch failed in ${submodule.path} — ${msg}`,
        );
      }

      try {
        await git(cwd, ["checkout", headRef]);
      } catch {
        try {
          await git(cwd, ["checkout", "-b", headRef, `origin/${headRef}`]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Hareer: Failed to checkout ${headRef} in ${submodule.path} — ${msg}`,
          );
          return;
        }
      }

      void vscode.window.showInformationMessage(
        `Hareer: Checked out ${headRef} in ${submodule.path}`,
      );
    },
  );
}
