import * as vscode from "vscode";
import {
  aheadOfOriginInDir,
  checkoutBranch,
  checkoutBranchInDir,
  commit as gitCommit,
  commitInDir,
  createAndCheckoutBranch,
  createAndCheckoutBranchInDir,
  currentBranchInDir,
  fetchOriginInDir,
  findTaskBranch,
  getDirtyStatus,
  getOriginRemote,
  hasStagedChangesInDir,
  hasUnpushedCommitsInDir,
  isDirtyInDir,
  localBranchExistsInDir,
  originBranchExistsInDir,
  pickRepository,
  pickRepositoryForChanges,
  push as gitPush,
  pushInDir,
  pushRecurseSubmodulesInDir,
  stageAllInDir,
} from "./git-operations";
import type { Repository } from "./git-operations";
import { formatBranchName, formatPRTitle, validateGitRef } from "./branch-naming";
import { deriveScopeFromBranch, formatCommitMessage } from "./commit-naming";
import {
  generateCommitMessageViaCursor,
  isCursorIDE,
} from "./cursor-commit-generator";
import { findPRField, getLinkedPR } from "./pr-url-field";
import { getListStatuses, getTask, setCustomFieldValue, updateTaskStatus } from "./clickup-api";
import { getClickUpToken } from "./auth";
import { getWorkspaceRepos } from "./workspace-repos";
import type { WorkspaceRepo } from "./workspace-repos";
import { getAllPRs, getCachedPRDetail, invalidatePR } from "../code-review/pr-cache";
import type { PullRequest } from "../code-review/types";
import { branchExists, deleteBranch, isProtectedBranch, mergePR } from "../code-review/github-api";
import { PersistentCache, swr, TTL } from "../cache";
import { execFile } from "node:child_process";
import type { TaskService } from "./task-service";
import type { BranchType, ClickUpStatus, ClickUpTask, CommitType } from "./types";

// ============================================================================
// Types
// ============================================================================

type InboundMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openExternal"; url: string }
  | { type: "createBranch"; branchType: BranchType; repoPaths: string[]; baseRef: string }
  | { type: "checkoutLinkedPR" }
  | { type: "checkoutTaskBranches" }
  | { type: "openTaskReview" }
  | { type: "commit"; commitType: CommitType; subject: string; body: string; stageAll: boolean; thenPush: boolean; thenPR: boolean }
  | { type: "generateCommit"; stageAll: boolean }
  | { type: "push" }
  | { type: "createPRs"; baseRef: string }
  | { type: "mergeTaskPRs" }
  | { type: "deleteTaskBranches" }
  | { type: "changeStatus" }
  | { type: "promptLinkPR" };

interface RepoInfo {
  readonly name: string;
  readonly path: string;
  readonly absPath: string;
  readonly isSubmodule: boolean;
  readonly owner?: string;
  readonly repo?: string;
}

interface BranchMatch {
  readonly repoPath: string;
  readonly repoName: string;
  readonly absPath: string;
  readonly branch: string;
}

interface PRMatch {
  readonly repoPath: string;
  readonly repoName: string;
  readonly absPath: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headRef: string;
  readonly baseRef: string;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly headBranchExists: boolean;
  /** True when this is a merged, still-present, non-protected branch the user can delete. */
  readonly deletable: boolean;
}

interface PanelState {
  readonly taskId: string;
  task: ClickUpTask;
  repos: RepoInfo[];
  branchMatches: BranchMatch[];
  prMatches: PRMatch[];
}

interface TaskPRQuickPickItem extends vscode.QuickPickItem {
  pr?: PRMatch;
}

const REVIEW_ALL_PRS_LABEL = "$(list-selection) Review All";

// ============================================================================
// Panel
// ============================================================================

export class TaskDetailPanel {
  private static current: TaskDetailPanel | undefined;

