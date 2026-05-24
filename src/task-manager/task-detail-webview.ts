import * as vscode from "vscode";
import {
  checkoutBranch,
  commit as gitCommit,
  createAndCheckoutBranch,
  getDirtyStatus,
  getOriginRemote,
  pickRepository,
  push as gitPush,
} from "./git-operations";
import type { Repository } from "./git-operations";
import { formatBranchName, validateGitRef } from "./branch-naming";
import { formatCommitMessage, inferCommitType } from "./commit-naming";
import { getLinkedPR } from "./pr-url-field";
import { getTask, setCustomFieldValue, updateTaskStatus } from "./clickup-api";
import { findPRField } from "./pr-url-field";
import { getClickUpToken } from "./auth";
import type { TaskService } from "./task-service";
import type { BranchType, ClickUpTask, CommitType } from "./types";

interface InboundConnectMessage {
  readonly type: "ready";
}
interface InboundCreateBranchMessage {
  readonly type: "createBranch";
  readonly branchType: BranchType;
}
interface InboundCheckoutBranchMessage {
  readonly type: "checkoutBranch";
}
interface InboundCommitMessage {
  readonly type: "commit";
  readonly commitType: CommitType;
  readonly scope: string;
  readonly subject: string;
  readonly body: string;
  readonly stageAll: boolean;
  readonly thenPush: boolean;
}
interface InboundPushMessage {
  readonly type: "push";
}
interface InboundLinkPRMessage {
  readonly type: "linkPR";
  readonly url: string;
}
interface InboundOpenExternalMessage {
  readonly type: "openExternal";
  readonly url: string;
}
interface InboundRefreshMessage {
  readonly type: "refresh";
}

type InboundMessage =
  | InboundConnectMessage
  | InboundCreateBranchMessage
  | InboundCheckoutBranchMessage
  | InboundCommitMessage
  | InboundPushMessage
  | InboundLinkPRMessage
  | InboundOpenExternalMessage
  | InboundRefreshMessage;

interface PanelState {
  readonly taskId: string;
  task: ClickUpTask;
}

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
  }

  async show(taskId: string): Promise<void> {
    const token = await getClickUpToken(this.context);
    if (!token) {
      void vscode.window.showWarningMessage("Hareer: Connect ClickUp first.");
      this.panel.dispose();
      return;
    }
    try {
      const task = await getTask(token, taskId);
      this.state = { taskId, task };
      this.panel.title = task.customId ? `CU ${task.customId}` : `Task ${task.id.slice(0, 8)}`;
      this.panel.webview.html = this.render();
      this.panel.reveal(vscode.ViewColumn.Active, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Could not load task — ${msg}`);
      this.panel.dispose();
    }
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    if (!this.state) return;
    switch (msg.type) {
      case "ready":
        this.postState();
        return;
      case "createBranch":
        await this.handleCreateBranch(msg.branchType);
        return;
      case "checkoutBranch":
        await this.handleCheckoutLinkedBranch();
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
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "refresh":
        await this.show(this.state.taskId);
        return;
    }
  }

  private async handleCreateBranch(branchType: BranchType): Promise<void> {
    if (!this.state) return;
    const repo = await pickRepository();
    if (!repo) return;

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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Hareer: Branch creation failed — ${msg}`);
        }
      },
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

  private async handleCommit(msg: InboundCommitMessage): Promise<void> {
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
        validateInput: (v) => (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(v.trim()) ? undefined : "Must be a GitHub PR URL"),
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
      /* status name may not match; surface no error */
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
    void this.panel.webview.postMessage({
      type: "state",
      task: {
        id: this.state.task.id,
        customId: this.state.task.customId ?? this.state.task.id,
        name: this.state.task.name,
        description: this.state.task.description,
        status: {
          status: status.status,
          type: status.type,
          color: sanitizeColor(status.color),
        },
        url: this.state.task.url,
        list: this.state.task.list,
        assignees: this.state.task.assignees.map((a) => a.username),
        dueDate: this.state.task.dueDate,
      },
      linkedPR: linked ?? null,
      branchTypes: vscode.workspace
        .getConfiguration("hareer.clickup")
        .get<string[]>("branchTypes", ["feature", "bugfix", "hotfix", "chore", "docs", "refactor"]),
      dirty: getCurrentDirtyStatus(),
    });
  }

  private render(): string {
    if (!this.state) return "";
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${this.panel.webview.cspSource} https:; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Hareer Task</title>
  <style>${WEBVIEW_CSS}</style>
</head>
<body>
  <div id="root"></div>
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

function sanitizeColor(raw: string | undefined): string {
  if (!raw) return "#888";
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(trimmed)) return trimmed;
  return "#888";
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

// Inlined webview assets — small enough to live in TS, avoids a second build pipeline.

const WEBVIEW_CSS = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 16px 20px;
  margin: 0;
}
h1, h2, h3 { font-weight: 600; margin: 0; }
h1 { font-size: 1.3rem; line-height: 1.3; margin-bottom: 4px; }
h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 24px 0 8px; }
.header .meta { color: var(--vscode-descriptionForeground); font-size: 0.85rem; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.header .meta a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.header .meta a:hover { text-decoration: underline; }
.badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.description {
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textBlockQuote-border);
  padding: 10px 12px;
  border-radius: 3px;
  white-space: pre-wrap;
  font-size: 0.9rem;
  max-height: 200px;
  overflow: auto;
}
.section {
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 4px;
  padding: 12px 14px;
  margin-top: 6px;
}
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.row:last-child { margin-bottom: 0; }
.row label { font-size: 0.8rem; color: var(--vscode-descriptionForeground); min-width: 70px; }
.chip {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid transparent;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 0.8rem;
  cursor: pointer;
}
.chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
.chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 6px 14px;
  border-radius: 2px;
  font-size: 0.85rem;
  cursor: pointer;
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  padding: 6px 14px;
  border-radius: 2px;
  font-size: 0.85rem;
  cursor: pointer;
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
input[type=text], textarea {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 4px 8px;
  font-family: inherit;
  font-size: 0.85rem;
  border-radius: 2px;
  width: 100%;
  box-sizing: border-box;
}
textarea { resize: vertical; min-height: 60px; }
.preview {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.8rem;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textCodeBlock-background);
  padding: 6px 10px;
  border-radius: 2px;
  margin-top: 6px;
  word-break: break-all;
  white-space: pre-wrap;
}
.flash {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--vscode-notifications-background);
  color: var(--vscode-notifications-foreground);
  border: 1px solid var(--vscode-notifications-border);
  padding: 8px 14px;
  border-radius: 4px;
  font-size: 0.85rem;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}
