import * as path from "node:path";
import * as vscode from "vscode";
import { createReviewComment, fetchPRComments, submitReview } from "./github-api";
import type { PRFile, PullRequest, ReviewComment, Submodule } from "./types";

interface ActiveDiffContext {
  submodule: Submodule;
  pr: PullRequest;
  file: PRFile;
  headSha: string;
  headFileUri: vscode.Uri;
  threads: vscode.CommentThread[];
}

export class HareerCommentProvider implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly activeDiffs = new Map<string, ActiveDiffContext>();

  constructor() {
    this.controller = vscode.comments.createCommentController(
      "hareerReview",
      "Hareer Code Review",
    );

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument, _token: vscode.CancellationToken) => {
        if (this.activeDiffs.has(path.normalize(document.uri.fsPath))) {
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
        return undefined;
      },
    };

    this.disposables.push(this.controller);
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
      threads: [],
    };
    this.activeDiffs.set(key, ctx);

    let comments: ReviewComment[];
    try {
      comments = await fetchPRComments(submodule.owner, submodule.repo, pr.number);
    } catch {
      return;
    }

    for (const comment of comments.filter((c) => c.path === file.filename)) {
      const lineIndex = Math.max(0, comment.line - 1);
      const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
      const thread = this.controller.createCommentThread(headFileUri, range, [
        buildVscodeComment(comment),
      ]);
      thread.label = `@${comment.user}`;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = true;
      ctx.threads.push(thread);
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

    try {
      await createReviewComment(
        ctx.submodule.owner,
        ctx.submodule.repo,
        ctx.pr.number,
        ctx.headSha,
        ctx.file.filename,
        lineNumber,
        text.trim(),
      );

      const newComment: vscode.Comment = {
        author: { name: "You" },
        body: new vscode.MarkdownString(text.trim()),
        mode: vscode.CommentMode.Preview,
      };

      thread.comments = [...thread.comments, newComment];

      if (!ctx.threads.includes(thread)) {
        thread.label = "You";
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.canReply = true;
        ctx.threads.push(thread);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to post comment — ${msg}`);
    }
  }

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

    const eventLabel: Record<typeof event, string> = {
      APPROVE: "Approve",
      REQUEST_CHANGES: "Request Changes",
      COMMENT: "Comment",
    };

    const body = await vscode.window.showInputBox({
      prompt: `Review summary for "${eventLabel[event]}" (optional)`,
      placeHolder: "Leave a summary comment for this review…",
    });
    if (body === undefined) return;

    try {
      await submitReview({
        owner: ctx.submodule.owner,
        repo: ctx.submodule.repo,
        pullNumber: ctx.pr.number,
        event,
        body: body ?? "",
        comments: [],
      });
      void vscode.window.showInformationMessage(
        `Hareer: Review submitted — ${eventLabel[event]} on PR #${ctx.pr.number}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to submit review — ${msg}`);
    }
  }

  async promptSubmitReview(submodule: Submodule, pr: PullRequest): Promise<void> {
    const eventItems: vscode.QuickPickItem[] = [
      { label: "$(check) Approve", description: "Submit an approving review" },
      { label: "$(request-changes) Request Changes", description: "Request changes before merging" },
      { label: "$(comment) Comment", description: "Submit general feedback without approval" },
    ];

    const picked = await vscode.window.showQuickPick(eventItems, {
      placeHolder: "Choose review type",
    });
    if (!picked) return;

    const body = await vscode.window.showInputBox({
      prompt: "Review summary (optional)",
      placeHolder: "Leave a summary comment for this review…",
    });
    if (body === undefined) return;

    let event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    if (picked.label.includes("Approve")) event = "APPROVE";
    else if (picked.label.includes("Request")) event = "REQUEST_CHANGES";
    else event = "COMMENT";

    try {
      await submitReview({
        owner: submodule.owner,
        repo: submodule.repo,
        pullNumber: pr.number,
        event,
        body: body ?? "",
        comments: [],
      });
      void vscode.window.showInformationMessage(
        `Hareer: Review submitted for PR #${pr.number} (${event})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to submit review — ${msg}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const ctx of this.activeDiffs.values()) {
      for (const t of ctx.threads) t.dispose();
    }
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
