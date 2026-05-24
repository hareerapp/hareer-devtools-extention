import * as vscode from "vscode";
import {
  checkoutBranch,
  checkoutBranchInDir,
  commit as gitCommit,
  createAndCheckoutBranch,
  createAndCheckoutBranchInDir,
  findTaskBranch,
  getDirtyStatus,
  getOriginRemote,
  pickRepository,
  push as gitPush,
} from "./git-operations";
import type { Repository } from "./git-operations";
import { formatBranchName, validateGitRef } from "./branch-naming";
import { formatCommitMessage } from "./commit-naming";
import { findPRField, getLinkedPR } from "./pr-url-field";
import { getTask, setCustomFieldValue, updateTaskStatus } from "./clickup-api";
import { getClickUpToken } from "./auth";
import { getWorkspaceRepos } from "./workspace-repos";
import type { WorkspaceRepo } from "./workspace-repos";
import { fetchOpenPRs } from "../code-review/github-api";
import type { TaskService } from "./task-service";
import type { BranchType, ClickUpTask, CommitType } from "./types";

// ============================================================================
// Types
// ============================================================================

type InboundMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openExternal"; url: string }
  | { type: "createBranch"; branchType: BranchType; repoPaths: string[] }
  | { type: "checkoutLinkedPR" }
  | { type: "checkoutTaskBranches" }
  | { type: "openTaskReview" }
  | { type: "commit"; commitType: CommitType; scope: string; subject: string; body: string; stageAll: boolean; thenPush: boolean }
  | { type: "push" }
  | { type: "linkPR"; url: string };

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
  readonly title: string;
  readonly url: string;
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
    TaskDetailPanel.current = new TaskDetailPanel(context, service, panel);
    await TaskDetailPanel.current.show(taskId);
  }

  private state: PanelState | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: TaskService,
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

  async show(taskId: string): Promise<void> {
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

    // Branch discovery — parallel across repos.
    const branchResults = await Promise.all(
      repos.map(async (r) => {
        const branch = await findTaskBranch(r.absPath, taskKey);
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
            const prs = await fetchOpenPRs(r.owner, r.repo);
            return prs
              .filter((p) => p.headRef.toLowerCase().includes(taskKey.toLowerCase()))
              .map<PRMatch>((p) => ({
                repoPath: r.path,
                repoName: r.name,
                absPath: r.absPath,
                owner: r.owner,
                repo: r.repo,
                prNumber: p.number,
                headRef: p.headRef,
                title: p.title,
                url: p.url,
              }));
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
        await this.show(this.state.taskId);
        return;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "createBranch":
        await this.handleCreateBranch(msg.branchType, msg.repoPaths);
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
      case "commit":
        await this.handleCommit(msg);
        return;
      case "push":
        await this.handlePush();
        return;
      case "linkPR":
        await this.handleLinkPR(msg.url);
        return;
    }
  }

  private async handleCreateBranch(branchType: BranchType, repoPaths: string[]): Promise<void> {
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
              await createAndCheckoutBranchInDir(target.absPath, branchName);
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
          await createAndCheckoutBranch(repo, branchName);
          void vscode.window.showInformationMessage(`Hareer: Checked out ${branchName}`);
          this.postFlash(`On branch ${branchName}`);
          await this.maybeAutoTransition("in progress");
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

  private async handleCommit(
    msg: Extract<InboundMessage, { type: "commit" }>,
  ): Promise<void> {
    if (!this.state) return;
    if (msg.subject.trim().length === 0) {
      void vscode.window.showWarningMessage("Hareer: Commit subject is required.");
      return;
    }
    const repo = await pickRepository();
    if (!repo) return;

    const message = formatCommitMessage({
      type: msg.commitType,
      scope: msg.scope.trim() || undefined,
      subject: msg.subject.trim(),
      body: msg.body.trim() || undefined,
      taskId: this.state.task.customId ?? this.state.task.id,
    });

    try {
      await gitCommit(repo, message, msg.stageAll);
      void vscode.window.showInformationMessage("Hareer: Commit created.");
      this.postFlash("Committed.");
      if (msg.thenPush) {
        await this.pushAndMaybeOfferPR(repo);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Commit failed — ${errMsg}`);
    }
  }

  private async handlePush(): Promise<void> {
    const repo = await pickRepository();
    if (!repo) return;
    await this.pushAndMaybeOfferPR(repo);
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
      .get<boolean>("autoTransition", false);
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
        title: p.title,
        url: p.url,
      })),
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
let savedState = vscode.getState() || { commitSubject: "", commitScope: "", commitBody: "", commitType: "feat", branchType: null, stageAll: true, selectedRepoPaths: null, descriptionExpanded: false, showCommitSection: false, showPRSection: false, showBranchSection: false };

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

function commitPreview() {
  const t = savedState.commitType;
  const scope = (savedState.commitScope || "").trim();
  const subject = (savedState.commitSubject || "").trim() || "<subject>";
  const head = scope ? t + "(" + scope + "): " + subject : t + ": " + subject;
  return head + "\\n\\nCU-" + model.task.customId;
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

  const statusBg = 'color-mix(in srgb, ' + t.status.color + ' 14%, transparent)';
  const statusBorder = 'color-mix(in srgb, ' + t.status.color + ' 50%, transparent)';
  const statusBadge = '<span class="status-badge" style="color:' + t.status.color + ';background:' + statusBg + ';border-color:' + statusBorder + '"><span class="status-dot" style="background:' + t.status.color + '"></span>' + escape(t.status.status) + '</span>';

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
  const prCount = (model.prMatches || []).length;
  if (branchCount > 0) savedState.showBranchSection = false;

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
  if (branchCount > 0 && prCount === 0 && !linked) {
    actionBtns.push('<button class="action-btn" id="action-create-pr">Create PR</button>');
  }
  if (prCount > 0) {
    actionBtns.push(
      '<button class="action-btn primary" id="action-review" title="Open code review for ' + prCount + ' matching PR' + (prCount === 1 ? '' : 's') + '">' +
        '👁 Code Review <span class="count">' + prCount + '</span>' +
      '</button>',
    );
  }
  actionBtns.push('<button class="action-btn" id="action-commit">Commit</button>');
  const actionsHtml = '<div class="task-actions">' + actionBtns.join('') + '</div>';

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
          repoPillsHtml +
          '<div class="preview" id="branch-preview"></div>' +
          '<div class="row" style="margin-top:10px"><button class="primary" id="create-branch-btn">Create branch & checkout</button></div>' +
        '</div>' +
      '</div>'
    : '';

  const prSectionHtml = savedState.showPRSection
    ? '<div class="collapsible-section">' +
        '<h2>GitHub PR</h2>' +
        '<div class="pr-card">' +
          (linked ? (
            '<div class="pr-linked-head">' +
              '<span class="linked-pill">Linked</span>' +
              '<span class="pr-num">#' + linked.number + '</span>' +
              '<span class="muted">' + escape(linked.owner) + '/' + escape(linked.repo) + '</span>' +
              '<span class="spacer"></span>' +
              '<a href="' + escape(linked.url) + '" data-external="1" style="margin-left:auto;color:var(--vscode-textLink-foreground);text-decoration:none">Open on GitHub ↗</a>' +
            '</div>' +
            '<div class="row">' +
              '<button class="primary" id="checkout-btn">Checkout PR branch</button>' +
              '<button class="secondary" id="relink-btn">Replace link…</button>' +
            '</div>'
          ) : (
            '<p class="muted" style="margin:0 0 10px">Open GitHub to create a pull request, then link it to this task.</p>' +
            (model.branchMatches || []).map((b) => {
              const repo = (model.repos || []).find((r) => r.path === b.repoPath);
              const gh = repo && repo.owner && repo.repo
                ? 'https://github.com/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo) + '/pull/new/' + encodeURIComponent(b.branch)
                : '';
              return '<div class="row">' +
                '<span><strong>' + escape(b.repoName) + '</strong> · <code>' + escape(b.branch) + '</code></span>' +
                (gh ? '<a href="' + escape(gh) + '" data-external="1" style="margin-left:auto;color:var(--vscode-textLink-foreground);text-decoration:none;font-size:0.85rem">Open Create PR ↗</a>' : '') +
              '</div>';
            }).join('') +
            '<div class="row" style="margin-top:12px;flex-wrap:nowrap">' +
              '<label style="flex-shrink:0">Link PR</label>' +
              '<input type="text" id="link-pr-input" placeholder="https://github.com/owner/repo/pull/123" style="flex:1" />' +
              '<button class="primary" id="link-pr-btn" style="flex-shrink:0">Link</button>' +
            '</div>'
          )) +
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
            '<label>Scope</label>' +
            '<input type="text" id="scope-input" value="' + escape(savedState.commitScope || "") + '" placeholder="optional (e.g. auth)" style="max-width:240px" />' +
            '<label>Subject</label>' +
            '<input type="text" id="subject-input" value="' + escape(savedState.commitSubject || "") + '" placeholder="short imperative summary" />' +
            '<label>Body</label>' +
            '<textarea id="body-input" placeholder="optional details">' + escape(savedState.commitBody || "") + '</textarea>' +
          '</div>' +
          '<div class="preview" id="commit-preview"></div>' +
          '<div class="commit-hint">Tip: <kbd>⌘ Enter</kbd> (or <kbd>Ctrl Enter</kbd>) commits.</div>' +
          '<div class="action-row">' +
            '<label class="checkbox-row"><input type="checkbox" id="stage-all"' + (savedState.stageAll ? " checked" : "") + ' />Stage all changes</label>' +
            '<span class="spacer"></span>' +
            '<button class="secondary" id="commit-btn">Commit</button>' +
            '<button class="primary" id="commit-push-btn">Commit & Push</button>' +
            '<button class="secondary" id="push-btn">Push only</button>' +
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
        prSectionHtml +
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
  const scope = document.getElementById("scope-input");
  if (scope) {
    scope.addEventListener("input", (e) => { savedState.commitScope = e.target.value; saveDraft(); updatePreviews(); });
    scope.addEventListener("keydown", commitKeydown);
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
    });
  });
  const checkout = document.getElementById("checkout-btn");
  if (checkout) checkout.addEventListener("click", () => vscode.postMessage({ type: "checkoutLinkedPR" }));

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
    savedState.showPRSection = true;
    saveDraft();
    render();
  });
  const actionReview = document.getElementById("action-review");
  if (actionReview) actionReview.addEventListener("click", () => vscode.postMessage({ type: "openTaskReview" }));
  const actionCommit = document.getElementById("action-commit");
  if (actionCommit) actionCommit.addEventListener("click", () => {
    savedState.showCommitSection = true;
    saveDraft();
    render();
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
  if (commit) commit.addEventListener("click", () => sendCommit(false));
  const commitPush = document.getElementById("commit-push-btn");
  if (commitPush) commitPush.addEventListener("click", () => sendCommit(true));
  const push = document.getElementById("push-btn");
  if (push) push.addEventListener("click", () => vscode.postMessage({ type: "push" }));

  const relink = document.getElementById("relink-btn");
  if (relink) relink.addEventListener("click", () => {
    const url = prompt("Paste new GitHub PR URL", model.linkedPR ? model.linkedPR.url : "");
    if (url) vscode.postMessage({ type: "linkPR", url: url.trim() });
  });

  const linkPrBtn = document.getElementById("link-pr-btn");
  if (linkPrBtn) linkPrBtn.addEventListener("click", () => {
    const input = document.getElementById("link-pr-input");
    const url = input ? input.value.trim() : "";
    if (!url) { flash("Paste a GitHub PR URL first."); return; }
    vscode.postMessage({ type: "linkPR", url: url });
  });
}

function commitKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    sendCommit(false);
  }
}

function sendCommit(thenPush) {
  if (!(savedState.commitSubject || "").trim()) { flash("Subject is required."); return; }
  vscode.postMessage({
    type: "commit",
    commitType: savedState.commitType,
    scope: savedState.commitScope || "",
    subject: savedState.commitSubject || "",
    body: savedState.commitBody || "",
    stageAll: !!savedState.stageAll,
    thenPush: thenPush,
  });
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "state") {
    model = msg;
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
