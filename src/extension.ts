import * as path from "node:path";
import * as vscode from "vscode";
import { parseMakefile } from "./makefile-parser";
import { HareerTreeProvider } from "./tree-provider";
import { disposeHareerTerminal, runMakeTarget } from "./terminal-runner";
import { CodeReviewProvider } from "./code-review/code-review-provider";
import type { CodeReviewNode } from "./code-review/code-review-provider";
import { HareerCommentProvider } from "./code-review/comment-provider";
import { openDiff, cleanupTempFiles } from "./code-review/diff-provider";
import { parseGitmodules } from "./code-review/submodule-parser";
import { invalidateToken, mergePR } from "./code-review/github-api";
import { syncConnectedContext } from "./task-manager/auth";
import { TaskService } from "./task-manager/task-service";
import { TaskTreeProvider } from "./task-manager/task-tree-provider";
import {
  connectClickUp,
  disconnectClickUp,
  switchClickUpWorkspace,
} from "./task-manager/commands";
import { TaskDetailPanel } from "./task-manager/task-detail-webview";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let makefileRootUri: vscode.Uri | undefined;

  const makefileProvider = new HareerTreeProvider();
  const makefileTreeView = vscode.window.createTreeView("hareerMakeTargets", {
    treeDataProvider: makefileProvider,
    showCollapseAll: true,
  });

  async function findMakefileDirectory(): Promise<vscode.Uri | undefined> {
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const makefile = vscode.Uri.joinPath(wf.uri, "Makefile");
      try {
        await vscode.workspace.fs.stat(makefile);
        return wf.uri;
      } catch {
        /* try next */
      }
    }

    const found = await vscode.workspace.findFiles(
      "**/Makefile",
      "**/{node_modules,.git}/**",
      32,
    );
    if (found.length === 0) return undefined;
    found.sort((a, b) => a.fsPath.length - b.fsPath.length);
    return vscode.Uri.file(path.dirname(found[0].fsPath));
  }

  async function reloadMakefile(): Promise<void> {
    makefileRootUri = await findMakefileDirectory();
    if (!makefileRootUri) {
      makefileProvider.setGroups([]);
      makefileTreeView.message = "No Makefile found in the workspace.";
      return;
    }

    makefileTreeView.message = undefined;
    const makefileUri = vscode.Uri.joinPath(makefileRootUri, "Makefile");
    try {
      const bytes = await vscode.workspace.fs.readFile(makefileUri);
      const text = new TextDecoder("utf-8").decode(bytes);
      makefileProvider.setGroups(parseMakefile(text));
    } catch (e) {
      makefileProvider.setGroups([]);
      const msg = e instanceof Error ? e.message : String(e);
      makefileTreeView.message = `Could not read Makefile: ${msg}`;
    }
  }

  await reloadMakefile();

  const codeReviewProvider = new CodeReviewProvider();
  const codeReviewTreeView = vscode.window.createTreeView("hareerCodeReview", {
    treeDataProvider: codeReviewProvider,
    showCollapseAll: true,
  });

  const commentProvider = new HareerCommentProvider();

  async function loadSubmodules(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    let gitmodulesUri: vscode.Uri | undefined;

    for (const wf of workspaceFolders) {
      const candidate = vscode.Uri.joinPath(wf.uri, ".gitmodules");
      try {
        await vscode.workspace.fs.stat(candidate);
        gitmodulesUri = candidate;
        break;
      } catch {
        /* try next */
      }
    }

    if (!gitmodulesUri) {
      codeReviewTreeView.message = "No .gitmodules file found in the workspace.";
      codeReviewProvider.setSubmodules([]);
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(gitmodulesUri);
      const text = new TextDecoder("utf-8").decode(bytes);
      const submodules = parseGitmodules(text);

      codeReviewTreeView.message =
        submodules.length === 0 ? "No GitHub submodules found in .gitmodules." : undefined;
      codeReviewProvider.setSubmodules(submodules);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      codeReviewTreeView.message = `Could not read .gitmodules: ${msg}`;
      codeReviewProvider.setSubmodules([]);
    }
  }

  await loadSubmodules();

  const taskService = new TaskService(context);
  const taskTreeProvider = new TaskTreeProvider(taskService);
  const taskTreeView = vscode.window.createTreeView("hareerTaskManager", {
    treeDataProvider: taskTreeProvider,
    showCollapseAll: true,
  });

  await syncConnectedContext(context);
  void taskService.refresh();

  context.subscriptions.push(
    makefileTreeView,
    codeReviewTreeView,
    taskTreeView,
    taskService,
    commentProvider,

    vscode.commands.registerCommand("hareer.runTarget", async (targetName: unknown) => {
      if (typeof targetName !== "string" || targetName.length === 0) return;
      if (!makefileRootUri) {
        void vscode.window.showWarningMessage(
          "Hareer: no Makefile in the workspace; open a folder that contains it.",
        );
        return;
      }
      runMakeTarget(makefileRootUri.fsPath, targetName);
    }),

    vscode.commands.registerCommand("hareer.refresh", async () => {
      await reloadMakefile();
    }),

    vscode.commands.registerCommand("hareer.refreshCodeReview", async () => {
      invalidateToken();
      await loadSubmodules();
      codeReviewProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "hareer.selectPR",
      async (node: CodeReviewNode | undefined) => {
        if (!node || node.kind !== "prSelector") {
          void vscode.window.showWarningMessage("Hareer: Select a submodule section first.");
          return;
        }
        await codeReviewProvider.selectPR(node.submodule);
      },
    ),

    vscode.commands.registerCommand(
      "hareer.openDiff",
      async (node: CodeReviewNode | undefined) => {
        if (!node || node.kind !== "file") return;
        await openDiff(node, async (submodule, pr, file, headSha, headUri) => {
          await commentProvider.loadCommentsForFile(submodule, pr, file, headSha, headUri);
        });
      },
    ),

    vscode.commands.registerCommand(
      "hareer.submitReview",
      async (node: CodeReviewNode | undefined) => {
        if (!node || node.kind !== "prSelector") {
          void vscode.window.showWarningMessage(
            "Hareer: Right-click a pull request row to submit a review.",
          );
          return;
        }
        const selectedPR = codeReviewProvider.getSelectedPR(node.submodule);
        if (!selectedPR) {
          void vscode.window.showWarningMessage(
            'Hareer: No pull request selected. Click "Select pull request…" first.',
          );
          return;
        }
        await commentProvider.promptSubmitReview(node.submodule, selectedPR);
      },
    ),

    vscode.commands.registerCommand(
      "hareer.mergePR",
      async (node: CodeReviewNode | undefined) => {
        if (!node || node.kind !== "prSelector") {
          void vscode.window.showWarningMessage("Hareer: Select a pull request row first.");
          return;
        }
        const selectedPR = codeReviewProvider.getSelectedPR(node.submodule);
        if (!selectedPR) {
          void vscode.window.showWarningMessage(
            'Hareer: No pull request selected. Click "Select pull request…" first.',
          );
          return;
        }

        const methodItems: vscode.QuickPickItem[] = [
          { label: "$(git-merge) Merge commit", description: "Create a merge commit" },
          { label: "$(squash) Squash and merge", description: "Squash all commits into one" },
          { label: "$(arrow-up) Rebase and merge", description: "Rebase commits onto base branch" },
        ];

        const picked = await vscode.window.showQuickPick(methodItems, {
          placeHolder: `Merge PR #${selectedPR.number}: ${selectedPR.title}`,
        });
        if (!picked) return;

        const confirmed = await vscode.window.showWarningMessage(
          `Merge PR #${selectedPR.number} into ${selectedPR.baseRef}?`,
          { modal: true },
          "Merge",
        );
        if (confirmed !== "Merge") return;

        let mergeMethod: "merge" | "squash" | "rebase";
        if (picked.label.includes("Squash")) mergeMethod = "squash";
        else if (picked.label.includes("Rebase")) mergeMethod = "rebase";
        else mergeMethod = "merge";

        try {
          await mergePR(
            node.submodule.owner,
            node.submodule.repo,
            selectedPR.number,
            mergeMethod,
          );
          void vscode.window.showInformationMessage(
            `Hareer: PR #${selectedPR.number} merged into ${selectedPR.baseRef} ✓`,
          );
          codeReviewProvider.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: Failed to merge PR — ${msg}`);
        }
      },
    ),

    vscode.commands.registerCommand("hareer.postComment", async (reply: vscode.CommentReply) => {
      await commentProvider.handlePostComment(reply);
    }),

    vscode.commands.registerCommand("hareer.approveReview", async (thread: vscode.CommentThread) => {
      await commentProvider.handleSubmitReviewFromThread(thread, "APPROVE");
    }),

    vscode.commands.registerCommand(
      "hareer.requestChangesReview",
      async (thread: vscode.CommentThread) => {
        await commentProvider.handleSubmitReviewFromThread(thread, "REQUEST_CHANGES");
      },
    ),

    vscode.commands.registerCommand("hareer.connectClickUp", async () => {
      await connectClickUp(context, taskService);
    }),

    vscode.commands.registerCommand("hareer.disconnectClickUp", async () => {
      await disconnectClickUp(context, taskService);
    }),

    vscode.commands.registerCommand("hareer.switchClickUpWorkspace", async () => {
      await switchClickUpWorkspace(taskService);
    }),

    vscode.commands.registerCommand("hareer.refreshTasks", async () => {
      await taskService.refresh();
    }),

    vscode.commands.registerCommand("hareer.openTaskDetail", async (taskId: unknown) => {
      if (typeof taskId !== "string" || taskId.length === 0) return;
      await TaskDetailPanel.openOrReveal(context, taskService, taskId);
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reloadMakefile();
      void loadSubmodules();
      void taskService.refresh();
    }),

    new vscode.Disposable(() => {
      disposeHareerTerminal();
      cleanupTempFiles();
    }),
  );
}

export function deactivate(): void {
  disposeHareerTerminal();
  cleanupTempFiles();
}