.flash.show { opacity: 1; }
.checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; color: var(--vscode-descriptionForeground); }
.warn { color: var(--vscode-editorWarning-foreground); font-size: 0.75rem; margin-top: 4px; }
.muted { color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
`;

const WEBVIEW_JS = `
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
let model = null;

function flash(text) {
  const el = document.createElement("div");
  el.className = "flash show";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, 2200);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
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

function commitPreview(state) {
  const t = state.commitType;
  const scope = state.scope.trim();
  const subject = state.subject.trim() || "<subject>";
  const head = scope ? t + "(" + scope + "): " + subject : t + ": " + subject;
  return head + "\\n\\nCU-" + model.task.customId;
}

const ui = {
  branchType: null,
  commitType: "feat",
  scope: "",
  subject: "",
  body: "",
  stageAll: true,
  linkUrl: "",
};

function render() {
  if (!model) { root.innerHTML = "<p class='muted'>Loading task…</p>"; return; }
  const t = model.task;
  const linked = model.linkedPR;
  const branchTypes = model.branchTypes;
  if (!ui.branchType) ui.branchType = branchTypes[0];

  root.innerHTML = \`
    <div class="header">
      <h1>\${escape(t.name)}</h1>
      <div class="meta">
        <span class="badge"><span class="status-dot" style="background:\${escape(t.status.color)}"></span>\${escape(t.status.status)}</span>
        <span>CU \${escape(t.customId)}</span>
        <span>\${escape(t.list.name)}</span>
        <a href="#" id="open-clickup">Open in ClickUp ↗</a>
      </div>
    </div>

    \${t.description ? \`<h2>Description</h2><div class="description">\${escape(t.description)}</div>\` : ""}

    <h2>GitHub PR</h2>
    <div class="section">
      \${linked ? \`
        <div class="row"><span class="badge">Linked</span>
          <strong>#\${linked.number}</strong>
          <span class="muted">\${escape(linked.owner)}/\${escape(linked.repo)}</span>
          <a href="#" id="open-pr">Open ↗</a>
        </div>
        <div class="row">
          <button class="primary" id="checkout-btn">Checkout PR branch</button>
          <button class="secondary" id="relink-btn">Replace link…</button>
        </div>
      \` : \`
        <div class="row">
          <label>Type</label>
          \${branchTypes.map((bt) => \`<button class="chip \${ui.branchType === bt ? "active" : ""}" data-bt="\${escape(bt)}">\${escape(bt)}</button>\`).join("")}
        </div>
        <div class="preview" id="branch-preview"></div>
        <div class="row" style="margin-top:10px"><button class="primary" id="create-branch-btn">Create branch & checkout</button></div>
      \`}
    </div>

    <h2>Commit</h2>
    <div class="section">
      <div class="row">
        <label>Type</label>
        \${["feat","fix","chore","docs","refactor","test","style","perf"].map((ct) => \`<button class="chip \${ui.commitType === ct ? "active" : ""}" data-ct="\${ct}">\${ct}</button>\`).join("")}
      </div>
      <div class="row">
        <label>Scope</label>
        <input type="text" id="scope-input" value="\${escape(ui.scope)}" placeholder="optional (e.g. auth)" style="max-width:200px" />
      </div>
      <div class="row">
        <label>Subject</label>
        <input type="text" id="subject-input" value="\${escape(ui.subject)}" placeholder="short imperative summary" />
      </div>
      <div class="row">
        <label>Body</label>
        <textarea id="body-input" placeholder="optional details">\${escape(ui.body)}</textarea>
      </div>
      <div class="preview" id="commit-preview"></div>
      <div class="row" style="margin-top:10px">
        <label class="checkbox-row"><input type="checkbox" id="stage-all" \${ui.stageAll ? "checked" : ""} />Stage all changes</label>
      </div>
      <div class="row">
        <button class="secondary" id="commit-btn">Commit</button>
        <button class="primary" id="commit-push-btn">Commit & Push</button>
        <button class="secondary" id="push-btn">Push only</button>
      </div>
      \${model.dirty ? \`<div class="muted">Branch: \${escape(model.dirty.branch)} · \${model.dirty.staged} staged · \${model.dirty.unstaged} unstaged</div>\` : ""}
    </div>
  \`;

  updatePreviews();
  bindEvents();
}

function updatePreviews() {
  const bp = document.getElementById("branch-preview");
  if (bp) bp.textContent = branchPreview(ui.branchType);
  const cp = document.getElementById("commit-preview");
  if (cp) cp.textContent = commitPreview(ui);
}

function bindEvents() {
  document.querySelectorAll("[data-bt]").forEach((el) => {
    el.addEventListener("click", () => { ui.branchType = el.getAttribute("data-bt"); render(); });
  });
  document.querySelectorAll("[data-ct]").forEach((el) => {
    el.addEventListener("click", () => { ui.commitType = el.getAttribute("data-ct"); render(); });
  });
  const subj = document.getElementById("subject-input");
  if (subj) subj.addEventListener("input", (e) => { ui.subject = e.target.value; updatePreviews(); });
  const scope = document.getElementById("scope-input");
  if (scope) scope.addEventListener("input", (e) => { ui.scope = e.target.value; updatePreviews(); });
  const body = document.getElementById("body-input");
  if (body) body.addEventListener("input", (e) => { ui.body = e.target.value; });
  const stage = document.getElementById("stage-all");
  if (stage) stage.addEventListener("change", (e) => { ui.stageAll = e.target.checked; });

  const openCU = document.getElementById("open-clickup");
  if (openCU) openCU.addEventListener("click", (e) => { e.preventDefault(); vscode.postMessage({ type: "openExternal", url: model.task.url }); });
  const openPR = document.getElementById("open-pr");
  if (openPR) openPR.addEventListener("click", (e) => { e.preventDefault(); vscode.postMessage({ type: "openExternal", url: model.linkedPR.url }); });

  const createBranch = document.getElementById("create-branch-btn");
  if (createBranch) createBranch.addEventListener("click", () => {
    if (ui.commitType === "feat" || !ui.commitType) ui.commitType = inferCommitType[ui.branchType] || "feat";
    vscode.postMessage({ type: "createBranch", branchType: ui.branchType });
  });

  const checkout = document.getElementById("checkout-btn");
  if (checkout) checkout.addEventListener("click", () => vscode.postMessage({ type: "checkoutBranch" }));

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
}

function sendCommit(thenPush) {
  if (!ui.subject.trim()) { flash("Subject is required."); return; }
  vscode.postMessage({
    type: "commit",
    commitType: ui.commitType,
    scope: ui.scope,
    subject: ui.subject,
    body: ui.body,
    stageAll: ui.stageAll,
    thenPush: thenPush,
  });
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "state") { model = msg; render(); }
  else if (msg.type === "flash") { flash(msg.text); }
});

vscode.postMessage({ type: "ready" });
`;