  static async openOrReveal(
    context: vscode.ExtensionContext,
    service: TaskService,
    cache: PersistentCache,
    taskId: string,
  ): Promise<void> {
    if (TaskDetailPanel.current) {
      await TaskDetailPanel.current.show(taskId);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "hareerTaskDetail",
      "Hareer Task",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [],
      },
    );
    TaskDetailPanel.current = new TaskDetailPanel(context, service, cache, panel);
    await TaskDetailPanel.current.show(taskId);
  }

  private state: PanelState | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: TaskService,
    private readonly cache: PersistentCache,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg as InboundMessage),
      null,
      this.disposables,
    );
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible && this.state) {
          void this.show(this.state.taskId);
        }
      },
      null,
      this.disposables,
    );
  }

  async show(taskId: string, force = false): Promise<void> {
    const token = await getClickUpToken(this.context);
    if (!token) {
      void vscode.window.showWarningMessage("Hareer: Connect ClickUp first.");
      this.panel.dispose();
      return;
    }
    // First render: show skeleton until data arrives.
    if (!this.state || this.state.taskId !== taskId) {
      this.panel.webview.html = this.render();
      this.panel.reveal(vscode.ViewColumn.Active, false);
    }
    if (force) {
      this.cache.deleteByPrefix("branch.");
      this.cache.deleteByPrefix("allPRs.");
      this.cache.deleteByPrefix("prDetail.");
    }
    try {
      const task = await getTask(token, taskId);
      this.state = { taskId, task, repos: [], branchMatches: [], prMatches: [] };
      this.panel.title = task.customId ? `CU ${task.customId}` : `Task ${task.id.slice(0, 8)}`;
      this.postState();
      // Discover workspace context (repos, branches, PRs) async — pushes
      // updated state to the webview when done so header buttons appear.
      void this.discoverContext();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "error", message: msg });
    }
  }

  /** A new branch may now match the task id — drop cached branch lookups. */
  private invalidateBranchCache(): void {
    this.cache.deleteByPrefix("branch.");
  }

  private async discoverContext(): Promise<void> {
    if (!this.state) return;
    const taskKey = (this.state.task.customId ?? this.state.task.id).trim();
    const repos = await getWorkspaceRepos();
    this.state.repos = repos.map((r) => ({
      name: r.name,
      path: r.path,
      absPath: r.absPath,
      isSubmodule: r.isSubmodule,
      owner: r.owner,
      repo: r.repo,
    }));

    // Branch discovery — parallel across repos, served from cache (revalidated).
    const branchResults = await Promise.all(
      repos.map(async (r) => {
        const branch = await swr(
          this.cache,
          `branch.${r.absPath}.${taskKey}`,
          () => findTaskBranch(r.absPath, taskKey),
          { ttlMs: TTL.branches },
        );
        return branch ? { repoPath: r.path, repoName: r.name, absPath: r.absPath, branch } : null;
      }),
    );
    this.state.branchMatches = branchResults.filter((b): b is BranchMatch => b !== null);
    this.postState();

    // PR discovery — only for submodules with parsed owner/repo (i.e. GitHub).
    const prResults = await Promise.all(
      repos
        .filter((r): r is WorkspaceRepo & { owner: string; repo: string } => Boolean(r.owner && r.repo))
        .map(async (r) => {
          try {
            const prs = await getAllPRs(r.owner, r.repo);
            const matches = prs.filter((p) => p.headRef.toLowerCase().includes(taskKey.toLowerCase()));
            return Promise.all(
              matches.map(async (p): Promise<PRMatch> => {
                let mergeable: boolean | null = null;
                let headBranchExists = true;
                try {
                  const detail = await getCachedPRDetail(r.owner, r.repo, p.number);
                  mergeable = detail.mergeable;
                } catch {
                  // detail unavailable — mergeable stays null
                }
                if (p.merged) {
                  headBranchExists = await branchExists(r.owner, r.repo, p.headRef).catch(() => true);
                }
                return {
                  repoPath: r.path,
                  repoName: r.name,
                  absPath: r.absPath,
                  owner: r.owner,
                  repo: r.repo,
                  prNumber: p.number,
                  headRef: p.headRef,
                  baseRef: p.baseRef,
                  title: p.title,
                  url: p.url,
                  state: p.state,
                  merged: p.merged,
                  mergeable,
                  headBranchExists,
                  deletable:
                    p.merged && headBranchExists && !isProtectedBranch(p.headRef, p.baseRef),
                };
              }),
            );
          } catch {
            return [];
          }
        }),
    );
    this.state.prMatches = prResults.flat();
    this.postState();
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    if (!this.state) return;
    switch (msg.type) {
      case "ready":
        if (this.state) this.postState();
        return;
      case "refresh":
        await this.show(this.state.taskId, true);
        return;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "createBranch":
        await this.handleCreateBranch(msg.branchType, msg.repoPaths, msg.baseRef);
        return;
      case "checkoutLinkedPR":
        await this.handleCheckoutLinkedBranch();
        return;
      case "checkoutTaskBranches":
        await this.handleCheckoutTaskBranches();
        return;
      case "openTaskReview":
        await this.handleOpenTaskReview();
        return;
      case "mergeTaskPRs":
        await this.handleMergeTaskPRs();
        return;
      case "deleteTaskBranches":
        await this.handleDeleteTaskBranches();
        return;
      case "changeStatus":
        await this.handleChangeStatus();
        return;
      case "commit":
        await this.handleCommit(msg);
        return;
      case "generateCommit":
        await this.handleGenerateCommit(msg.stageAll);
        return;
      case "push":
        await this.handlePush();
        return;
      case "createPRs":
        await this.handleCreatePRs(msg.baseRef);
        return;
      case "promptLinkPR":
        await this.promptLinkPR();
        return;
    }
  }

  private async handleCreateBranch(
    branchType: BranchType,
    repoPaths: string[],
    baseRef: string,
  ): Promise<void> {
    if (!this.state) return;

    const branchName = formatBranchName({
      type: branchType,
      taskId: this.state.task.customId ?? this.state.task.id,
      title: this.state.task.name,
    });
    const invalid = validateGitRef(branchName);
    if (invalid) {
      void vscode.window.showErrorMessage(`Hareer: Invalid branch name — ${invalid}`);
      return;
    }
    const base = (baseRef || "develop").trim();

    // Multi-repo path: ≥1 repo path provided AND we have at least one submodule.
    const submoduleTargets = this.state.repos.filter(
      (r) => r.isSubmodule && repoPaths.includes(r.path),
    );

    if (submoduleTargets.length > 0) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating ${branchName} in ${submoduleTargets.length} repo${submoduleTargets.length === 1 ? "" : "s"}…`,
          cancellable: false,
        },
        async () => {
          const errors: string[] = [];
          for (const target of submoduleTargets) {
            try {
              await createAndCheckoutBranchInDir(target.absPath, branchName, base);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${target.name}: ${msg}`);
            }
          }
          const ok = submoduleTargets.length - errors.length;
          if (ok > 0) {
            this.postFlash(`Created ${branchName} in ${ok} repo${ok === 1 ? "" : "s"}.`);
            void vscode.window.showInformationMessage(
              `Hareer: Created ${branchName} in ${ok} repo${ok === 1 ? "" : "s"}.`,
            );
          }
          if (errors.length > 0) {
            void vscode.window.showWarningMessage(
              `Hareer: Branch creation failed in ${errors.length} repo${errors.length === 1 ? "" : "s"} — ${errors[0]}`,
            );
          }
          await this.maybeAutoTransition("in progress");
          this.invalidateBranchCache();
          void this.discoverContext();
        },
      );
      return;
    }

    // Single-repo path: use vscode.git API (better integration with SCM panel).
    const repo = await pickRepository();
    if (!repo) return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating branch ${branchName}…`,
        cancellable: false,
      },
      async () => {
        try {
          await createAndCheckoutBranch(repo, branchName, base);
          void vscode.window.showInformationMessage(`Hareer: Checked out ${branchName}`);
          this.postFlash(`On branch ${branchName}`);
          await this.maybeAutoTransition("in progress");
          this.invalidateBranchCache();
          void this.discoverContext();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: Branch creation failed — ${msg}`);
        }
      },
    );
  }

  private async handleCheckoutTaskBranches(): Promise<void> {
    if (!this.state) return;
    const matches = this.state.branchMatches;
    if (matches.length === 0) {
      void vscode.window.showWarningMessage(
        "Hareer: No branch found containing this task ID in any repo.",
      );
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking out ${matches.length} branch${matches.length === 1 ? "" : "es"}…`,
        cancellable: false,
      },
      async () => {
        const errors: string[] = [];
        for (const m of matches) {
          try {
            await checkoutBranchInDir(m.absPath, m.branch);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${m.repoName}: ${msg}`);
          }
        }
        const ok = matches.length - errors.length;
        if (ok > 0) {
          this.postFlash(`Checked out in ${ok} repo${ok === 1 ? "" : "s"}.`);
          void vscode.window.showInformationMessage(
            `Hareer: Checked out task branch in ${ok} repo${ok === 1 ? "" : "s"}.`,
          );
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(
            `Hareer: Checkout failed in ${errors.length} repo${errors.length === 1 ? "" : "s"} — ${errors[0]}`,
          );
        }
      },
    );
  }

  private async handleOpenTaskReview(): Promise<void> {
    if (!this.state) return;
    const prs = this.state.prMatches;

    await vscode.commands.executeCommand(
      "hareer.retainCodeReviewPRs",
      prs.map((p) => ({ submoduleName: p.repoName, prNumber: p.prNumber })),
    );

    if (prs.length === 0) {
      void vscode.window.showWarningMessage(
        "Hareer: No open PR found whose branch contains this task ID.",
      );
      return;
    }

    // Checkout matching branches first (best-effort).
    for (const m of this.state.branchMatches) {
      try {
        await checkoutBranchInDir(m.absPath, m.branch);
      } catch {
        /* tolerate */
      }
    }

    if (prs.length === 1) {
      await this.showPRInCodeReview(prs[0]);
      return;
    }

    const picked = await vscode.window.showQuickPick<TaskPRQuickPickItem>(
      [
        {
          label: REVIEW_ALL_PRS_LABEL,
          description: `Open all ${prs.length} matching pull requests`,
          alwaysShow: true,
        },
        ...prs.map((p) => ({
          label: `#${p.prNumber} · ${p.title}`,
          description: `${p.owner}/${p.repo}`,
          pr: p,
        })),
      ],
      { placeHolder: "Multiple PRs match this task — pick one to review" },
    );
    if (!picked) return;
    if (picked.label === REVIEW_ALL_PRS_LABEL) {
      for (const p of prs) {
        await this.showPRInCodeReview(p);
      }
      return;
    }
    if (!picked.pr) return;
    await this.showPRInCodeReview(picked.pr);
  }

  private async handleMergeTaskPRs(): Promise<void> {
    if (!this.state) return;
    const prs = this.state.prMatches.filter((p) => p.state === "open" && !p.merged);
    if (prs.length === 0) {
      void vscode.window.showWarningMessage(
        "Hareer: No open PR found whose branch contains this task ID.",
      );
      return;
    }

    const methodItems: (vscode.QuickPickItem & { method: "merge" | "squash" | "rebase" })[] = [
      { label: "$(git-merge) Merge commit", description: "Create a merge commit", method: "merge" },
      { label: "$(squash) Squash and merge", description: "Squash all commits into one", method: "squash" },
      { label: "$(arrow-up) Rebase and merge", description: "Rebase commits onto base branch", method: "rebase" },
    ];
    const pickedMethod = await vscode.window.showQuickPick(methodItems, {
      placeHolder: `Merge ${prs.length} PR${prs.length === 1 ? "" : "s"} for this task`,
    });
    if (!pickedMethod) return;
    const method = pickedMethod.method;

    const confirmed = await vscode.window.showWarningMessage(
      `Merge ${prs.length} PR${prs.length === 1 ? "" : "s"} for this task and mark it "ready to deploy"?`,
      { modal: true },
      "Merge",
    );
    if (confirmed !== "Merge") return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Merging ${prs.length} PR${prs.length === 1 ? "" : "s"}…`,
        cancellable: false,
      },
      async () => {
        const merged: string[] = [];
        const failed: string[] = [];

        for (const pr of prs) {
          try {
            await mergePR(pr.owner, pr.repo, pr.prNumber, method);
            invalidatePR(pr.owner, pr.repo, pr.prNumber);
            merged.push(`${pr.repoName} #${pr.prNumber}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failed.push(`${pr.repoName} #${pr.prNumber}: ${msg}`);
          }
        }

        if (merged.length > 0) {
          this.postFlash(`Merged ${merged.length} PR${merged.length === 1 ? "" : "s"}.`);
          void vscode.window.showInformationMessage(
            `Hareer: Merged ${merged.length} PR${merged.length === 1 ? "" : "s"} — ${merged.join(", ")}.`,
          );
        }
        if (failed.length > 0) {
          void vscode.window.showWarningMessage(
            `Hareer: ${failed.length} PR${failed.length === 1 ? "" : "s"} could not be merged — ${failed.join("; ")}`,
          );
        }

        // Only advance the task when every matched PR merged cleanly.
        if (failed.length === 0 && merged.length > 0) {
          await this.maybeAutoTransition("ready to deploy");
        }

        void this.discoverContext();
        void this.service.refresh();
      },
    );
  }

  private async handleDeleteTaskBranches(): Promise<void> {
    if (!this.state) return;
    const deletable = this.state.prMatches.filter((p) => p.deletable);
    if (deletable.length === 0) {
      void vscode.window.showInformationMessage("Hareer: No deletable branches found.");
      return;
    }

    const branchList = deletable.map((p) => `${p.repoName}: ${p.headRef}`).join("\n");
    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${deletable.length} merged branch${deletable.length === 1 ? "" : "es"}?\n${branchList}`,
      { modal: true },
      "Delete",
    );
    if (confirmed !== "Delete") return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deleting ${deletable.length} branch${deletable.length === 1 ? "" : "es"}…`,
        cancellable: false,
      },
      async () => {
        const deleted: string[] = [];
        const failed: string[] = [];

        for (const p of deletable) {
          try {
            await deleteBranch(p.owner, p.repo, p.headRef);
            invalidatePR(p.owner, p.repo, p.prNumber);
            deleted.push(`${p.repoName}: ${p.headRef}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failed.push(`${p.repoName}: ${p.headRef} — ${msg}`);
          }
        }

        if (deleted.length > 0) {
          void vscode.window.showInformationMessage(
            `Hareer: Deleted ${deleted.length} branch${deleted.length === 1 ? "" : "es"} — ${deleted.join(", ")}.`,
          );
        }
        if (failed.length > 0) {
          void vscode.window.showWarningMessage(
            `Hareer: ${failed.length} branch${failed.length === 1 ? "" : "es"} could not be deleted — ${failed.join("; ")}`,
          );
        }

        void this.discoverContext();
        void this.service.refresh();
      },
    );
  }

  private async handleChangeStatus(): Promise<void> {
    if (!this.state) return;
    const token = await getClickUpToken(this.context);
    if (!token) {
      void vscode.window.showWarningMessage("Hareer: Connect ClickUp first.");
      return;
    }

    let statuses: ClickUpStatus[];
    try {
      statuses = await getListStatuses(token, this.state.task.list.id);
    } catch {
      void vscode.window.showErrorMessage("Hareer: Failed to fetch task statuses.");
      return;
    }

    const current = this.state.task.status.status.toLowerCase();
    const items = statuses.map((s) => ({
      label: s.status,
      description: s.status.toLowerCase() === current ? "(current)" : undefined,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Change status from "${this.state.task.status.status}"`,
    });
    if (!picked || picked.label.toLowerCase() === current) return;

    try {
      await updateTaskStatus(token, this.state.task.id, picked.label);
      void this.service.refresh();
      await this.show(this.state.taskId);
    } catch {
      void vscode.window.showErrorMessage("Hareer: Failed to update task status.");
    }
  }

  /** Route a matched PR into the Code Review tree (no standalone detail panel). */
  private async showPRInCodeReview(match: PRMatch): Promise<void> {
    await vscode.commands.executeCommand(
      "hareer.showPRInCodeReview",
      {
        name: match.repoName,
        path: match.repoPath,
        url: `https://github.com/${match.owner}/${match.repo}`,
        owner: match.owner,
        repo: match.repo,
      },
      match.prNumber,
    );
  }

  private async handleCheckoutLinkedBranch(): Promise<void> {
    if (!this.state) return;
    const fieldName = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<string>("prUrlFieldName", "Github PR Url");
    const linked = getLinkedPR(this.state.task, fieldName);
    if (!linked) {
      void vscode.window.showWarningMessage("Hareer: No linked PR URL on this task.");
      return;
    }
    const repo = await pickRepository();
    if (!repo) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fetching PR #${linked.number}…`,
        cancellable: false,
      },
      async () => {
        try {
          const headRef = await fetchPRHeadRef(linked.owner, linked.repo, linked.number);
          await checkoutBranch(repo, headRef);
          void vscode.window.showInformationMessage(`Hareer: Checked out ${headRef}`);
          this.postFlash(`On branch ${headRef}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: Checkout failed — ${msg}`);
        }
      },
    );
  }

  private async handleGenerateCommit(stageAll: boolean): Promise<void> {
    if (!this.state) return;
    const repo = await pickRepositoryForChanges();
    if (!repo) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Generating commit message with Cursor…",
        cancellable: false,
      },
      async () => {
        try {
          const draft = await generateCommitMessageViaCursor(repo, stageAll);
          const formType = formCommitTypeForWebview(draft.type);
          void this.panel.webview.postMessage({
            type: "commitDraft",
            commitType: formType,
            scope: draft.scope ?? "",
            subject: draft.subject,
            body: draft.body ?? "",
          });
          this.postState();
          this.postFlash("Commit message generated.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: ${msg}`);
        }
      },
    );
  }

  private async handleCommit(
    msg: Extract<InboundMessage, { type: "commit" }>,
  ): Promise<void> {
    if (!this.state) return;
    if (msg.subject.trim().length === 0) {
      void vscode.window.showWarningMessage("Hareer: Commit subject is required.");
      return;
    }

    const submodules = this.state.repos.filter((r) => r.isSubmodule);

    // Single-repo workspace (no .gitmodules): keep the old single-repo path.
    if (submodules.length === 0) {
      const repo = await pickRepositoryForChanges();
      if (!repo) return;
      const scope = deriveScopeFromBranch(repo.state.HEAD?.name);
      const message = formatCommitMessage({
        type: msg.commitType,
        scope,
        subject: msg.subject.trim(),
        body: msg.body.trim() || undefined,
      });
      try {
        await gitCommit(repo, message, msg.stageAll);
        void vscode.window.showInformationMessage("Hareer: Commit created.");
        this.postFlash("Committed.");
        if (msg.thenPush) {
          if (msg.thenPR) {
            await this.pushAndMaybeOfferPR(repo);
          } else {
            await this.pushOnly(repo);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Hareer: Commit failed — ${errMsg}`);
      }
      return;
    }

    // Multi-repo (submodules): find dirty ones, align branches, commit each.
    const dirtyTargets = await this.collectDirtySubmodules(submodules);
    if (dirtyTargets.length === 0) {
      void vscode.window.showInformationMessage(
        "Hareer: No submodule has uncommitted changes.",
      );
      return;
    }

    const canonicalBranch = await this.pickCanonicalBranch(dirtyTargets);
    if (!canonicalBranch) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Committing in ${dirtyTargets.length} repo${dirtyTargets.length === 1 ? "" : "s"}…`,
        cancellable: false,
      },
      async () => {
        const scope = deriveScopeFromBranch(canonicalBranch);
        const message = formatCommitMessage({
          type: msg.commitType,
          scope,
          subject: msg.subject.trim(),
          body: msg.body.trim() || undefined,
        });

        const errors: string[] = [];
        const committed: typeof dirtyTargets = [];
        for (const target of dirtyTargets) {
          try {
            if (msg.stageAll) await stageAllInDir(target.absPath);
            if (!(await hasStagedChangesInDir(target.absPath))) continue;
            await commitInDir(target.absPath, message);
            committed.push(target);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            errors.push(`${target.name}: ${errMsg}`);
          }
        }

        if (committed.length > 0) {
          this.postFlash(`Committed in ${committed.length} repo${committed.length === 1 ? "" : "s"}.`);
          void vscode.window.showInformationMessage(
            `Hareer: Commit created in ${committed.length} repo${committed.length === 1 ? "" : "s"}.`,
          );
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(
            `Hareer: Commit failed in ${errors.length} repo${errors.length === 1 ? "" : "s"} — ${errors[0]}`,
          );
        }

        if (msg.thenPush && committed.length > 0) {
          await this.pushSubmodules(committed.map((c) => c.absPath), canonicalBranch);
          if (msg.thenPR) {
            await this.maybeOfferCreatePRMultiRepo(committed, canonicalBranch);
          }
        }

        void this.discoverContext();
      },
    );
  }

  private async collectDirtySubmodules(
    submodules: RepoInfo[],
  ): Promise<RepoInfo[]> {
    const checks = await Promise.all(
      submodules.map(async (r) => ((await isDirtyInDir(r.absPath)) ? r : null)),
    );
    return checks.filter((r): r is RepoInfo => r !== null);
  }

  private async pickCanonicalBranch(
    targets: RepoInfo[],
  ): Promise<string | undefined> {
    const branches = await Promise.all(
      targets.map(async (t) => ({ repo: t, branch: await currentBranchInDir(t.absPath) })),
    );
    const named = branches.filter((b): b is { repo: RepoInfo; branch: string } => Boolean(b.branch));
    if (named.length === 0) {
      void vscode.window.showErrorMessage("Hareer: Could not determine current branch in any repo.");
      return undefined;
    }
    const unique = Array.from(new Set(named.map((b) => b.branch)));
    if (unique.length === 1) return unique[0];

    // Repos sit on different branches — let the user pick a canonical one.
    const picked = await vscode.window.showQuickPick(
      unique.map((b) => ({
        label: b,
        description: named
          .filter((n) => n.branch === b)
          .map((n) => n.repo.name)
          .join(", "),
      })),
      {
        placeHolder: "Submodules are on different branches — pick the canonical branch for this commit",
      },
    );
    return picked?.label;
  }

  private async pushSubmodules(
    absPaths: string[],
    branch: string,
  ): Promise<void> {
    for (const cwd of absPaths) {
      try {
        if (await aheadOfOriginInDir(cwd, branch)) {
          await pushInDir(cwd, branch);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(`Hareer: Push failed for ${cwd} — ${msg}`);
      }
    }
    this.postFlash("Pushed to origin.");
  }

  private async maybeOfferCreatePRMultiRepo(
    committed: RepoInfo[],
    branch: string,
  ): Promise<void> {
    if (!this.state) return;
    const fieldName = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<string>("prUrlFieldName", "Github PR Url");
    const existing = getLinkedPR(this.state.task, fieldName);
    if (existing) return;
    const eligible = committed.filter((c) => c.owner && c.repo);
    if (eligible.length === 0) return;

    const baseRef = await this.pickPRBase();
    if (!baseRef) return;
    await this.createPRsForBranch(eligible, branch, baseRef);
  }

  private async pickPRBase(): Promise<string | undefined> {
    const cfg = vscode.workspace.getConfiguration("hareer.git");
    const options = cfg.get<string[]>("baseBranches", ["develop", "staging", "main"]);
    const def = cfg.get<string>("defaultBaseBranch", "develop");
    const picked = await vscode.window.showQuickPick(
      options.map((b) => ({ label: b, description: b === def ? "default" : undefined })),
      { placeHolder: "Pick base branch for the pull requests" },
    );
    return picked?.label;
  }

  /** Drives `gh pr create` across submodule paths, mirroring `make new-pr`. */
  private async createPRsForBranch(
    targets: RepoInfo[],
    branch: string,
    baseRef: string,
  ): Promise<void> {
    if (!(await ghIsAvailable())) {
      void vscode.window.showErrorMessage(
        "Hareer: `gh` (GitHub CLI) is required to create PRs. Install it and run `gh auth login`.",
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating PRs for ${branch}…`,
        cancellable: false,
      },
      async () => {
        const created: { repo: RepoInfo; url: string }[] = [];
        const skipped: string[] = [];
        const errors: string[] = [];

        for (const target of targets) {
          if (!target.owner || !target.repo) continue;
          try {
            await fetchOriginInDir(target.absPath);

            const localExists = await localBranchExistsInDir(target.absPath, branch);
            const remoteExists = await originBranchExistsInDir(target.absPath, branch);
            if (!localExists && !remoteExists) {
              skipped.push(`${target.name} (branch not found)`);
              continue;
            }

            // Push branch if it's local-only or ahead of origin.
            if (localExists && (!remoteExists || (await aheadOfOriginInDir(target.absPath, branch)))) {
              try {
                await pushInDir(target.absPath, branch);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`${target.name}: push failed — ${msg}`);
                continue;
              }
            }

            // Skip if an open PR already exists for this head (force a fresh read).
            try {
              const prs = await getAllPRs(target.owner, target.repo, { force: true });
              const existing = prs.find((p) => p.headRef === branch && p.state === "open");
              if (existing) {
                skipped.push(`${target.name} (PR #${existing.number} already open)`);
                continue;
              }
            } catch {
              /* fall through and attempt creation; gh will error if dup */
            }

            const url = await ghPRCreate(target.absPath, baseRef, branch);
            created.push({ repo: target, url });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${target.name}: ${msg}`);
          }
        }

        if (created.length > 0) {
          void vscode.window.showInformationMessage(
            `Hareer: Opened ${created.length} PR${created.length === 1 ? "" : "s"} — ${created.map((c) => c.repo.name).join(", ")}.`,
          );
          // Link the first newly-created PR to ClickUp (best-effort).
          await this.handleLinkPR(created[0].url);
        }
        if (skipped.length > 0) {
          void vscode.window.showInformationMessage(
            `Hareer: Skipped — ${skipped.join("; ")}`,
          );
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(
            `Hareer: PR creation failed — ${errors.join("; ")}`,
          );
        }
        // New PRs exist now — drop the cached open-PR lists so discovery refetches.
        for (const c of created) {
          if (c.repo.owner && c.repo.repo) invalidatePR(c.repo.owner, c.repo.repo);
        }
        void this.discoverContext();
      },
    );
  }

  private async handleCreatePRs(_baseRef: string): Promise<void> {
    if (!this.state) return;
    const ghCandidates = this.state.repos.filter(
      (r): r is RepoInfo & { owner: string; repo: string } => Boolean(r.owner && r.repo),
    );
    if (ghCandidates.length === 0) {
      void vscode.window.showWarningMessage(
        "Hareer: No GitHub remote detected in the workspace.",
      );
      return;
    }
    const baseRef = await this.pickPRBase();
    if (!baseRef) return;
    const targetsByPath = new Map<string, RepoInfo>();
    for (const r of ghCandidates) targetsByPath.set(r.path, r);

    // Group branchMatches by branch; the most-common task branch wins.
    const branchCounts = new Map<string, number>();
    for (const b of this.state.branchMatches) {
      branchCounts.set(b.branch, (branchCounts.get(b.branch) ?? 0) + 1);
    }
    let branch: string | undefined;
    if (branchCounts.size === 1) {
      branch = [...branchCounts.keys()][0];
    } else if (branchCounts.size > 1) {
      const picked = await vscode.window.showQuickPick(
        [...branchCounts.entries()].map(([b, n]) => ({
          label: b,
          description: `${n} repo${n === 1 ? "" : "s"}`,
        })),
        { placeHolder: "Pick the task branch to open PRs for" },
      );
      branch = picked?.label;
    }
    if (!branch) {
      // No matches detected — ask the user to type the branch.
      branch = await vscode.window.showInputBox({
        prompt: "Task branch name to open PRs for",
        placeHolder: "feature/86ex9cp7m-…",
      });
      if (!branch) return;
    }

    const targets = this.state.branchMatches.length > 0
      ? this.state.branchMatches
          .map((b) => targetsByPath.get(b.repoPath))
          .filter((r): r is RepoInfo => Boolean(r))
      : ghCandidates;

    await this.createPRsForBranch(targets, branch, baseRef);
  }

  private async handlePush(): Promise<void> {
    if (!this.state) return;
    const submodules = this.state.repos.filter((r) => r.isSubmodule);

    // Single-repo workspace: legacy path through the vscode.git API.
    if (submodules.length === 0) {
      const repo = await pickRepository();
      if (!repo) return;
      await this.pushAndMaybeOfferPR(repo);
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Pushing submodules…",
        cancellable: false,
      },
      async () => {
        const pushed: { repo: RepoInfo; branch: string }[] = [];
        const errors: string[] = [];

        for (const target of submodules) {
          const branch = await currentBranchInDir(target.absPath);
          if (!branch) continue;
          try {
            if (!(await hasUnpushedCommitsInDir(target.absPath))) continue;
            await pushInDir(target.absPath, branch);
            pushed.push({ repo: target, branch });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${target.name}: ${msg}`);
          }
        }

        // Umbrella: if the workspace root is itself a repo and has pointer
        // updates (or any unpushed commits), push with --recurse-submodules.
        const umbrellaPath = this.state?.repos.find((r) => r.path === ".")?.absPath
          ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (umbrellaPath) {
          try {
            const umbrellaBranch = await currentBranchInDir(umbrellaPath);
            if (umbrellaBranch && (await hasUnpushedCommitsInDir(umbrellaPath))) {
              await pushRecurseSubmodulesInDir(umbrellaPath);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`umbrella: ${msg}`);
          }
        }

        if (pushed.length > 0) {
          this.postFlash(`Pushed ${pushed.length} repo${pushed.length === 1 ? "" : "s"}.`);
          void vscode.window.showInformationMessage(
            `Hareer: Pushed ${pushed.map((p) => `${p.repo.name}:${p.branch}`).join(", ")}.`,
          );
        } else if (errors.length === 0) {
          void vscode.window.showInformationMessage("Hareer: Nothing to push.");
        }
        if (errors.length > 0) {
          void vscode.window.showWarningMessage(
            `Hareer: Push failed — ${errors.join("; ")}`,
          );
        }
      },
    );
  }

  private async pushAndMaybeOfferPR(repo: Repository): Promise<void> {
    if (!this.state) return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Pushing…",
        cancellable: false,
      },
      async () => {
        try {
          await gitPush(repo);
          void vscode.window.showInformationMessage("Hareer: Pushed.");
          this.postFlash("Pushed to origin.");
          await this.maybeOfferCreatePR(repo);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: Push failed — ${msg}`);
        }
      },
    );
  }

  private async pushOnly(repo: Repository): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Pushing…",
        cancellable: false,
      },
      async () => {
        try {
          await gitPush(repo);
          void vscode.window.showInformationMessage("Hareer: Pushed.");
          this.postFlash("Pushed to origin.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: Push failed — ${msg}`);
        }
      },
    );
  }

  private async maybeOfferCreatePR(repo: Repository): Promise<void> {
    if (!this.state) return;
    const fieldName = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<string>("prUrlFieldName", "Github PR Url");
    const existing = getLinkedPR(this.state.task, fieldName);
    if (existing) return;

    const origin = getOriginRemote(repo);
    const branch = repo.state.HEAD?.name;
    if (!origin || !branch) return;

    const compareUrl = `https://github.com/${origin.owner}/${origin.repo}/pull/new/${encodeURIComponent(branch)}`;
    const choice = await vscode.window.showInformationMessage(
      "Hareer: Create a pull request on GitHub?",
      "Open Create PR",
      "Paste PR URL",
      "Later",
    );
    if (choice === "Open Create PR") {
      await vscode.env.openExternal(vscode.Uri.parse(compareUrl));
      return;
    }
    if (choice === "Paste PR URL") {
      const url = await vscode.window.showInputBox({
        prompt: "Paste the PR URL to link it to this ClickUp task",
        placeHolder: "https://github.com/owner/repo/pull/123",
        validateInput: (v) =>
          /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(v.trim())
            ? undefined
            : "Must be a GitHub PR URL",
      });
      if (url) await this.handleLinkPR(url.trim());
    }
  }

  /**
   * Link an existing PR to the task: pick a submodule, pick one of its PRs,
   * rename the PR to follow the ClickUp-id convention (`[CU-123] …`), then
   * store its URL on the task. Only one PR is linked per task — relinking
   * replaces the existing link after a confirm. Falls back to a paste-a-URL
   * input box when the workspace has no GitHub-backed submodules.
   */
  private async promptLinkPR(): Promise<void> {
    if (!this.state) return;
    const fieldName = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<string>("prUrlFieldName", "Github PR Url");

    // 1. Pick a GitHub-backed submodule (skip the picker when there's only one).
    const ghRepos = this.state.repos.filter(
      (r): r is RepoInfo & { owner: string; repo: string } => Boolean(r.owner && r.repo),
    );
    if (ghRepos.length === 0) {
      await this.promptPastePRUrl(fieldName);
      return;
    }
    let repo = ghRepos[0];
    if (ghRepos.length > 1) {
      const picked = await vscode.window.showQuickPick(
        ghRepos.map((r) => ({
          label: r.name,
          description: `${r.owner}/${r.repo}`,
          repo: r,
        })),
        { placeHolder: "Pick a submodule to link a PR from" },
      );
      if (!picked) return;
      repo = picked.repo;
    }

    // 2. Pick one of that submodule's PRs (open ones first).
    let prs: PullRequest[];
    try {
      prs = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading PRs for ${repo.name}…`,
          cancellable: false,
        },
        () => getAllPRs(repo.owner, repo.repo, { force: true }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Could not load PRs for ${repo.name} — ${msg}`);
      return;
    }
    if (prs.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        `Hareer: No PRs found in ${repo.name}.`,
        "Paste URL instead",
      );
      if (choice === "Paste URL instead") await this.promptPastePRUrl(fieldName);
      return;
    }
    const sorted = [...prs].sort((a, b) =>
      a.state === b.state ? b.number - a.number : a.state === "open" ? -1 : 1,
    );
    const pickedPR = await vscode.window.showQuickPick(
      sorted.map((p) => ({
        label: `#${p.number} · ${p.title}`,
        description: [p.merged ? "merged" : p.state, p.headRef].join(" · "),
        pr: p,
      })),
      { placeHolder: `Pick a PR from ${repo.name} to link to this task` },
    );
    if (!pickedPR) return;
    const pr = pickedPR.pr;

    // 3. Enforce one linked PR per task — confirm before replacing a different one.
    const existing = getLinkedPR(this.state.task, fieldName);
    if (existing && existing.url !== pr.url) {
      const choice = await vscode.window.showWarningMessage(
        `Hareer: This task already links PR #${existing.number} (${existing.owner}/${existing.repo}). Replace it with #${pr.number}?`,
        { modal: true },
        "Replace",
      );
      if (choice !== "Replace") return;
    }

    // 4. Apply the ClickUp-id convention to the PR title (best-effort).
    const taskId = (this.state.task.customId ?? this.state.task.id).trim();
    const newTitle = formatPRTitle(taskId, pr.title);
    if (newTitle !== pr.title) {
      if (await ghIsAvailable()) {
        try {
          await ghPREdit(repo.absPath, pr.url, newTitle);
          invalidatePR(repo.owner, repo.repo, pr.number);
          this.postFlash(`Renamed PR #${pr.number} → ${newTitle}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showWarningMessage(
            `Hareer: Linked PR but could not rename it — ${msg}`,
          );
        }
      } else {
        void vscode.window.showWarningMessage(
          "Hareer: `gh` (GitHub CLI) not found — linked PR without applying the title convention.",
        );
      }
    }

    // 5. Store the PR URL on the ClickUp task.
    await this.handleLinkPR(pr.url);
  }

  /** Native input-box fallback used when no GitHub submodule PRs are available. */
  private async promptPastePRUrl(fieldName: string): Promise<void> {
    if (!this.state) return;
    const current = getLinkedPR(this.state.task, fieldName)?.url ?? "";
    const url = await vscode.window.showInputBox({
      prompt: "Paste the GitHub PR URL to link to this ClickUp task",
      placeHolder: "https://github.com/owner/repo/pull/123",
      value: current,
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(v.trim())
          ? undefined
          : "Must be a GitHub PR URL",
    });
    if (!url) return;
    await this.handleLinkPR(url.trim());
  }

  private async handleLinkPR(url: string): Promise<void> {
    if (!this.state) return;
    const fieldName = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<string>("prUrlFieldName", "Github PR Url");
    const field = findPRField(this.state.task, fieldName);
    if (!field) {
      void vscode.window.showWarningMessage(
        `Hareer: This task has no custom field named "${fieldName}". Configure hareer.clickup.prUrlFieldName.`,
      );
      return;
    }
    const token = await getClickUpToken(this.context);
    if (!token) return;
    try {
      await setCustomFieldValue(token, this.state.task.id, field.id, url);
      void vscode.window.showInformationMessage("Hareer: Linked PR URL to ClickUp task.");
      await this.maybeAutoTransition("in review");
      await this.show(this.state.taskId);
      void this.service.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Could not link PR — ${msg}`);
    }
  }

  private async maybeAutoTransition(targetStatus: string): Promise<void> {
    if (!this.state) return;
    const auto = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<boolean>("autoTransition", true);
    if (!auto) return;
    if (this.state.task.status.status.toLowerCase() === targetStatus.toLowerCase()) return;
    const token = await getClickUpToken(this.context);
    if (!token) return;
    try {
      await updateTaskStatus(token, this.state.task.id, targetStatus);
      void this.service.refresh();
    } catch {
      /* status name may not match in this workspace; surface no error */
    }
  }

  private postFlash(text: string): void {
    void this.panel.webview.postMessage({ type: "flash", text });
  }

  private postState(): void {
    if (!this.state) return;
    const fieldName = vscode.workspace
      .getConfiguration("hareer.clickup")
      .get<string>("prUrlFieldName", "Github PR Url");
    const linked = getLinkedPR(this.state.task, fieldName);
    const status = this.state.task.status;
    const task = this.state.task;
    void this.panel.webview.postMessage({
      type: "state",
      task: {
        id: task.id,
        customId: task.customId ?? task.id,
        name: task.name,
        description: task.description,
        status: {
          status: status.status,
          type: status.type,
          color: sanitizeColor(status.color),
        },
        priority: task.priority
          ? { priority: task.priority.priority, color: sanitizeColor(task.priority.color) }
          : undefined,
        url: task.url,
        list: task.list,
        space: task.space,
        folder: task.folder,
        assignees: task.assignees.map((a) => ({
          username: a.username,
          email: a.email,
          avatar: a.profilePicture ?? "",
        })),
        watchers: (task.watchers ?? []).map((w) => w.username),
        creator: task.creator?.username,
        tags: (task.tags ?? []).map((t) => ({
          name: t.name,
          fg: sanitizeColor(t.fg),
          bg: sanitizeColor(t.bg),
        })),
        dueDate: task.dueDate,
        startDate: task.startDate,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        timeEstimateMs: task.timeEstimateMs,
        timeSpentMs: task.timeSpentMs,
      },
      linkedPR: linked ?? null,
      branchTypes: vscode.workspace
        .getConfiguration("hareer.clickup")
        .get<string[]>("branchTypes", ["feature", "bugfix", "hotfix", "chore", "docs", "refactor"]),
      baseBranches: vscode.workspace
        .getConfiguration("hareer.git")
        .get<string[]>("baseBranches", ["develop", "staging", "main"]),
      defaultBaseBranch: vscode.workspace
        .getConfiguration("hareer.git")
        .get<string>("defaultBaseBranch", "develop"),
      dirty: getCurrentDirtyStatus(),
      repos: this.state.repos.map((r) => ({
        name: r.name,
        path: r.path,
        isSubmodule: r.isSubmodule,
        owner: r.owner,
        repo: r.repo,
      })),
      branchMatches: this.state.branchMatches.map((b) => ({
        repoName: b.repoName,
        repoPath: b.repoPath,
        branch: b.branch,
      })),
      prMatches: this.state.prMatches.map((p) => ({
        repoName: p.repoName,
        owner: p.owner,
        repo: p.repo,
        prNumber: p.prNumber,
        headRef: p.headRef,
        baseRef: p.baseRef,
        title: p.title,
        url: p.url,
        state: p.state,
        merged: p.merged,
        mergeable: p.mergeable,
        headBranchExists: p.headBranchExists,
        deletable: p.deletable,
      })),
      cursorCommitGenerate: isCursorIDE(),
    });
  }

  private render(): string {
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https: data:; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Hareer Task</title>
  <style>${WEBVIEW_CSS}</style>
</head>
<body>
  <div id="root">${SKELETON_HTML}</div>
  <script nonce="${nonce}">
    const inferCommitType = ${JSON.stringify(commitTypeMap())};
    ${WEBVIEW_JS}
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    TaskDetailPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getCurrentDirtyStatus(): { staged: number; unstaged: number; branch: string } | null {
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    if (!ext?.isActive) return null;
    const api = (ext.exports as { getAPI(v: 1): { repositories: Repository[] } }).getAPI(1);
    if (api.repositories.length === 0) return null;
    return getDirtyStatus(api.repositories[0]);
  } catch {
    return null;
  }
}

function commitTypeMap(): Record<string, string> {
  return {
    feature: "feat",
    bugfix: "fix",
    hotfix: "fix",
    chore: "chore",
    docs: "docs",
    refactor: "refactor",
    test: "test",
    style: "style",
    perf: "perf",
  };
}

const WEBVIEW_COMMIT_TYPES = new Set([
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "style",
  "perf",
]);

function formCommitTypeForWebview(type: CommitType): CommitType {
  return WEBVIEW_COMMIT_TYPES.has(type) ? type : "chore";
}

function sanitizeColor(raw: string | undefined): string {
  if (!raw) return "#888";
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(trimmed)) return trimmed;
  return "#888";
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function ghIsAvailable(): Promise<boolean> {
  try {
    await runCommand("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function ghPRCreate(
  cwd: string,
  baseRef: string,
  branch: string,
): Promise<string> {
  // Mirror `scripts/new-pr.ts`: --title is the branch name; body is left to
  // the user / repo template. `gh` prints the new PR URL on stdout.
  const out = await runCommand(
    "gh",
    ["pr", "create", "--base", baseRef, "--head", branch, "--title", branch, "--body", ""],
    cwd,
  );
  const url = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^https:\/\/github\.com\//.test(l));
  if (!url) throw new Error(`gh pr create returned no URL: ${out}`);
  return url;
}

/** Rename an existing PR (identified by URL or number) via `gh pr edit`. */
async function ghPREdit(cwd: string, prRef: string, title: string): Promise<void> {
  await runCommand("gh", ["pr", "edit", prRef, "--title", title], cwd);
}

async function fetchPRHeadRef(owner: string, repo: string, number: number): Promise<string> {
  const session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: {
      Authorization: `token ${session.accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "hareer-devtools-vscode",
    },
  });
  if (!res.ok) throw new Error(`GitHub PR fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { head: { ref: string } };
  return body.head.ref;
}

// ============================================================================
// Inlined webview assets
// ============================================================================

const SKELETON_HTML = `
<div class="skeleton-layout">
  <div class="sk-line sk-line-lg" style="width:60%"></div>
  <div class="sk-line" style="width:40%;margin-top:8px"></div>
  <div class="sk-card" style="margin-top:24px;height:120px"></div>
  <div class="sk-card" style="margin-top:16px;height:90px"></div>
  <div class="sk-card" style="margin-top:16px;height:140px"></div>
</div>
`;

const WEBVIEW_CSS = `
:root {
  color-scheme: light dark;
  --hareer-success: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #2da44e));
  --hareer-danger: var(--vscode-errorForeground, var(--vscode-testing-iconFailed, #cf222e));
  --hareer-warning: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #d29922));
  --hareer-info: var(--vscode-charts-blue, #0969da);
  --hareer-muted: var(--vscode-descriptionForeground);
}
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 0;
  line-height: 1.5;
}

/* ------- Skeleton ------- */
.skeleton-layout { padding: 28px; max-width: 1400px; margin: 0 auto; }
@keyframes sk-shimmer { 0% { opacity: 0.6 } 50% { opacity: 1 } 100% { opacity: 0.6 } }
.sk-line, .sk-card { background: var(--vscode-editorWidget-background); border-radius: 4px; animation: sk-shimmer 1.4s infinite; }
.sk-line { height: 14px; }
.sk-line-lg { height: 22px; }
.sk-card { border: 1px solid var(--vscode-editorWidget-border); }

/* ------- Error banner ------- */
.error-banner {
  margin: 16px 28px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--hareer-danger) 12%, transparent);
  color: var(--hareer-danger);
  border: 1px solid color-mix(in srgb, var(--hareer-danger) 40%, transparent);
  border-radius: 6px;
  display: flex; align-items: center; gap: 12px;
}
.error-banner button { margin-left: auto; }

/* ------- Warning banner ------- */
.warning-banner {
  margin: 12px 0 4px;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--hareer-warning) 12%, transparent);
  color: var(--hareer-warning);
  border: 1px solid color-mix(in srgb, var(--hareer-warning) 40%, transparent);
  border-radius: 6px;
  display: flex; align-items: center; gap: 8px;
  font-size: 0.85rem;
}

/* ------- Layout ------- */
.task-layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 28px;
  padding: 24px 28px;
  max-width: 1400px;
  margin: 0 auto;
}
@media (max-width: 900px) { .task-layout { grid-template-columns: 1fr; } }
.main { min-width: 0; }
.sidebar { font-size: 0.85rem; }

/* ------- Header ------- */
.header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; margin-bottom: 8px; grid-column: 1 / -1; }
.header .title { font-size: 1.45rem; font-weight: 600; line-height: 1.3; margin: 0 0 6px; word-break: break-word; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.header .number { color: var(--hareer-muted); font-weight: 400; font-size: 0.85rem; font-family: var(--vscode-editor-font-family); padding: 3px 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
.header .meta { color: var(--hareer-muted); font-size: 0.85rem; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.header .meta a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.header .meta a:hover { text-decoration: underline; }
.status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; font-size: 0.78rem; font-weight: 600; border: 1px solid; }
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.priority-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; border: 1px solid; }
.path-crumbs { display: inline-flex; gap: 6px; align-items: center; font-size: 0.8rem; color: var(--hareer-muted); }
.path-crumbs span { display: inline-flex; gap: 6px; align-items: center; }
.path-crumbs span:not(:first-child)::before { content: "›"; opacity: 0.6; margin-right: 2px; }

/* ------- Section headings ------- */
h2 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--hareer-muted); margin: 28px 0 10px; font-weight: 600; }
h2:first-child { margin-top: 0; }

/* ------- Card ------- */
.card {
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 6px;
  padding: 14px 16px;
}
.card + .card { margin-top: 12px; }

/* ------- Sidebar ------- */
.sidebar .group { padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.sidebar .group:last-child { border-bottom: none; }
.sidebar .group-title { font-weight: 600; color: var(--vscode-foreground); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; }
.sidebar .empty { color: var(--hareer-muted); font-style: italic; }
.sidebar .user-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.sidebar .user-row img { width: 20px; height: 20px; border-radius: 50%; }
.sidebar .avatar-placeholder { width: 20px; height: 20px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); display: inline-flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 600; }
.sidebar .due-date { font-size: 0.85rem; }
.sidebar .due-date.overdue { color: var(--hareer-danger); font-weight: 600; }
.sidebar .due-date.soon { color: var(--hareer-warning); font-weight: 600; }
.tag-list { display: flex; gap: 6px; flex-wrap: wrap; }
.tag-chip { padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 500; border: 1px solid; }

/* ------- Task action buttons (under description) ------- */
.task-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.action-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 12px; border-radius: 12px; font-size: 0.78rem; font-weight: 600;
  border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  font-family: inherit;
}
.action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.action-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.action-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.action-btn .count { background: rgba(255,255,255,0.15); padding: 0 5px; border-radius: 8px; font-size: 0.7rem; }
.action-btn.primary .count { background: rgba(255,255,255,0.25); }
.action-btn.danger { background: color-mix(in srgb, var(--hareer-danger) 15%, transparent); color: var(--hareer-danger); border-color: color-mix(in srgb, var(--hareer-danger) 40%, transparent); }
.action-btn.danger:hover { background: color-mix(in srgb, var(--hareer-danger) 25%, transparent); }
.status-badge { cursor: pointer; }
.status-badge:hover { opacity: 0.8; }
.collapsible-section { margin-top: 8px; }

/* ------- Description with fade + expand ------- */
.description-empty { color: var(--hareer-muted); font-style: italic; }
.description-wrap { position: relative; }
.description-clip { max-height: 22em; overflow: hidden; transition: max-height 0.18s ease; }
.description-clip.expanded { max-height: 4000px; }
.description-fade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 4em;
  background: linear-gradient(to bottom, transparent, var(--vscode-editorWidget-background) 92%);
  pointer-events: none;
  display: none;
}
.description-clip.overflow:not(.expanded) ~ .description-fade { display: block; }
.description-toggle {
  display: none;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  width: 100%;
  padding: 6px 12px;
  font-size: 0.78rem;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  font-family: inherit;
  text-align: center;
}
.description-toggle:hover { background: var(--vscode-list-hoverBackground); }
.description-wrap.has-overflow .description-toggle { display: block; }

/* ------- Repo pills (multi-select for branch creation) ------- */
.repo-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.repo-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 12px; font-size: 0.78rem;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: 1px solid transparent; cursor: pointer; font-family: inherit;
}
.repo-pill:hover { background: var(--vscode-button-secondaryHoverBackground); }
.repo-pill.selected { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.repo-pill .check { display: inline-block; width: 12px; text-align: center; opacity: 0.85; }
.repo-pills-actions { display: flex; gap: 8px; margin-top: 6px; }
.link-btn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.78rem; padding: 0; font-family: inherit; }
.link-btn:hover { text-decoration: underline; }
.md p { margin: 0 0 10px; }
.md p:last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4 { margin: 14px 0 8px; line-height: 1.3; font-weight: 600; }
.md h1 { font-size: 1.3rem; }
.md h2 { font-size: 1.1rem; text-transform: none; letter-spacing: 0; color: var(--vscode-foreground); padding: 0; margin: 14px 0 8px; }
.md h3 { font-size: 1.0rem; }
.md h4 { font-size: 0.9rem; }
.md ul, .md ol { padding-left: 22px; margin: 6px 0 10px; }
.md li { margin: 3px 0; }
.md li.task { list-style: none; margin-left: -16px; }
.md li.task input[type=checkbox] { margin-right: 6px; pointer-events: none; }
.md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.md a:hover { text-decoration: underline; }
.md blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); color: var(--hareer-muted); }
.md code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.88em; }
.md pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; overflow: auto; margin: 8px 0; }
.md pre code { background: transparent; padding: 0; font-size: 0.85em; }
.md hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 14px 0; }

/* ------- PR section ------- */
.pr-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 14px 16px; }
.pr-linked-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.pr-linked-head .pr-num { font-weight: 600; font-size: 1rem; }
.linked-pill { padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; background: color-mix(in srgb, var(--hareer-success) 14%, transparent); color: var(--hareer-success); border: 1px solid color-mix(in srgb, var(--hareer-success) 40%, transparent); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.row:last-child { margin-bottom: 0; }
.row label { font-size: 0.78rem; color: var(--hareer-muted); min-width: 70px; }
.chip { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; padding: 4px 10px; border-radius: 12px; font-size: 0.78rem; cursor: pointer; font-family: inherit; }
.chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
.chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.preview { font-family: var(--vscode-editor-font-family); font-size: 0.78rem; color: var(--hareer-muted); background: var(--vscode-textCodeBlock-background); padding: 6px 10px; border-radius: 3px; margin-top: 6px; word-break: break-all; white-space: pre-wrap; }

/* ------- Commit section ------- */
.commit-grid { display: grid; grid-template-columns: 80px 1fr; gap: 8px 12px; align-items: center; }
.commit-grid label { font-size: 0.78rem; color: var(--hareer-muted); }
.commit-grid .chips { display: flex; gap: 4px; flex-wrap: wrap; }
.subject-row { display: flex; gap: 8px; align-items: center; }
.subject-row input { flex: 1; min-width: 0; }
.subject-row button { flex-shrink: 0; white-space: nowrap; }
input[type=text], textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 8px; font-family: inherit; font-size: 0.85rem; border-radius: 3px; width: 100%; box-sizing: border-box; }
input[type=text]:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
textarea { resize: vertical; min-height: 60px; }
.commit-hint { font-size: 0.72rem; color: var(--hareer-muted); margin-top: 6px; }
.commit-hint kbd { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
.checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; color: var(--hareer-muted); }
.action-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.action-row .spacer { flex: 1; }

/* ------- Buttons ------- */
button { font-family: inherit; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 3px; font-size: 0.85rem; cursor: pointer; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 14px; border-radius: 3px; font-size: 0.85rem; cursor: pointer; }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.icon-only { padding: 4px 8px; font-size: 0.78rem; }

.muted { color: var(--hareer-muted); font-size: 0.85rem; }
.dirty-status { font-size: 0.78rem; color: var(--hareer-muted); margin-top: 8px; display: flex; gap: 12px; flex-wrap: wrap; }
.dirty-status .clean { color: var(--hareer-success); }

/* ------- Flash ------- */
.flash { position: fixed; bottom: 16px; right: 16px; background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); border: 1px solid var(--vscode-notifications-border); padding: 8px 14px; border-radius: 4px; font-size: 0.85rem; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 100; }
.flash.show { opacity: 1; }
`;

const WEBVIEW_JS = `
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
let model = null;
let savedState = vscode.getState() || { commitSubject: "", commitBody: "", commitType: "feat", branchType: null, baseRef: null, stageAll: true, selectedRepoPaths: null, descriptionExpanded: false, showCommitSection: false, showBranchSection: false };

function escape(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
}

function fmtDate(s) {
  if (!s) return "";
  // ClickUp dates are millisecond strings
  const d = isNaN(Number(s)) ? new Date(s) : new Date(Number(s));
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (Math.abs(sec) < 60) return "just now";
  const abs = Math.abs(sec);
  const future = sec < 0;
  const min = Math.round(abs / 60);
  if (min < 60) return future ? "in " + min + "m" : min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 24) return future ? "in " + hr + "h" : hr + "h ago";
  const day = Math.round(hr / 24);
  if (day < 30) return future ? "in " + day + "d" : day + "d ago";
  return d.toLocaleDateString();
}

function fmtAbsDate(s) {
  if (!s) return "";
  const d = isNaN(Number(s)) ? new Date(s) : new Date(Number(s));
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return "";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

function dueClass(due) {
  if (!due) return "";
  const dueMs = isNaN(Number(due)) ? new Date(due).getTime() : Number(due);
  const diff = dueMs - Date.now();
  if (diff < 0) return "overdue";
  if (diff < 86400000 * 2) return "soon"; // within 2 days
  return "";
}

function flash(text) {
  const el = document.createElement("div");
  el.className = "flash show";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, 2200);
}

function saveDraft() { vscode.setState(savedState); }

// ---------------------------------------------------------------------------
// Markdown renderer (CommonMark-lite + GitHub task lists + auto-links + mentions)
// ---------------------------------------------------------------------------
function renderMarkdown(text) {
  if (!text) return "";
  const fences = [];
  let src = String(text).replace(/\`\`\`([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)\\n\`\`\`/g, (_, lang, code) => {
    fences.push({ lang, code });
    return "\\u0000FENCE" + (fences.length - 1) + "\\u0000";
  });
  src = escape(src);
  src = src.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  const blocks = src.split(/\\n{2,}/);
  const html = blocks.map(renderBlock).join("\\n");
  const restored = html.replace(/\\u0000FENCE(\\d+)\\u0000/g, (_, i) => {
    const f = fences[Number(i)];
    return '<pre><code>' + escape(f.code) + '</code></pre>';
  });
  return '<div class="md">' + restored + '</div>';
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return "";
  const h = trimmed.match(/^(#{1,4})\\s+(.+)$/);
  if (h) return '<h' + h[1].length + '>' + applyInline(h[2]) + '</h' + h[1].length + '>';
  if (/^(-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) return '<hr />';
  if (trimmed.split('\\n').every((l) => l.startsWith('&gt;') || l.startsWith('>'))) {
    const inner = trimmed.split('\\n').map((l) => l.replace(/^&gt;\\s?|^>\\s?/, '')).join('\\n');
    return '<blockquote>' + renderBlock(inner) + '</blockquote>';
  }
  const lines = trimmed.split('\\n');
  const isUL = lines.every((l) => /^\\s*[-*+]\\s+/.test(l));
  const isOL = lines.every((l) => /^\\s*\\d+\\.\\s+/.test(l));
  if (isUL || isOL) {
    const tag = isOL ? 'ol' : 'ul';
    const items = lines.map((l) => {
      const m = isOL ? l.match(/^\\s*\\d+\\.\\s+(.*)$/) : l.match(/^\\s*[-*+]\\s+(.*)$/);
      let content = m ? m[1] : l;
      const task = content.match(/^\\[( |x|X)\\]\\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
        return '<li class="task"><input type="checkbox" disabled' + checked + ' />' + applyInline(task[2]) + '</li>';
      }
      return '<li>' + applyInline(content) + '</li>';
    }).join('');
    return '<' + tag + '>' + items + '</' + tag + '>';
  }
  return '<p>' + applyInline(trimmed).replace(/\\n/g, '<br/>') + '</p>';
}

function applyInline(s) {
  let out = s;
  out = out.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" data-external="1">$1</a>');
  out = out.replace(/(^|[\\s(])((?:https?:\\/\\/)[^\\s)]+)/g, '$1<a href="$2" data-external="1">$2</a>');
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
  return out;
}

function slugify(s, max) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.length <= max) return base;
  const truncated = base.slice(0, max);
  const last = truncated.lastIndexOf("-");
  return last >= Math.floor(max * 0.6) ? truncated.slice(0, last) : truncated.replace(/-+$/, "");
}

function branchPreview(type) {
  if (!model || !type) return "";
  return type + "/" + model.task.customId + "-" + slugify(model.task.name, 50);
}

function deriveScopeFromBranch(branch) {
  if (!branch) return "";
  const name = String(branch).trim();
  if (["develop","staging","main","master"].includes(name.toLowerCase())) return "";
  const m = name.match(/^(?:feature|bugfix|hotfix|chore|refactor|docs|test|style|perf|release|build|ci)\\/([^/-]+)(?:-|$)/i);
  return m ? m[1] : "";
}

function commitPreview() {
  const t = savedState.commitType;
  const branch = (model && model.dirty && model.dirty.branch) || "";
  const scope = deriveScopeFromBranch(branch);
  const subject = (savedState.commitSubject || "").trim() || "<subject>";
  return scope ? t + "(" + scope + "): " + subject : t + ": " + subject;
}

function userInitial(name) {
  return (name || "?").charAt(0).toUpperCase();
}

function userRow(u) {
  const avatar = u.avatar ? '<img src="' + escape(u.avatar) + '" alt="" />' : '<span class="avatar-placeholder">' + userInitial(u.username) + '</span>';
  return '<div class="user-row">' + avatar + '<span>' + escape(u.username) + '</span></div>';
}

function render() {
  if (!model) return;
  const t = model.task;
  const linked = model.linkedPR;
  const branchTypes = model.branchTypes;
  if (!savedState.branchType) savedState.branchType = branchTypes[0];
  const baseBranches = model.baseBranches || ["develop", "staging", "main"];
  if (!savedState.baseRef || !baseBranches.includes(savedState.baseRef)) {
    savedState.baseRef = model.defaultBaseBranch || baseBranches[0] || "develop";
  }

  const statusBg = 'color-mix(in srgb, ' + t.status.color + ' 14%, transparent)';
  const statusBorder = 'color-mix(in srgb, ' + t.status.color + ' 50%, transparent)';
  const statusBadge = '<span class="status-badge" id="status-badge" title="Click to change status" style="color:' + t.status.color + ';background:' + statusBg + ';border-color:' + statusBorder + '"><span class="status-dot" style="background:' + t.status.color + '"></span>' + escape(t.status.status) + '</span>';

  const priorityBadge = t.priority
    ? '<span class="priority-pill" style="color:' + t.priority.color + ';border-color:color-mix(in srgb, ' + t.priority.color + ' 50%, transparent);background:color-mix(in srgb, ' + t.priority.color + ' 12%, transparent)">⚑ ' + escape(t.priority.priority) + '</span>'
    : '';

  const crumbs = '<span>📂 ' + escape(t.space.name || 'Space') + '</span>' +
    (t.folder ? '<span>📁 ' + escape(t.folder.name) + '</span>' : '') +
    '<span>📋 ' + escape(t.list.name) + '</span>';

  const dueClassName = dueClass(t.dueDate);
  const dueLabel = t.dueDate
    ? '<span class="due-date ' + dueClassName + '">' + escape(fmtAbsDate(t.dueDate)) + ' · ' + escape(fmtDate(t.dueDate)) + '</span>'
    : '<span class="empty">No due date</span>';

  const tags = (t.tags || []).length > 0
    ? '<div class="tag-list">' + t.tags.map((tg) => '<span class="tag-chip" style="color:' + tg.fg + ';border-color:' + tg.bg + ';background:color-mix(in srgb, ' + tg.bg + ' 18%, transparent)">' + escape(tg.name) + '</span>').join('') + '</div>'
    : '<div class="empty">No tags</div>';

  const assignees = (t.assignees || []).length > 0
    ? t.assignees.map(userRow).join('')
    : '<div class="empty">Unassigned</div>';

  const timeRow = (t.timeEstimateMs || t.timeSpentMs)
    ? '<div>' + (t.timeSpentMs ? 'Spent: <strong>' + fmtDuration(t.timeSpentMs) + '</strong>' : '') +
      (t.timeSpentMs && t.timeEstimateMs ? ' · ' : '') +
      (t.timeEstimateMs ? 'Estimate: ' + fmtDuration(t.timeEstimateMs) : '') + '</div>'
    : '<div class="empty">Not tracked</div>';

  // Context-driven action buttons (under description)
  const branchCount = (model.branchMatches || []).length;
  const allPRs = model.prMatches || [];
  const openPRs = allPRs.filter((p) => p.state === 'open' && !p.merged);
  const mergedPRs = allPRs.filter((p) => p.merged);
  const conflictedPRs = openPRs.filter((p) => p.mergeable === false);
  const openPRCount = openPRs.length;
  const allMerged = allPRs.length > 0 && openPRCount === 0 && mergedPRs.length > 0;
  const deletableBranches = allPRs.filter((p) => p.deletable);
  if (branchCount > 0) savedState.showBranchSection = false;

  const conflictBannerHtml = conflictedPRs.length > 0
    ? '<div class="warning-banner">⚠ ' + conflictedPRs.length + ' PR' + (conflictedPRs.length === 1 ? '' : 's') + ' have merge conflicts: ' + conflictedPRs.map((p) => escape(p.headRef)).join(', ') + '</div>'
    : '';

  const actionBtns = [];
  if (branchCount > 0) {
    actionBtns.push(
      '<button class="action-btn primary" id="action-checkout" title="Checkout matching branch in ' + branchCount + ' repo' + (branchCount === 1 ? '' : 's') + '">' +
        '⤓ Checkout' + (branchCount > 1 ? ' <span class="count">' + branchCount + '</span>' : '') +
      '</button>',
    );
  } else {
    actionBtns.push('<button class="action-btn primary" id="action-create-branch">＋ Create Branch</button>');
  }
  if (branchCount > 0 && openPRCount === 0 && !linked && !allMerged) {
    actionBtns.push('<button class="action-btn" id="action-create-pr">Create PR</button>');
  }
  if (openPRCount > 0) {
    actionBtns.push(
      '<button class="action-btn primary" id="action-review" title="Open code review for ' + openPRCount + ' matching PR' + (openPRCount === 1 ? '' : 's') + '">' +
        '👁 Code Review <span class="count">' + openPRCount + '</span>' +
      '</button>',
    );
    actionBtns.push(
      '<button class="action-btn" id="action-merge-prs" title="Merge ' + openPRCount + ' PR' + (openPRCount === 1 ? '' : 's') + ' and mark ready to deploy">' +
        '⤭ Merge' + (openPRCount > 1 ? ' <span class="count">' + openPRCount + '</span>' : '') +
      '</button>',
    );
  }
  if (allMerged && deletableBranches.length > 0) {
    actionBtns.push(
      '<button class="action-btn danger" id="action-delete-branches" title="Delete ' + deletableBranches.length + ' merged branch' + (deletableBranches.length === 1 ? '' : 'es') + '">' +
        '🗑 Delete branches' + (deletableBranches.length > 1 ? ' <span class="count">' + deletableBranches.length + '</span>' : '') +
      '</button>',
    );
  }
  actionBtns.push('<button class="action-btn" id="action-commit">Commit</button>');
  actionBtns.push(
    '<button class="action-btn" id="action-link-pr" title="' + (linked ? 'Replace the linked PR URL on this ClickUp task' : 'Paste an existing PR URL to link it to this ClickUp task') + '">' +
      (linked ? '🔗 Replace link' : '🔗 Link existing PR') +
    '</button>',
  );
  const actionsHtml = conflictBannerHtml + '<div class="task-actions">' + actionBtns.join('') + '</div>';

  // Determine which repos are selected for branch creation. Default: all submodules
  // (or the single workspace repo if no .gitmodules).
  const allRepos = model.repos || [];
  const submoduleRepos = allRepos.filter((r) => r.isSubmodule);
  const repoPool = submoduleRepos.length > 0 ? submoduleRepos : allRepos;
  if (savedState.selectedRepoPaths === null) {
    savedState.selectedRepoPaths = repoPool.map((r) => r.path);
  } else {
    const valid = new Set(repoPool.map((r) => r.path));
    savedState.selectedRepoPaths = (savedState.selectedRepoPaths || []).filter((p) => valid.has(p));
  }
  const isSelected = (p) => (savedState.selectedRepoPaths || []).includes(p);

  const repoPillsHtml = submoduleRepos.length > 0
    ? '<div class="row" style="flex-direction:column;align-items:flex-start;gap:6px">' +
        '<label style="margin:0">Repos</label>' +
        '<div class="repo-pills">' +
          submoduleRepos.map((r) => '<button class="repo-pill ' + (isSelected(r.path) ? "selected" : "") + '" data-repo="' + escape(r.path) + '"><span class="check">' + (isSelected(r.path) ? "✓" : "○") + '</span>' + escape(r.name) + '</button>').join('') +
        '</div>' +
        '<div class="repo-pills-actions">' +
          '<button class="link-btn" id="repo-all">Select all</button>' +
          '<button class="link-btn" id="repo-none">Clear</button>' +
        '</div>' +
      '</div>'
    : '';

  // Description with optional fade + expand toggle
  const hasDesc = t.description && t.description.trim();
  const descBody = hasDesc
    ? '<div class="description-wrap" id="desc-wrap">' +
        '<div class="card description-clip' + (savedState.descriptionExpanded ? ' expanded' : '') + '" id="desc-clip">' +
          renderMarkdown(t.description) +
        '</div>' +
        '<div class="description-fade"></div>' +
        '<button class="description-toggle" id="desc-toggle">' + (savedState.descriptionExpanded ? '▲ Show less' : '▼ Show more') + '</button>' +
      '</div>'
    : '<div class="card description-empty">No description provided.</div>';

  const branchSectionHtml = savedState.showBranchSection && branchCount === 0
    ? '<div class="collapsible-section">' +
        '<h2>Create Branch</h2>' +
        '<div class="pr-card">' +
          '<div class="row">' +
            '<label>Type</label>' +
            '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
              branchTypes.map((bt) => '<button class="chip ' + (savedState.branchType === bt ? "active" : "") + '" data-bt="' + escape(bt) + '">' + escape(bt) + '</button>').join('') +
            '</div>' +
          '</div>' +
          '<div class="row">' +
            '<label>Base</label>' +
            '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
              baseBranches.map((b) => '<button class="chip ' + (savedState.baseRef === b ? "active" : "") + '" data-base="' + escape(b) + '">' + escape(b) + '</button>').join('') +
            '</div>' +
          '</div>' +
          repoPillsHtml +
          '<div class="preview" id="branch-preview"></div>' +
          '<div class="row" style="margin-top:10px"><button class="primary" id="create-branch-btn">Create branch & checkout</button></div>' +
        '</div>' +
      '</div>'
    : '';

  const commitSectionHtml = savedState.showCommitSection
    ? '<div class="collapsible-section">' +
        '<h2>Commit</h2>' +
        '<div class="card">' +
          '<div class="commit-grid">' +
            '<label>Type</label>' +
            '<div class="chips">' +
              ["feat","fix","chore","docs","refactor","test","style","perf"].map((ct) =>
                '<button class="chip ' + (savedState.commitType === ct ? "active" : "") + '" data-ct="' + ct + '">' + ct + '</button>'
              ).join('') +
            '</div>' +
            '<label>Subject</label>' +
            '<div class="subject-row">' +
              '<input type="text" id="subject-input" value="' + escape(savedState.commitSubject || "") + '" placeholder="short imperative summary" />' +
              (model.cursorCommitGenerate
                ? '<button class="secondary" id="generate-commit-btn" title="Generate from staged changes using Cursor AI">✨ Generate</button>'
                : '') +
            '</div>' +
            '<label>Body</label>' +
            '<textarea id="body-input" placeholder="optional details">' + escape(savedState.commitBody || "") + '</textarea>' +
          '</div>' +
          '<div class="preview" id="commit-preview"></div>' +
          '<div class="commit-hint">Tip: <kbd>⌘ Enter</kbd> (or <kbd>Ctrl Enter</kbd>) commits.' +
            (model.cursorCommitGenerate ? ' ✨ Generate uses Cursor AI on staged changes (respects “Stage all”).' : '') +
          '</div>' +
          '<div class="action-row">' +
            '<label class="checkbox-row"><input type="checkbox" id="stage-all"' + (savedState.stageAll ? " checked" : "") + ' />Stage all changes</label>' +
            '<span class="spacer"></span>' +
            '<button class="secondary" id="commit-btn" title="Commit without pushing">Commit</button>' +
            '<button class="secondary" id="commit-push-btn" title="Commit and push, no PR">Commit & Push</button>' +
            '<button class="primary" id="commit-push-pr-btn" title="Commit, push, and open pull requests">Commit, Push & PR</button>' +
            '<button class="secondary" id="push-btn" title="Push existing commits">Push only</button>' +
          '</div>' +
          (model.dirty ? '<div class="dirty-status">' +
            '<span>Branch: <strong>' + escape(model.dirty.branch) + '</strong></span>' +
            '<span>' + model.dirty.staged + ' staged · ' + model.dirty.unstaged + ' unstaged' + (model.dirty.staged + model.dirty.unstaged === 0 ? ' <span class="clean">✓ clean</span>' : '') + '</span>' +
          '</div>' : '') +
        '</div>' +
      '</div>'
    : '';

  root.innerHTML =
    '<div class="task-layout">' +
      '<div class="header">' +
        '<div class="title">' + escape(t.name) + ' <span class="number">CU ' + escape(t.customId) + '</span> ' + statusBadge + ' ' + priorityBadge + '</div>' +
        '<div class="meta">' +
          '<span class="path-crumbs">' + crumbs + '</span>' +
          (t.creator ? '<span>· created by ' + escape(t.creator) + '</span>' : '') +
          (t.createdAt ? '<span>· ' + escape(fmtDate(t.createdAt)) + '</span>' : '') +
          (t.updatedAt ? '<span>· updated ' + escape(fmtDate(t.updatedAt)) + '</span>' : '') +
          '<span>· <a href="' + escape(t.url) + '" data-external="1">Open in ClickUp ↗</a></span>' +
          '<button class="secondary icon-only" id="refresh-btn" title="Refresh">⟳</button>' +
        '</div>' +
      '</div>' +

      '<div class="main">' +
        '<h2>Description</h2>' +
        descBody +
        actionsHtml +
        branchSectionHtml +
        commitSectionHtml +
      '</div>' +

      '<div class="sidebar">' +
        '<div class="group">' +
          '<div class="group-title">Assignees</div>' +
          assignees +
        '</div>' +
        '<div class="group">' +
          '<div class="group-title">Due Date</div>' +
          dueLabel +
          (t.startDate ? '<div class="muted" style="margin-top:4px">Started ' + escape(fmtAbsDate(t.startDate)) + '</div>' : '') +
        '</div>' +
        '<div class="group">' +
          '<div class="group-title">Tags</div>' +
          tags +
        '</div>' +
        '<div class="group">' +
          '<div class="group-title">Time</div>' +
          timeRow +
        '</div>' +
        '<div class="group">' +
          '<div class="group-title">Location</div>' +
          '<div>' + escape(t.space.name || 'Space') + '</div>' +
          (t.folder ? '<div>' + escape(t.folder.name) + '</div>' : '') +
          '<div class="muted">' + escape(t.list.name) + '</div>' +
        '</div>' +
        ((t.watchers || []).length > 0 ? '<div class="group"><div class="group-title">Watchers</div>' + t.watchers.map((w) => '<div class="user-row"><span class="avatar-placeholder">' + userInitial(w) + '</span><span>' + escape(w) + '</span></div>').join('') + '</div>' : '') +
      '</div>' +
    '</div>';

  updatePreviews();
  bindEvents();
}

function updatePreviews() {
  const bp = document.getElementById("branch-preview");
  if (bp) bp.textContent = branchPreview(savedState.branchType);
  const cp = document.getElementById("commit-preview");
  if (cp) cp.textContent = commitPreview();
}

function bindEvents() {
  document.querySelectorAll("[data-external]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      vscode.postMessage({ type: "openExternal", url: a.getAttribute("href") });
    });
  });
  document.querySelectorAll("[data-bt]").forEach((el) => {
    el.addEventListener("click", () => {
      savedState.branchType = el.getAttribute("data-bt");
      // Sync commit type to inferred type once user picks a branch type
      const inferred = inferCommitType[savedState.branchType];
      if (inferred) savedState.commitType = inferred;
      saveDraft();
      render();
    });
  });
  document.querySelectorAll("[data-base]").forEach((el) => {
    el.addEventListener("click", () => {
      savedState.baseRef = el.getAttribute("data-base");
      saveDraft();
      render();
    });
  });
  document.querySelectorAll("[data-ct]").forEach((el) => {
    el.addEventListener("click", () => {
      savedState.commitType = el.getAttribute("data-ct");
      saveDraft();
      render();
    });
  });

  const subj = document.getElementById("subject-input");
  if (subj) {
    subj.addEventListener("input", (e) => { savedState.commitSubject = e.target.value; saveDraft(); updatePreviews(); });
    subj.addEventListener("keydown", commitKeydown);
  }
  const body = document.getElementById("body-input");
  if (body) {
    body.addEventListener("input", (e) => { savedState.commitBody = e.target.value; saveDraft(); });
    body.addEventListener("keydown", commitKeydown);
  }
  const stage = document.getElementById("stage-all");
  if (stage) stage.addEventListener("change", (e) => { savedState.stageAll = e.target.checked; saveDraft(); });

  const refresh = document.getElementById("refresh-btn");
  if (refresh) refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));

  const createBranch = document.getElementById("create-branch-btn");
  if (createBranch) createBranch.addEventListener("click", () => {
    vscode.postMessage({
      type: "createBranch",
      branchType: savedState.branchType,
      repoPaths: savedState.selectedRepoPaths || [],
      baseRef: savedState.baseRef || "develop",
    });
  });
  const actionCheckout = document.getElementById("action-checkout");
  if (actionCheckout) actionCheckout.addEventListener("click", () => vscode.postMessage({ type: "checkoutTaskBranches" }));
  const actionCreateBranch = document.getElementById("action-create-branch");
  if (actionCreateBranch) actionCreateBranch.addEventListener("click", () => {
    savedState.showBranchSection = true;
    saveDraft();
    render();
  });
  const actionCreatePR = document.getElementById("action-create-pr");
  if (actionCreatePR) actionCreatePR.addEventListener("click", () => {
    vscode.postMessage({
      type: "createPRs",
      baseRef: savedState.baseRef || (model && model.defaultBaseBranch) || "develop",
    });
  });
  const actionReview = document.getElementById("action-review");
  if (actionReview) actionReview.addEventListener("click", () => vscode.postMessage({ type: "openTaskReview" }));
  const actionMergePRs = document.getElementById("action-merge-prs");
  if (actionMergePRs) actionMergePRs.addEventListener("click", () => vscode.postMessage({ type: "mergeTaskPRs" }));
  const actionDeleteBranches = document.getElementById("action-delete-branches");
  if (actionDeleteBranches) actionDeleteBranches.addEventListener("click", () => vscode.postMessage({ type: "deleteTaskBranches" }));
  const statusBadgeEl = document.getElementById("status-badge");
  if (statusBadgeEl) statusBadgeEl.addEventListener("click", () => vscode.postMessage({ type: "changeStatus" }));
  const actionCommit = document.getElementById("action-commit");
  if (actionCommit) actionCommit.addEventListener("click", () => {
    savedState.showCommitSection = true;
    saveDraft();
    render();
  });
  const actionLinkPR = document.getElementById("action-link-pr");
  if (actionLinkPR) actionLinkPR.addEventListener("click", () => {
    // prompt() is disabled in VS Code webviews — let the host show a native input box.
    vscode.postMessage({ type: "promptLinkPR" });
  });

  // Repo multi-select pills
  document.querySelectorAll("[data-repo]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = el.getAttribute("data-repo");
      const sel = new Set(savedState.selectedRepoPaths || []);
      if (sel.has(p)) sel.delete(p); else sel.add(p);
      savedState.selectedRepoPaths = Array.from(sel);
      saveDraft();
      render();
    });
  });
  const repoAll = document.getElementById("repo-all");
  if (repoAll) repoAll.addEventListener("click", () => {
    const pool = (model.repos || []).filter((r) => r.isSubmodule);
    savedState.selectedRepoPaths = pool.map((r) => r.path);
    saveDraft();
    render();
  });
  const repoNone = document.getElementById("repo-none");
  if (repoNone) repoNone.addEventListener("click", () => {
    savedState.selectedRepoPaths = [];
    saveDraft();
    render();
  });

  // Description expand/collapse
  const descClip = document.getElementById("desc-clip");
  const descWrap = document.getElementById("desc-wrap");
  const descToggle = document.getElementById("desc-toggle");
  if (descClip && descWrap) {
    // Detect overflow on next frame so layout is settled.
    requestAnimationFrame(() => {
      if (descClip.scrollHeight > descClip.clientHeight + 2) {
        descWrap.classList.add("has-overflow");
        descClip.classList.add("overflow");
      }
    });
  }
  if (descToggle) descToggle.addEventListener("click", () => {
    savedState.descriptionExpanded = !savedState.descriptionExpanded;
    saveDraft();
    if (descClip) descClip.classList.toggle("expanded");
    descToggle.textContent = savedState.descriptionExpanded ? "▲ Show less" : "▼ Show more";
  });

  const commit = document.getElementById("commit-btn");
  if (commit) commit.addEventListener("click", () => sendCommit(false, false));
  const commitPush = document.getElementById("commit-push-btn");
  if (commitPush) commitPush.addEventListener("click", () => sendCommit(true, false));
  const commitPushPR = document.getElementById("commit-push-pr-btn");
  if (commitPushPR) commitPushPR.addEventListener("click", () => sendCommit(true, true));
  const push = document.getElementById("push-btn");
  if (push) push.addEventListener("click", () => vscode.postMessage({ type: "push" }));
  const generateCommit = document.getElementById("generate-commit-btn");
  if (generateCommit) generateCommit.addEventListener("click", () => {
    vscode.postMessage({ type: "generateCommit", stageAll: !!savedState.stageAll });
  });

}

function commitKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    sendCommit(false, false);
  }
}

function sendCommit(thenPush, thenPR) {
  if (!(savedState.commitSubject || "").trim()) { flash("Subject is required."); return; }
  vscode.postMessage({
    type: "commit",
    commitType: savedState.commitType,
    subject: savedState.commitSubject || "",
    body: savedState.commitBody || "",
    stageAll: !!savedState.stageAll,
    thenPush: thenPush,
    thenPR: thenPR,
  });
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "state") {
    model = msg;
    render();
  } else if (msg.type === "commitDraft") {
    savedState.commitType = msg.commitType || savedState.commitType;
    savedState.commitSubject = msg.subject || "";
    savedState.commitBody = msg.body || "";
    savedState.showCommitSection = true;
    saveDraft();
    render();
  } else if (msg.type === "flash") {
    flash(msg.text);
  } else if (msg.type === "error") {
    root.innerHTML = '<div class="error-banner">' +
      '<span>⚠️ Failed to load task: ' + escape(msg.message) + '</span>' +
      '<button class="primary" id="retry">Retry</button>' +
    '</div>';
    const retry = document.getElementById("retry");
    if (retry) retry.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  }
});

vscode.postMessage({ type: "ready" });
`;
