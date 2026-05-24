import * as path from "node:path";
import * as vscode from "vscode";
import {
  createReviewComment,
  fetchPRComments,
  replyToReviewComment,
  submitReview,
} from "./github-api";
import { PendingReviewStore } from "./pending-review-store";
import type { PendingComment } from "./pending-review-store";
import type { PRFile, PullRequest, ReviewComment, Submodule } from "./types";

interface ActiveDiffContext {
  submodule: Submodule;
  pr: PullRequest;
  file: PRFile;
  headSha: string;
  headFileUri: vscode.Uri;
  /** Threads we created from server comments — keyed by root comment id. */
  threadsByRootId: Map<number, vscode.CommentThread>;
  /** All threads we created in this file (server + local). */
  threads: vscode.CommentThread[];
}

interface ThreadMeta {
  /** Root server comment id if this thread comes from server (for replies). */
  serverRootId?: number;
  /** True if the user has added local pending comments on this thread. */
  hasPending: boolean;
}

export class HareerCommentProvider implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly activeDiffs = new Map<string, ActiveDiffContext>();
  private readonly threadMeta = new WeakMap<vscode.CommentThread, ThreadMeta>();
  private readonly _onDidChangePending = new vscode.EventEmitter<void>();
  readonly onDidChangePending = this._onDidChangePending.event;

  readonly store = new PendingReviewStore();

  constructor() {
    this.controller = vscode.comments.createCommentController(
      "hareerReview",
      "Hareer Code Review",
    );

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document, _token) => {
        if (this.activeDiffs.has(path.normalize(document.uri.fsPath))) {
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
        return undefined;
      },
    };

    this.disposables.push(this.controller);
    this.disposables.push(this.store);
    this.disposables.push(this.store.onDidChange(() => this._onDidChangePending.fire()));
  }

  async loadCommentsForFile(
    submodule: Submodule,
    pr: PullRequest,
    file: PRFile,
    headSha: string,
    headFileUri: vscode.Uri,
  ): Promise<void> {
    const key = path.normalize(headFileUri.fsPath);
    const existing = this.activeDiffs.get(key);
    if (existing) {
      for (const t of existing.threads) t.dispose();
    }

    const ctx: ActiveDiffContext = {
      submodule,
      pr,
      file,
      headSha,
      headFileUri,
      threadsByRootId: new Map(),
      threads: [],
    };
    this.activeDiffs.set(key, ctx);

    let comments: ReviewComment[];
    try {
      comments = await fetchPRComments(submodule.owner, submodule.repo, pr.number);
    } catch {
      return;
    }

    // Group comments into threads: replies attach to their root.
    const fileComments = comments.filter((c) => c.path === file.filename);
    const rootById = new Map<number, ReviewComment>();
    const repliesByRoot = new Map<number, ReviewComment[]>();
    for (const c of fileComments) {
      if (c.inReplyToId === undefined) {
        rootById.set(c.id, c);
      }
    }
    for (const c of fileComments) {
      if (c.inReplyToId !== undefined) {
        // Walk reply chain to find ultimate root.
        let rootId = c.inReplyToId;
        let safety = 0;
        while (safety++ < 50) {
          const parent = fileComments.find((p) => p.id === rootId);
          if (!parent || parent.inReplyToId === undefined) break;
          rootId = parent.inReplyToId;
        }
        if (!repliesByRoot.has(rootId)) repliesByRoot.set(rootId, []);
        repliesByRoot.get(rootId)!.push(c);
      }
    }

    for (const root of rootById.values()) {
      const replies = (repliesByRoot.get(root.id) ?? []).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const lineIndex = Math.max(0, root.line - 1);
      const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
      const thread = this.controller.createCommentThread(headFileUri, range, [
        buildVscodeComment(root),
        ...replies.map(buildVscodeComment),
      ]);
      thread.label = replies.length > 0 ? `${replies.length + 1} comments` : `@${root.user}`;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.canReply = true;
      ctx.threads.push(thread);
      ctx.threadsByRootId.set(root.id, thread);
      this.threadMeta.set(thread, { serverRootId: root.id, hasPending: false });
    }
  }

  async handlePostComment(reply: vscode.CommentReply): Promise<void> {
    const { thread, text } = reply;
    if (!text.trim()) return;

    const ctx = this.activeDiffs.get(path.normalize(thread.uri.fsPath));
    if (!ctx) {
      void vscode.window.showErrorMessage(
        "Hareer: No active review context — open a file diff first.",
      );
      return;
    }

    const lineNumber = (thread.range?.start.line ?? 0) + 1;
    const meta = this.threadMeta.get(thread) ?? { hasPending: false };
    const isReply = meta.serverRootId !== undefined;

    const placeholder: vscode.Comment = {
      author: { name: "You (pending)" },
      body: new vscode.MarkdownString(`${text.trim()}\n\n*— pending review*`),
      mode: vscode.CommentMode.Preview,
      contextValue: "pendingComment",
    };
    thread.comments = [...thread.comments, placeholder];
    thread.label = isReply ? `${thread.comments.length} comments · 1 pending` : "Pending";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;

    const pending: PendingComment = {
      path: ctx.file.filename,
      line: lineNumber,
      body: text.trim(),
      inReplyToId: meta.serverRootId,
      thread,
      placeholder,
    };
    this.store.add(ctx.submodule.owner, ctx.submodule.repo, ctx.pr.number, pending);
    this.threadMeta.set(thread, { ...meta, hasPending: true });

    if (!ctx.threads.includes(thread)) {
      ctx.threads.push(thread);
    }
  }

  async deletePendingComment(thread: vscode.CommentThread): Promise<void> {
    const ctx = this.activeDiffs.get(path.normalize(thread.uri.fsPath));
    if (!ctx) return;
    const removed = this.store.removeByThread(
      ctx.submodule.owner,
      ctx.submodule.repo,
      ctx.pr.number,
      thread,
    );
    if (!removed) return;
    thread.comments = thread.comments.filter((c) => c !== removed.placeholder);
    if (thread.comments.length === 0) {
      thread.dispose();
      ctx.threads = ctx.threads.filter((t) => t !== thread);
    } else {
      const meta = this.threadMeta.get(thread);
      const serverRootId = meta?.serverRootId;
      thread.label =
        serverRootId !== undefined ? `${thread.comments.length} comments` : "Comment";
      this.threadMeta.set(thread, { serverRootId, hasPending: false });
    }
  }

  /**
   * Submit all pending comments for a PR as a single review with the chosen event.
   * Replies (to existing server comments) are posted individually with `in_reply_to`
   * because GitHub's `POST /reviews` payload does not support reply targets.
   */
  async submitPendingReview(
    submodule: Submodule,
    pr: PullRequest,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    summary: string,
  ): Promise<void> {
    const pending = this.store.get(submodule.owner, submodule.repo, pr.number);
    const replies = pending?.comments.filter((c) => c.inReplyToId !== undefined) ?? [];
    const newComments = pending?.comments.filter((c) => c.inReplyToId === undefined) ?? [];

    try {
      await Promise.all(
        replies.map((r) =>
          replyToReviewComment(
            submodule.owner,
            submodule.repo,
            pr.number,
            r.inReplyToId as number,
            r.body,
          ),
        ),
      );

      await submitReview({
        owner: submodule.owner,
        repo: submodule.repo,
        pullNumber: pr.number,
        event,
        body: summary,
        comments: newComments.map((c) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT",
          body: c.body,
        })),
      });

      // Clear all pending placeholders.
      const cleared = this.store.clear(submodule.owner, submodule.repo, pr.number);
      for (const c of cleared) {
        c.thread.comments = c.thread.comments.filter((x) => x !== c.placeholder);
        if (c.thread.comments.length === 0) c.thread.dispose();
      }

      // Reload server-side state so the new review appears.
      await this.reloadFileThreadsForPR(submodule, pr);

      void vscode.window.showInformationMessage(
        `Hareer: Review submitted on PR #${pr.number} — ${eventVerb(event)} with ${pending?.comments.length ?? 0} comment(s).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to submit review — ${msg}`);
    }
  }

  /**
   * Discard all pending comments for a PR. Disposes placeholder threads/comments locally;
   * nothing was sent to GitHub yet.
   */
  discardPendingReview(submodule: Submodule, pr: PullRequest): number {
    const cleared = this.store.clear(submodule.owner, submodule.repo, pr.number);
    for (const c of cleared) {
      c.thread.comments = c.thread.comments.filter((x) => x !== c.placeholder);
      if (c.thread.comments.length === 0) {
        c.thread.dispose();
      } else {
        const meta = this.threadMeta.get(c.thread);
        const serverRootId = meta?.serverRootId;
        c.thread.label =
          serverRootId !== undefined ? `${c.thread.comments.length} comments` : "Comment";
        if (meta) this.threadMeta.set(c.thread, { ...meta, hasPending: false });
      }
    }
    return cleared.length;
  }

  async promptSubmitReview(submodule: Submodule, pr: PullRequest): Promise<void> {
    const pendingCount = this.store.countFor(submodule.owner, submodule.repo, pr.number);

    const eventItems: vscode.QuickPickItem[] = [
      {
        label: "$(check) Approve",
        description: pendingCount > 0 ? `Submit ${pendingCount} comment(s) and approve` : "Submit an approving review",
      },
      {
        label: "$(request-changes) Request Changes",
        description: pendingCount > 0 ? `Submit ${pendingCount} comment(s) and request changes` : "Request changes before merging",
      },
      {
        label: "$(comment) Comment",
        description: pendingCount > 0 ? `Submit ${pendingCount} comment(s) only` : "Submit general feedback without verdict",
      },
    ];

    const picked = await vscode.window.showQuickPick(eventItems, {
      placeHolder:
        pendingCount > 0
          ? `Submit review with ${pendingCount} pending comment(s)`
          : "Choose review type (no pending comments)",
    });
    if (!picked) return;

    const summary = await vscode.window.showInputBox({
      prompt: "Review summary (optional — leave empty for no summary)",
      placeHolder: "Overall feedback on this PR…",
    });
    if (summary === undefined) return;

    const event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = picked.label.includes("Approve")
      ? "APPROVE"
      : picked.label.includes("Request")
        ? "REQUEST_CHANGES"
        : "COMMENT";

    await this.submitPendingReview(submodule, pr, event, summary);
  }

  /**
   * Submit the entire pending review with a verdict — invoked from a comment-thread
   * title bar button. Resolves the PR from the thread URI.
   */
  async handleSubmitReviewFromThread(
    thread: vscode.CommentThread,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  ): Promise<void> {
    const ctx = this.activeDiffs.get(path.normalize(thread.uri.fsPath));
    if (!ctx) {
      void vscode.window.showErrorMessage(
        "Hareer: No active review context — open a file diff first.",
      );
      return;
    }
    const summary = await vscode.window.showInputBox({
      prompt: `Review summary for "${eventVerb(event)}" (optional)`,
      placeHolder: "Overall feedback on this PR…",
    });
    if (summary === undefined) return;
    await this.submitPendingReview(ctx.submodule, ctx.pr, event, summary);
  }

  async promptDiscardReview(submodule: Submodule, pr: PullRequest): Promise<void> {
    const count = this.store.countFor(submodule.owner, submodule.repo, pr.number);
    if (count === 0) {
      void vscode.window.showInformationMessage("Hareer: No pending review to discard.");
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Discard ${count} pending comment(s) on PR #${pr.number}?`,
      { modal: true },
      "Discard",
    );
    if (confirmed !== "Discard") return;
    this.discardPendingReview(submodule, pr);
    void vscode.window.showInformationMessage(`Hareer: Discarded ${count} pending comment(s).`);
  }

  /**
   * Standalone immediate comment — bypasses the pending review. Mostly for backwards
   * compatibility; the pending flow is preferred.
   */
  async postImmediateComment(
    submodule: Submodule,
    pr: PullRequest,
    file: PRFile,
    headSha: string,
    line: number,
    body: string,
  ): Promise<void> {
    await createReviewComment(submodule.owner, submodule.repo, pr.number, headSha, file.filename, line, body);
  }

  pendingCountFor(submodule: Submodule, pr: PullRequest): number {
    return this.store.countFor(submodule.owner, submodule.repo, pr.number);
  }

  /**
   * Re-fetch comments for the PR and rebuild any currently-open file threads from
   * the new server state. Called after a successful submit.
   */
  private async reloadFileThreadsForPR(submodule: Submodule, pr: PullRequest): Promise<void> {
    const matching: ActiveDiffContext[] = [];
    for (const ctx of this.activeDiffs.values()) {
      if (
        ctx.submodule.name === submodule.name &&
        ctx.pr.number === pr.number
      ) {
        matching.push(ctx);
      }
    }
    for (const ctx of matching) {
      await this.loadCommentsForFile(ctx.submodule, ctx.pr, ctx.file, ctx.headSha, ctx.headFileUri);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const ctx of this.activeDiffs.values()) {
      for (const t of ctx.threads) t.dispose();
    }
    this._onDidChangePending.dispose();
  }
}

function eventVerb(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): string {
  switch (event) {
    case "APPROVE":
      return "Approved";
    case "REQUEST_CHANGES":
      return "Changes requested";
    case "COMMENT":
      return "Commented";
  }
}

function buildVscodeComment(c: ReviewComment): vscode.Comment {
  const md = new vscode.MarkdownString(
    `**@${c.user}** · ${new Date(c.createdAt).toLocaleString()}\n\n${c.body}`,
  );
  md.isTrusted = false;
  return {
    author: { name: `@${c.user}` },
    body: md,
    mode: vscode.CommentMode.Preview,
  };
}
