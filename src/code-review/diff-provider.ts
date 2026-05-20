import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { fetchFileContent } from "./github-api";
import type { CodeReviewNode } from "./code-review-provider";
import type { PRFile, PullRequest, Submodule } from "./types";

const tempFiles = new Set<string>();

function sanitizePath(filePath: string): string {
  return filePath.replace(/[/\\]/g, "_");
}

function writeTempFile(prefix: string, content: string): string {
  const filePath = path.join(os.tmpdir(), `hareer-${prefix}`);
  fs.writeFileSync(filePath, content, "utf-8");
  tempFiles.add(filePath);
  return filePath;
}

export function cleanupTempFiles(): void {
  for (const f of tempFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tempFiles.clear();
}

export async function openDiff(
  node: CodeReviewNode,
  onBeforeDiffOpen: (
    submodule: Submodule,
    pr: PullRequest,
    file: PRFile,
    headSha: string,
    headUri: vscode.Uri,
  ) => Promise<void>,
): Promise<void> {
  if (node.kind !== "file") return;

  const { submodule, pr, file } = node;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Loading diff: ${file.filename}`,
      cancellable: false,
    },
    async () => {
      const [baseContent, headContent] = await Promise.all([
        file.status === "added"
          ? Promise.resolve("")
          : fetchFileContent(submodule.owner, submodule.repo, file.filename, pr.baseSha),
        file.status === "removed"
          ? Promise.resolve("")
          : fetchFileContent(
              submodule.owner,
              submodule.repo,
              file.status === "renamed" && file.previousFilename
                ? file.previousFilename
                : file.filename,
              pr.headSha,
            ),
      ]);

      const safeName = sanitizePath(file.filename);
      const ext = path.extname(file.filename);

      const baseFile = writeTempFile(`base-${safeName}${ext ? "" : ".txt"}`, baseContent);
      const headFile = writeTempFile(`head-${safeName}${ext ? "" : ".txt"}`, headContent);

      const baseUri = vscode.Uri.file(baseFile);
      const headUri = vscode.Uri.file(headFile);

      // Register comments BEFORE opening the diff so provideCommentingRanges
      // sees the URI when VS Code queries it during editor activation.
      await onBeforeDiffOpen(submodule, pr, file, pr.headSha, headUri);

      const title = `${path.basename(file.filename)} (${pr.baseRef} ↔ ${pr.headRef})`;
      await vscode.commands.executeCommand("vscode.diff", baseUri, headUri, title);
    },
  );
}
