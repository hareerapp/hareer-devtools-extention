import * as vscode from "vscode";
import { createIssueComment, deleteBranch, isProtectedBranch, mergePR } from "./github-api";
import { getPRBundle, invalidatePR } from "./pr-cache";
import type { PRBundle } from "./pr-cache";
import type {
  PRCheckRun,
  PRDetail,
  PRFile,
  PRIssueComment,
  PRReview,
  ReviewComment,
  Submodule,
} from "./types";

// ============================================================================
// Types
// ============================================================================

interface PanelState {
  submodule: Submodule;
  prNumber: number;
  detail?: PRDetail;
  reviews?: PRReview[];
  comments?: PRIssueComment[];
  lineComments?: ReviewComment[];
  files?: PRFile[];
  checks?: PRCheckRun[];
}

type InboundMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openExternal"; url: string }
  | { type: "openFile"; filename: string }
  | { type: "postComment"; body: string }
  | { type: "submitReview"; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" }
  | { type: "merge"; method: "merge" | "squash" | "rebase" };

export interface PRDetailHostCallbacks {
  openFile(submodule: Submodule, prNumber: number, filename: string): Promise<void>;
  promptSubmitReview(
    submodule: Submodule,
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  ): Promise<void>;
}

// ============================================================================
// Panel — singleton webview manager
// ============================================================================

export class PRDetailPanel {
  private static current: PRDetailPanel | undefined;
  private static cb: PRDetailHostCallbacks | undefined;

  static configure(cb: PRDetailHostCallbacks): void {
    PRDetailPanel.cb = cb;
  }

  static async openOrReveal(submodule: Submodule, prNumber: number): Promise<void> {
    if (PRDetailPanel.current) {
      await PRDetailPanel.current.show(submodule, prNumber);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "hareerPrDetail",
      `PR #${prNumber}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [],
      },
    );
    PRDetailPanel.current = new PRDetailPanel(panel);
    await PRDetailPanel.current.show(submodule, prNumber);
  }

  static refreshIfShowing(submodule: Submodule, prNumber: number): void {
    const cur = PRDetailPanel.current;
    if (!cur) return;
    if (cur.state.submodule.name !== submodule.name || cur.state.prNumber !== prNumber) return;
    void cur.refresh();
  }

  private state: PanelState;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.state = { submodule: undefined as unknown as Submodule, prNumber: 0 };

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (m) => this.handle(m as InboundMessage),
      null,
      this.disposables,
    );
    // Auto-refresh when the user brings the panel back into focus.
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible && this.state.detail) {
          void this.refresh();
        }
      },
      null,
      this.disposables,
    );
  }

  async show(submodule: Submodule, prNumber: number): Promise<void> {
    this.state = { submodule, prNumber };
    this.panel.title = `PR #${prNumber} · ${submodule.repo}`;
    this.panel.webview.html = this.render();
    this.panel.reveal(vscode.ViewColumn.Active, false);
    await this.refresh();
  }

  private async refresh(force = false): Promise<void> {
    const { submodule, prNumber } = this.state;

    // Apply a bundle to the panel only if it's still showing the same PR.
    const apply = (b: PRBundle): void => {
      if (this.state.submodule.name !== submodule.name || this.state.prNumber !== prNumber) {
        return;
      }
      this.state = {
        submodule,
        prNumber,
        detail: b.detail,
        reviews: b.reviews,
        comments: b.comments,
        lineComments: b.lineComments,
        files: b.files,
        checks: b.checks,
      };
      this.postState();
    };

    try {
      // Cache hit paints instantly; a stale entry triggers the onUpdate repaint.
      const bundle = await getPRBundle(
        submodule.owner,
        submodule.repo,
        prNumber,
        { force },
        apply,
      );
      apply(bundle);
    } catch (err) {
      if (this.state.detail) return; // keep showing cached data on a failed revalidate
      const msg = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: "error", message: msg });
    }
  }

  private async handle(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        if (this.state.detail) this.postState();
        return;
      case "refresh":
        invalidatePR(this.state.submodule.owner, this.state.submodule.repo, this.state.prNumber);
        await this.refresh(true);
        return;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "openFile":
        await PRDetailPanel.cb?.openFile(this.state.submodule, this.state.prNumber, msg.filename);
        return;
      case "postComment":
        await this.handlePostComment(msg.body);
        return;
      case "submitReview":
        await PRDetailPanel.cb?.promptSubmitReview(
          this.state.submodule,
          this.state.prNumber,
          msg.event,
        );
        invalidatePR(this.state.submodule.owner, this.state.submodule.repo, this.state.prNumber);
        await this.refresh(true);
        return;
      case "merge":
        await this.handleMerge(msg.method);
        return;
    }
  }

  private async handlePostComment(body: string): Promise<void> {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    try {
      await createIssueComment(
        this.state.submodule.owner,
        this.state.submodule.repo,
        this.state.prNumber,
        trimmed,
      );
      void vscode.window.showInformationMessage("Hareer: Comment posted.");
      invalidatePR(this.state.submodule.owner, this.state.submodule.repo, this.state.prNumber);
      await this.refresh(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to post comment — ${msg}`);
    }
  }

  private async handleMerge(method: "merge" | "squash" | "rebase"): Promise<void> {
    const { detail, submodule, prNumber } = this.state;
    if (!detail) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Merge PR #${prNumber} into ${detail.baseRef}?`,
      { modal: true },
      "Merge",
    );
    if (confirmed !== "Merge") return;
    try {
      await mergePR(submodule.owner, submodule.repo, prNumber, method);

      let deletedNote = "";
      if (!isProtectedBranch(detail.headRef, detail.baseRef)) {
        try {
          await deleteBranch(submodule.owner, submodule.repo, detail.headRef);
          deletedNote = ` — deleted ${detail.headRef}`;
        } catch {
          /* branch may already be gone (auto-delete) — ignore */
        }
      }

      void vscode.window.showInformationMessage(
        `Hareer: PR #${prNumber} merged into ${detail.baseRef} ✓${deletedNote}`,
      );
      invalidatePR(submodule.owner, submodule.repo, prNumber);
      await this.refresh(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to merge — ${msg}`);
    }
  }

  private postState(): void {
    const { detail, reviews, comments, lineComments, files, checks } = this.state;
    if (!detail) return;
    void this.panel.webview.postMessage({
      type: "state",
      detail,
      reviews: reviews ?? [],
      comments: comments ?? [],
      lineComments: lineComments ?? [],
      files: files ?? [],
      checks: checks ?? [],
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
  <title>PR Detail</title>
  <style>${WEBVIEW_CSS}</style>
</head>
<body>
  <div id="root">${SKELETON_HTML}</div>
  <script nonce="${nonce}">${WEBVIEW_JS}</script>
</body>
</html>`;
  }

  private dispose(): void {
    PRDetailPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ============================================================================
// Inlined webview assets
//
// Kept as template strings so the extension stays single-bundle and we avoid
// a second tsc pass. Theming uses VS Code CSS variables exclusively.
// ============================================================================

const SKELETON_HTML = `
<div class="skeleton-layout">
  <div class="sk-line sk-line-lg" style="width:60%"></div>
  <div class="sk-line" style="width:40%;margin-top:8px"></div>
  <div class="sk-card" style="margin-top:24px;height:120px"></div>
  <div class="sk-card" style="margin-top:16px;height:80px"></div>
  <div class="sk-card" style="margin-top:16px;height:80px"></div>
</div>
`;

const WEBVIEW_CSS = `
:root {
  color-scheme: light dark;
  --hareer-success: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #2da44e));
  --hareer-danger: var(--vscode-errorForeground, var(--vscode-testing-iconFailed, #cf222e));
  --hareer-warning: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #d29922));
  --hareer-info: var(--vscode-charts-blue, #0969da);
  --hareer-merged: var(--vscode-charts-purple, #8250df);
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

/* ------- Loading skeleton ------- */
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
  display: flex;
  align-items: center;
  gap: 12px;
}
.error-banner button { margin-left: auto; }

/* ------- Layout ------- */
.pr-layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 28px;
  padding: 24px 28px;
  max-width: 1400px;
  margin: 0 auto;
}
@media (max-width: 900px) { .pr-layout { grid-template-columns: 1fr; } }
.main { min-width: 0; }
.sidebar { font-size: 0.85rem; }

/* ------- Header ------- */
.header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; margin-bottom: 8px; grid-column: 1 / -1; }
.header .title { font-size: 1.45rem; font-weight: 600; line-height: 1.3; margin: 0 0 6px; word-break: break-word; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.header .number { color: var(--hareer-muted); font-weight: 400; }
.header .meta { color: var(--hareer-muted); font-size: 0.85rem; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.header .meta a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.header .meta a:hover { text-decoration: underline; }
.header .author { display: inline-flex; align-items: center; gap: 6px; }
.header .author img { width: 18px; height: 18px; border-radius: 50%; }
.review-summary { display: inline-flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.review-summary .pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; border: 1px solid transparent; }
.pill.approved { color: var(--hareer-success); border-color: color-mix(in srgb, var(--hareer-success) 50%, transparent); background: color-mix(in srgb, var(--hareer-success) 12%, transparent); }
.pill.changes { color: var(--hareer-danger); border-color: color-mix(in srgb, var(--hareer-danger) 50%, transparent); background: color-mix(in srgb, var(--hareer-danger) 12%, transparent); }
.pill.commented { color: var(--hareer-info); border-color: color-mix(in srgb, var(--hareer-info) 50%, transparent); background: color-mix(in srgb, var(--hareer-info) 12%, transparent); }
.pill.pending { color: var(--hareer-warning); border-color: color-mix(in srgb, var(--hareer-warning) 50%, transparent); background: color-mix(in srgb, var(--hareer-warning) 12%, transparent); }
.branch-ref { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-size: 0.85rem; }
.state-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600; border: 1px solid transparent; }
.state-open { color: var(--hareer-success); border-color: color-mix(in srgb, var(--hareer-success) 50%, transparent); background: color-mix(in srgb, var(--hareer-success) 12%, transparent); }
.state-draft { color: var(--hareer-muted); border-color: color-mix(in srgb, var(--hareer-muted) 40%, transparent); background: color-mix(in srgb, var(--hareer-muted) 8%, transparent); }
.state-merged { color: var(--hareer-merged); border-color: color-mix(in srgb, var(--hareer-merged) 50%, transparent); background: color-mix(in srgb, var(--hareer-merged) 12%, transparent); }
.state-closed { color: var(--hareer-danger); border-color: color-mix(in srgb, var(--hareer-danger) 50%, transparent); background: color-mix(in srgb, var(--hareer-danger) 12%, transparent); }

/* ------- Section headings ------- */
h2 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--hareer-muted); margin: 28px 0 10px; font-weight: 600; }
h2:first-child { margin-top: 0; }

/* ------- Sidebar ------- */
.sidebar .group { padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.sidebar .group:last-child { border-bottom: none; }
.sidebar .group-title { font-weight: 600; color: var(--vscode-foreground); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; }
.sidebar .empty { color: var(--hareer-muted); font-style: italic; }
.sidebar .user-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.sidebar .user-row img { width: 20px; height: 20px; border-radius: 50%; }
.sidebar .user-row .review-state { margin-left: auto; font-size: 0.72rem; padding: 1px 6px; border-radius: 8px; }
.review-state.approved { color: var(--hareer-success); background: color-mix(in srgb, var(--hareer-success) 12%, transparent); }
.review-state.changes_requested { color: var(--hareer-danger); background: color-mix(in srgb, var(--hareer-danger) 12%, transparent); }
.review-state.commented { color: var(--hareer-info); background: color-mix(in srgb, var(--hareer-info) 12%, transparent); }
.review-state.pending { color: var(--hareer-warning); background: color-mix(in srgb, var(--hareer-warning) 12%, transparent); }
.labels { display: flex; gap: 6px; flex-wrap: wrap; }
.label { padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 500; border: 1px solid; }

/* ------- Description & markdown ------- */
.description { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 14px 16px; }
.description-empty { color: var(--hareer-muted); font-style: italic; }
.md p { margin: 0 0 10px; }
.md p:last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4 { margin: 16px 0 8px; line-height: 1.3; font-weight: 600; }
.md h1 { font-size: 1.3rem; }
.md h2 { font-size: 1.1rem; text-transform: none; letter-spacing: 0; color: var(--vscode-foreground); padding: 0; margin: 16px 0 8px; }
.md h3 { font-size: 1.0rem; }
.md h4 { font-size: 0.9rem; }
.md ul, .md ol { padding-left: 24px; margin: 6px 0 10px; }
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
.md table { border-collapse: collapse; margin: 8px 0; }
.md table th, .md table td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; }
.md table th { background: var(--vscode-editorWidget-background); font-weight: 600; }
.md .mention { color: var(--vscode-textLink-foreground); font-weight: 500; }

/* ------- Timeline ------- */
.timeline { display: flex; flex-direction: column; gap: 12px; }
.timeline-item { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; background: var(--vscode-editorWidget-background); overflow: hidden; }
.item-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.85rem; color: var(--hareer-muted); background: var(--vscode-editor-background); }
.item-head img { width: 20px; height: 20px; border-radius: 50%; }
.item-head strong { color: var(--vscode-foreground); }
.item-body { padding: 12px 16px; word-break: break-word; }
.review-tag { margin-left: auto; padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
.review-tag.approved { background: color-mix(in srgb, var(--hareer-success) 14%, transparent); color: var(--hareer-success); }
.review-tag.changes_requested { background: color-mix(in srgb, var(--hareer-danger) 14%, transparent); color: var(--hareer-danger); }
.review-tag.commented { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.review-tag.dismissed { background: color-mix(in srgb, var(--hareer-muted) 14%, transparent); color: var(--hareer-muted); }

/* ------- Inline comments inside reviews ------- */
.line-summary { padding: 8px 14px; font-size: 0.8rem; color: var(--hareer-muted); border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.line-card { border-top: 1px solid var(--vscode-panel-border); padding: 10px 14px; background: var(--vscode-editor-background); }
.line-card-head { font-family: var(--vscode-editor-font-family); font-size: 0.75rem; color: var(--hareer-muted); margin-bottom: 6px; display: flex; gap: 10px; align-items: center; }
.line-card-head .file-link { font-weight: 600; color: var(--vscode-foreground); }
.line-hunk { background: var(--vscode-textCodeBlock-background); padding: 6px 10px; border-radius: 3px; font-size: 0.75rem; overflow: auto; margin: 0 0 8px; font-family: var(--vscode-editor-font-family); }
.line-hunk .h-add { color: var(--hareer-success); display: block; }
.line-hunk .h-del { color: var(--hareer-danger); display: block; }
.line-hunk .h-ctx { color: var(--hareer-muted); display: block; }
.line-author { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; font-size: 0.85rem; }
.line-author img { width: 18px; height: 18px; border-radius: 50%; }

/* ------- Files changed ------- */
.files { display: flex; flex-direction: column; gap: 1px; background: var(--vscode-editorWidget-border); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; overflow: hidden; }
.file-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--vscode-editorWidget-background); cursor: pointer; font-size: 0.85rem; }
.file-row:hover { background: var(--vscode-list-hoverBackground); }
.file-status { font-family: var(--vscode-editor-font-family); width: 14px; text-align: center; font-weight: 700; }
.file-status.added { color: var(--hareer-success); }
.file-status.removed { color: var(--hareer-danger); }
.file-status.modified { color: var(--hareer-warning); }
.file-status.renamed { color: var(--hareer-merged); }
.file-name { flex: 1; font-family: var(--vscode-editor-font-family); }
.file-diff { font-size: 0.75rem; color: var(--hareer-muted); }
.file-diff .add { color: var(--hareer-success); }
.file-diff .rem { color: var(--hareer-danger); }

/* ------- Checks ------- */
.checks { display: flex; flex-direction: column; gap: 4px; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; padding: 4px 0; }
.check-icon { width: 14px; text-align: center; }
.check-icon.success { color: var(--hareer-success); }
.check-icon.failure { color: var(--hareer-danger); }
.check-icon.pending { color: var(--hareer-warning); }
.check-icon.neutral { color: var(--hareer-muted); }
.check-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.check-name a { color: inherit; text-decoration: none; }
.check-name a:hover { text-decoration: underline; }

/* ------- Merge box ------- */
.merge-box { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 14px 16px; background: var(--vscode-editorWidget-background); margin-top: 20px; }
.merge-title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 8px; }
.merge-status { font-size: 0.85rem; color: var(--hareer-muted); margin-bottom: 12px; }
.merge-status.ready { color: var(--hareer-success); }
.merge-status.conflicts { color: var(--hareer-danger); }
.merge-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* ------- Comment composer ------- */
.comment-box { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 12px; background: var(--vscode-editorWidget-background); margin-top: 20px; }
.comment-box textarea {
  width: 100%; min-height: 80px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px; padding: 8px 10px;
  font-family: inherit; font-size: 0.9rem; resize: vertical; line-height: 1.5;
}
.comment-box textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.comment-hint { font-size: 0.72rem; color: var(--hareer-muted); margin-top: 4px; }
.comment-hint kbd { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
.action-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.action-row .spacer { flex: 1; }

/* ------- Buttons ------- */
button { font-family: inherit; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 3px; font-size: 0.85rem; cursor: pointer; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 14px; border-radius: 3px; font-size: 0.85rem; cursor: pointer; }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.danger { background: var(--hareer-danger); color: #fff; border: none; padding: 6px 14px; border-radius: 3px; font-size: 0.85rem; cursor: pointer; }
button.success { background: var(--hareer-success); color: #fff; border: none; padding: 6px 14px; border-radius: 3px; font-size: 0.85rem; cursor: pointer; }
button.icon-only { padding: 4px 8px; font-size: 0.75rem; }

.muted { color: var(--hareer-muted); }
.stat-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 0.72rem; padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 500; }
`;

const WEBVIEW_JS = `
const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
let model = null;
let savedState = vscode.getState() || { draft: "" };

function escape(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.round(hr / 24);
  if (day < 30) return day + "d ago";
  return d.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Minimal but real Markdown renderer.
// Order of operations matters: extract fenced code first so inline rules don't
// touch its contents, then handle block structure, then inline.
// ---------------------------------------------------------------------------
function renderMarkdown(text) {
  if (!text) return "";

  // 1. Extract fenced code blocks (placeholder them so escape doesn't mangle).
  const fences = [];
  let src = String(text).replace(/\`\`\`([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)\\n\`\`\`/g, (_, lang, code) => {
    fences.push({ lang, code });
    return "\\u0000FENCE" + (fences.length - 1) + "\\u0000";
  });

  // 2. HTML-escape the rest.
  src = escape(src);

  // 3. Inline code (\`...\`)
  src = src.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');

  // 4. Block structure: split into paragraphs by blank lines.
  const blocks = src.split(/\\n{2,}/);
  const html = blocks.map(renderBlock).join("\\n");

  // 5. Restore fenced code blocks.
  const restored = html.replace(/\\u0000FENCE(\\d+)\\u0000/g, (_, i) => {
    const f = fences[Number(i)];
    const langCls = f.lang ? ' class="lang-' + escape(f.lang) + '"' : '';
    return '<pre><code' + langCls + '>' + escape(f.code) + '</code></pre>';
  });

  return '<div class="md">' + restored + '</div>';
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return "";

  // Heading
  const h = trimmed.match(/^(#{1,4})\\s+(.+)$/);
  if (h) return '<h' + h[1].length + '>' + applyInline(h[2]) + '</h' + h[1].length + '>';

  // Horizontal rule
  if (/^(-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) return '<hr />';

  // Blockquote
  if (trimmed.split('\\n').every((l) => l.startsWith('&gt;') || l.startsWith('>'))) {
    const inner = trimmed.split('\\n').map((l) => l.replace(/^&gt;\\s?|^>\\s?/, '')).join('\\n');
    return '<blockquote>' + renderBlock(inner) + '</blockquote>';
  }

  // Lists
  const lines = trimmed.split('\\n');
  const isUL = lines.every((l) => /^\\s*[-*+]\\s+/.test(l));
  const isOL = lines.every((l) => /^\\s*\\d+\\.\\s+/.test(l));
  if (isUL || isOL) {
    const tag = isOL ? 'ol' : 'ul';
    const items = lines.map((l) => {
      const m = isOL ? l.match(/^\\s*\\d+\\.\\s+(.*)$/) : l.match(/^\\s*[-*+]\\s+(.*)$/);
      let content = m ? m[1] : l;
      // Task list
      const task = content.match(/^\\[( |x|X)\\]\\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
        return '<li class="task"><input type="checkbox" disabled' + checked + ' />' + applyInline(task[2]) + '</li>';
      }
      return '<li>' + applyInline(content) + '</li>';
    }).join('');
    return '<' + tag + '>' + items + '</' + tag + '>';
  }

  // Pipe table — header | row | row, with separator |---|---|
  if (lines.length >= 2 && /^\\|.+\\|$/.test(lines[0]) && /^\\|[\\s|:-]+\\|$/.test(lines[1])) {
    const header = lines[0].split('|').slice(1, -1).map((c) => c.trim());
    const rows = lines.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
    let html = '<table><thead><tr>' + header.map((c) => '<th>' + applyInline(c) + '</th>').join('') + '</tr></thead><tbody>';
    for (const r of rows) html += '<tr>' + r.map((c) => '<td>' + applyInline(c) + '</td>').join('') + '</tr>';
    html += '</tbody></table>';
    return html;
  }

  // Paragraph — keep single newlines as <br/>
  return '<p>' + applyInline(trimmed).replace(/\\n/g, '<br/>') + '</p>';
}

function applyInline(s) {
  let out = s;
  // Links [text](url)
  out = out.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" data-external="1">$1</a>');
  // Auto-link bare URLs
  out = out.replace(/(^|[\\s(])((?:https?:\\/\\/)[^\\s)]+)/g, '$1<a href="$2" data-external="1">$2</a>');
  // @mentions
  out = out.replace(/(^|[\\s(])@([a-zA-Z0-9-]{1,39})\\b/g, '$1<a class="mention" href="https://github.com/$2" data-external="1">@$2</a>');
  // Bold **x**
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  // Italic *x* (avoid touching bold leftovers)
  out = out.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
  return out;
}

// ---------------------------------------------------------------------------
// Diff hunk coloring for inline review comments
// ---------------------------------------------------------------------------
function renderHunk(hunk) {
  if (!hunk) return '';
  const lines = hunk.split('\\n').slice(-5);
  return '<pre class="line-hunk">' + lines.map((l) => {
    const cls = l.startsWith('+') ? 'h-add' : l.startsWith('-') ? 'h-del' : 'h-ctx';
    return '<span class="' + cls + '">' + escape(l) + '</span>';
  }).join('') + '</pre>';
}

// ---------------------------------------------------------------------------
// Badges & summaries
// ---------------------------------------------------------------------------
function stateBadge(d) {
  if (d.merged) return '<span class="state-badge state-merged">⬮ Merged</span>';
  if (d.state === "closed") return '<span class="state-badge state-closed">✕ Closed</span>';
  if (d.draft) return '<span class="state-badge state-draft">◐ Draft</span>';
  return '<span class="state-badge state-open">● Open</span>';
}

function reviewSummary(reviews, requested) {
  // Per-user latest state from non-pending reviews.
  const latest = new Map();
  for (const r of reviews) {
    if (r.state === 'PENDING' || r.state === 'DISMISSED') continue;
    latest.set(r.user.login, r.state);
  }
  let approved = 0, changes = 0, commented = 0;
  for (const s of latest.values()) {
    if (s === 'APPROVED') approved++;
    else if (s === 'CHANGES_REQUESTED') changes++;
    else commented++;
  }
  const pending = (requested || []).length;
  if (approved + changes + commented + pending === 0) return '';

  const pills = [];
  if (approved) pills.push('<span class="pill approved">✓ ' + approved + ' approved</span>');
  if (changes) pills.push('<span class="pill changes">✗ ' + changes + ' changes</span>');
  if (commented) pills.push('<span class="pill commented">💬 ' + commented + ' commented</span>');
  if (pending) pills.push('<span class="pill pending">⏳ ' + pending + ' pending</span>');
  return '<span class="review-summary">' + pills.join('') + '</span>';
}

function reviewerRow(user, state) {
  const cls = state ? state.toLowerCase() : 'pending';
  const label =
    state === 'APPROVED' ? '✓ approved' :
    state === 'CHANGES_REQUESTED' ? '✗ changes' :
    state === 'COMMENTED' ? '💬 commented' :
    '⏳ pending';
  const avatar = user.avatarUrl ? '<img src="' + escape(user.avatarUrl) + '" alt="" />' : '';
  return '<div class="user-row">' + avatar + '<span>' + escape(user.login) + '</span><span class="review-state ' + cls + '">' + label + '</span></div>';
}

function plainUserRow(user) {
  const avatar = user.avatarUrl ? '<img src="' + escape(user.avatarUrl) + '" alt="" />' : '';
  return '<div class="user-row">' + avatar + '<span>' + escape(user.login) + '</span></div>';
}

function fileStatusChar(s) {
  return s === 'added' ? 'A' : s === 'removed' ? 'D' : s === 'renamed' ? 'R' : 'M';
}

function checkIcon(c) {
  if (c.status !== 'completed') return { icon: '◐', cls: 'pending' };
  if (c.conclusion === 'success') return { icon: '✓', cls: 'success' };
  if (c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out') return { icon: '✗', cls: 'failure' };
  return { icon: '○', cls: 'neutral' };
}

// ---------------------------------------------------------------------------
// Timeline assembly
// ---------------------------------------------------------------------------
function buildTimeline(reviews, comments, lineComments) {
  const byReview = new Map();
  const orphans = [];
  for (const lc of (lineComments || [])) {
    if (lc.reviewId) {
      if (!byReview.has(lc.reviewId)) byReview.set(lc.reviewId, []);
      byReview.get(lc.reviewId).push(lc);
    } else {
      orphans.push(lc);
    }
  }
  for (const arr of byReview.values()) {
    arr.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  const items = [];
  for (const r of reviews) {
    if (r.state === 'PENDING') continue;
    items.push({ kind: 'review', when: r.submittedAt || '', data: r, lineComments: byReview.get(r.id) || [] });
  }
  for (const c of comments) {
    items.push({ kind: 'comment', when: c.createdAt, data: c });
  }
  for (const lc of orphans) {
    items.push({ kind: 'lineComment', when: lc.createdAt, data: lc });
  }
  items.sort((a, b) => String(a.when).localeCompare(String(b.when)));
  return items;
}

function lineCard(lc) {
  return '<div class="line-card">' +
    '<div class="line-card-head">' +
      '<span class="file-link">📄 ' + escape(lc.path + ':' + lc.line) + '</span>' +
      '<a href="#" data-open-line="' + escape(lc.path) + '">view in diff ↗</a>' +
    '</div>' +
    renderHunk(lc.diffHunk) +
    '<div class="line-author">' +
      (lc.userAvatarUrl ? '<img src="' + escape(lc.userAvatarUrl) + '" />' : '') +
      '<strong>' + escape(lc.user) + '</strong>' +
      '<span class="muted">· ' + escape(fmtDate(lc.createdAt)) + '</span>' +
    '</div>' +
    renderMarkdown(lc.body) +
  '</div>';
}

function timelineItem(item) {
  if (item.kind === 'comment') {
    const c = item.data;
    const avatar = c.user.avatarUrl ? '<img src="' + escape(c.user.avatarUrl) + '" />' : '';
    return '<div class="timeline-item">' +
      '<div class="item-head">' + avatar + '<strong>' + escape(c.user.login) + '</strong><span>commented · ' + escape(fmtDate(c.createdAt)) + '</span></div>' +
      '<div class="item-body">' + renderMarkdown(c.body) + '</div>' +
    '</div>';
  }
  if (item.kind === 'lineComment') {
    const lc = item.data;
    const avatar = lc.userAvatarUrl ? '<img src="' + escape(lc.userAvatarUrl) + '" />' : '';
    return '<div class="timeline-item">' +
      '<div class="item-head">' + avatar + '<strong>' + escape(lc.user) + '</strong><span>commented on ' + escape(lc.path + ':' + lc.line) + ' · ' + escape(fmtDate(lc.createdAt)) + '</span></div>' +
      lineCard(lc) +
    '</div>';
  }
  const r = item.data;
  const lineCs = item.lineComments;
  const tag = r.state.toLowerCase();
  const tagText = r.state === 'APPROVED' ? 'Approved' : r.state === 'CHANGES_REQUESTED' ? 'Changes requested' : r.state === 'COMMENTED' ? 'Commented' : 'Dismissed';
  const body = r.body ? '<div class="item-body">' + renderMarkdown(r.body) + '</div>' : '';
  const summary = lineCs.length > 0
    ? '<div class="line-summary">💬 ' + lineCs.length + ' inline comment' + (lineCs.length === 1 ? '' : 's') + ' on this review</div>'
    : '';
  const avatar = r.user.avatarUrl ? '<img src="' + escape(r.user.avatarUrl) + '" />' : '';
  return '<div class="timeline-item">' +
    '<div class="item-head">' + avatar + '<strong>' + escape(r.user.login) + '</strong><span>· ' + escape(fmtDate(r.submittedAt || '')) + '</span><span class="review-tag ' + tag + '">' + tagText + '</span></div>' +
    body + summary + lineCs.map(lineCard).join('') +
  '</div>';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  if (!model) return;
  const d = model.detail;
  const mergeable = d.mergeable === true && !d.merged && d.state === 'open';
  const conflicts = d.mergeable === false;

  // Reviewer states
  const latest = new Map();
  for (const r of model.reviews) {
    if (r.state !== 'PENDING') latest.set(r.user.login, r.state);
  }
  const reviewed = Array.from(latest.entries()).map(([login, state]) => {
    const u = (model.reviews.find((r) => r.user.login === login) || {}).user;
    return u ? reviewerRow(u, state) : '';
  }).join('');
  const requestedSet = new Set((d.requestedReviewers || []).map((u) => u.login));
  for (const login of latest.keys()) requestedSet.delete(login);
  const requested = (d.requestedReviewers || []).filter((u) => requestedSet.has(u.login)).map((u) => reviewerRow(u, null)).join('');

  const timeline = buildTimeline(model.reviews, model.comments, model.lineComments).map(timelineItem).join('');

  const files = model.files.map((f) => {
    const cls = f.status === 'added' ? 'added' : f.status === 'removed' ? 'removed' : f.status === 'renamed' ? 'renamed' : 'modified';
    return '<div class="file-row" data-filename="' + escape(f.filename) + '">' +
      '<span class="file-status ' + cls + '">' + fileStatusChar(f.status) + '</span>' +
      '<span class="file-name">' + escape(f.filename) + '</span>' +
      '<span class="file-diff"><span class="add">+' + f.additions + '</span> <span class="rem">-' + f.deletions + '</span></span>' +
    '</div>';
  }).join('');

  const checks = model.checks.map((c) => {
    const ic = checkIcon(c);
    return '<div class="check-row">' +
      '<span class="check-icon ' + ic.cls + '">' + ic.icon + '</span>' +
      '<span class="check-name"><a href="' + escape(c.htmlUrl) + '" data-external="1">' + escape(c.name) + '</a></span>' +
    '</div>';
  }).join('');

  const authorAvatar = d.author.avatarUrl ? '<img src="' + escape(d.author.avatarUrl) + '" />' : '';

  root.innerHTML =
    '<div class="pr-layout">' +
      '<div class="header">' +
        '<div class="title">' + escape(d.title) + ' <span class="number">#' + d.number + '</span> ' + stateBadge(d) + ' ' + reviewSummary(model.reviews, d.requestedReviewers) + '</div>' +
        '<div class="meta">' +
          '<span class="author">' + authorAvatar + escape(d.author.login) + '</span>' +
          '<span>wants to merge ' + d.commitsCount + ' commit' + (d.commitsCount === 1 ? '' : 's') + ' into <span class="branch-ref">' + escape(d.baseRef) + '</span> from <span class="branch-ref">' + escape(d.headRef) + '</span></span>' +
          '<span>· opened ' + escape(fmtDate(d.createdAt)) + '</span>' +
          '<span>· updated ' + escape(fmtDate(d.updatedAt)) + '</span>' +
          '<span>· <a href="' + escape(d.htmlUrl) + '" data-external="1">View on GitHub ↗</a></span>' +
        '</div>' +
      '</div>' +

      '<div class="main">' +
        '<h2>Description</h2>' +
        (d.body && d.body.trim() ? '<div class="description">' + renderMarkdown(d.body) + '</div>' : '<div class="description description-empty">No description provided.</div>') +

        '<h2>Conversation</h2>' +
        (timeline ? '<div class="timeline">' + timeline + '</div>' : '<div class="muted">No conversation yet.</div>') +

        '<div class="comment-box">' +
          '<textarea id="comment-body" placeholder="Leave a comment on this PR…">' + escape(savedState.draft || '') + '</textarea>' +
          '<div class="comment-hint">Tip: <kbd>⌘ Enter</kbd> (or <kbd>Ctrl Enter</kbd>) to comment.</div>' +
          '<div class="action-row">' +
            '<button class="primary" id="post-comment">Comment</button>' +
            '<span class="spacer"></span>' +
            '<button class="success" id="approve">✓ Approve</button>' +
            '<button class="danger" id="request-changes">✗ Request changes</button>' +
            '<button class="secondary" id="review-comment">💬 Comment review</button>' +
          '</div>' +
        '</div>' +

        '<h2>Files changed (' + d.changedFiles + ') · <span class="muted" style="font-weight:normal;text-transform:none"><span style="color:var(--hareer-success)">+' + d.additions + '</span> <span style="color:var(--hareer-danger)">-' + d.deletions + '</span></span></h2>' +
        (files ? '<div class="files">' + files + '</div>' : '<div class="muted">No file changes.</div>') +

        (d.state === 'open' && !d.merged ? (
          '<div class="merge-box">' +
            '<div class="merge-title">Merge pull request</div>' +
            '<div class="merge-status ' + (mergeable ? 'ready' : conflicts ? 'conflicts' : '') + '">' +
              (mergeable ? '✓ This branch has no conflicts with the base branch.' :
                conflicts ? '✗ This branch has conflicts that must be resolved.' :
                '◐ Checking mergeability…') +
            '</div>' +
            '<div class="merge-actions">' +
              '<button class="primary" data-merge="merge" ' + (mergeable ? '' : 'disabled') + '>Create merge commit</button>' +
              '<button class="primary" data-merge="squash" ' + (mergeable ? '' : 'disabled') + '>Squash and merge</button>' +
              '<button class="primary" data-merge="rebase" ' + (mergeable ? '' : 'disabled') + '>Rebase and merge</button>' +
            '</div>' +
          '</div>'
        ) : '') +
      '</div>' +

      '<div class="sidebar">' +
        '<div class="group">' +
          '<div class="group-title"><span>Reviewers</span><button class="secondary icon-only" id="refresh-btn" title="Refresh">⟳</button></div>' +
          (reviewed || requested ? (reviewed + requested) : '<div class="empty">No reviewers</div>') +
        '</div>' +

        '<div class="group">' +
          '<div class="group-title">Assignees</div>' +
          (d.assignees.length > 0 ? d.assignees.map(plainUserRow).join('') : '<div class="empty">No one</div>') +
        '</div>' +

        '<div class="group">' +
          '<div class="group-title">Labels</div>' +
          (d.labels.length > 0 ? '<div class="labels">' + d.labels.map((l) => '<span class="label" style="border-color:#' + escape(l.color) + ';color:#' + escape(l.color) + '">' + escape(l.name) + '</span>').join('') + '</div>' : '<div class="empty">None</div>') +
        '</div>' +

        '<div class="group">' +
          '<div class="group-title">Milestone</div>' +
          (d.milestone ? escape(d.milestone) : '<div class="empty">None</div>') +
        '</div>' +

        '<div class="group">' +
          '<div class="group-title"><span>Checks</span><span class="stat-pill">' + (model.checks.length) + '</span></div>' +
          (model.checks.length > 0 ? '<div class="checks">' + checks + '</div>' : '<div class="empty">No checks</div>') +
        '</div>' +

        '<div class="group">' +
          '<div class="group-title">Stats</div>' +
          '<div>' + d.commitsCount + ' commit' + (d.commitsCount === 1 ? '' : 's') + '</div>' +
          '<div>' + d.changedFiles + ' file' + (d.changedFiles === 1 ? '' : 's') + ' changed</div>' +
          '<div><span style="color:var(--hareer-success)">+' + d.additions + '</span> <span style="color:var(--hareer-danger)">-' + d.deletions + '</span></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll('[data-external]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: a.getAttribute('href') });
    });
  });
  document.querySelectorAll('[data-filename]').forEach((row) => {
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'openFile', filename: row.getAttribute('data-filename') });
    });
  });
  document.querySelectorAll('[data-open-line]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openFile', filename: a.getAttribute('data-open-line') });
    });
  });
  document.querySelectorAll('[data-merge]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'merge', method: btn.getAttribute('data-merge') }));
  });
  const refresh = document.getElementById('refresh-btn');
  if (refresh) refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  const ta = document.getElementById('comment-body');
  if (ta) {
    ta.addEventListener('input', (e) => {
      savedState = { ...savedState, draft: e.target.value };
      vscode.setState(savedState);
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        postComment();
      }
    });
  }

  const post = document.getElementById('post-comment');
  if (post) post.addEventListener('click', postComment);
  const approve = document.getElementById('approve');
  if (approve) approve.addEventListener('click', () => vscode.postMessage({ type: 'submitReview', event: 'APPROVE' }));
  const reqCh = document.getElementById('request-changes');
  if (reqCh) reqCh.addEventListener('click', () => vscode.postMessage({ type: 'submitReview', event: 'REQUEST_CHANGES' }));
  const cmtRev = document.getElementById('review-comment');
  if (cmtRev) cmtRev.addEventListener('click', () => vscode.postMessage({ type: 'submitReview', event: 'COMMENT' }));
}

function postComment() {
  const ta = document.getElementById('comment-body');
  if (!ta) return;
  const body = ta.value;
  if (!body.trim()) return;
  vscode.postMessage({ type: 'postComment', body });
  ta.value = '';
  savedState = { ...savedState, draft: '' };
  vscode.setState(savedState);
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') {
    model = m;
    render();
  } else if (m.type === 'error') {
    root.innerHTML = '<div class="error-banner">' +
      '<span>⚠️ Failed to load PR: ' + escape(m.message) + '</span>' +
      '<button class="primary" id="retry">Retry</button>' +
    '</div>';
    const retry = document.getElementById('retry');
    if (retry) retry.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  }
});

vscode.postMessage({ type: 'ready' });
`;
