import * as vscode from "vscode";
import type { PRFile } from "./types";

export interface DiffCommentLines {
  readonly right: ReadonlySet<number>;
  readonly left: ReadonlySet<number>;
}

/** Lines in the head/base blob that appear in the PR unified diff hunks. */
export function parsePatchCommentLines(patch: string): DiffCommentLines {
  const right = new Set<number>();
  const left = new Set<number>();
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldLine = Number.parseInt(match[1] ?? "0", 10);
        newLine = Number.parseInt(match[2] ?? "0", 10);
      }
      continue;
    }
    if (raw.startsWith("\\")) continue;

    const prefix = raw[0];
    if (prefix === "+") {
      right.add(newLine);
      newLine += 1;
    } else if (prefix === "-") {
      left.add(oldLine);
      oldLine += 1;
    } else if (prefix === " ") {
      right.add(newLine);
      left.add(oldLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return { right, left };
}

/** Merge consecutive 1-based line numbers into VS Code commenting ranges. */
export function rangesFromCommentLines(lines: ReadonlySet<number>): vscode.Range[] {
  if (lines.size === 0) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: vscode.Range[] = [];
  let rangeStart = sorted[0] ?? 1;
  let rangeEnd = rangeStart;

  for (let i = 1; i < sorted.length; i += 1) {
    const line = sorted[i] ?? rangeEnd;
    if (line === rangeEnd + 1) {
      rangeEnd = line;
      continue;
    }
    ranges.push(new vscode.Range(rangeStart - 1, 0, rangeEnd - 1, Number.MAX_SAFE_INTEGER));
    rangeStart = line;
    rangeEnd = line;
  }

  ranges.push(new vscode.Range(rangeStart - 1, 0, rangeEnd - 1, Number.MAX_SAFE_INTEGER));
  return ranges;
}

export function commentableRightLinesForFile(
  patch: string | undefined,
  fileStatus: string,
  headLineCount: number,
): ReadonlySet<number> {
  if (patch) return parsePatchCommentLines(patch).right;
  if (fileStatus === "added" && headLineCount > 0) {
    return new Set(Array.from({ length: headLineCount }, (_, i) => i + 1));
  }
  return new Set();
}

export function isLineInFileDiff(file: PRFile | undefined, line: number): boolean {
  if (!file) return false;
  if (file.patch) return parsePatchCommentLines(file.patch).right.has(line);
  if (file.status === "added") return line >= 1;
  return false;
}

export function fileByPath(files: readonly PRFile[], path: string): PRFile | undefined {
  return files.find((f) => f.filename === path);
}
