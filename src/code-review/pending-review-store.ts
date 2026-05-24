import * as vscode from "vscode";

export interface PendingComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
  readonly inReplyToId?: number;
  readonly thread: vscode.CommentThread;
  readonly placeholder: vscode.Comment;
}

export interface PendingReview {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  comments: PendingComment[];
}

function keyFor(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

export class PendingReviewStore {
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  readonly onDidChange = this._onDidChange.event;

  private readonly byPr = new Map<string, PendingReview>();

  ensure(owner: string, repo: string, prNumber: number): PendingReview {
    const k = keyFor(owner, repo, prNumber);
    let pr = this.byPr.get(k);
    if (!pr) {
      pr = { owner, repo, prNumber, comments: [] };
      this.byPr.set(k, pr);
    }
    return pr;
  }

  get(owner: string, repo: string, prNumber: number): PendingReview | undefined {
    return this.byPr.get(keyFor(owner, repo, prNumber));
  }

  countFor(owner: string, repo: string, prNumber: number): number {
    return this.byPr.get(keyFor(owner, repo, prNumber))?.comments.length ?? 0;
  }

  add(
    owner: string,
    repo: string,
    prNumber: number,
    comment: PendingComment,
  ): void {
    const pr = this.ensure(owner, repo, prNumber);
    pr.comments.push(comment);
    this._onDidChange.fire(keyFor(owner, repo, prNumber));
  }

  removeByThread(
    owner: string,
    repo: string,
    prNumber: number,
    thread: vscode.CommentThread,
  ): PendingComment | undefined {
    const pr = this.byPr.get(keyFor(owner, repo, prNumber));
    if (!pr) return undefined;
    const idx = pr.comments.findIndex((c) => c.thread === thread);
    if (idx === -1) return undefined;
    const [removed] = pr.comments.splice(idx, 1);
    this._onDidChange.fire(keyFor(owner, repo, prNumber));
    return removed;
  }

  clear(owner: string, repo: string, prNumber: number): PendingComment[] {
    const k = keyFor(owner, repo, prNumber);
    const pr = this.byPr.get(k);
    if (!pr) return [];
    const comments = pr.comments;
    this.byPr.delete(k);
    this._onDidChange.fire(k);
    return comments;
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.byPr.clear();
  }
}
