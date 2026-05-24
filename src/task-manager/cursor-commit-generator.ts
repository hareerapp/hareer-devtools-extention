import * as vscode from "vscode";
import { parseGeneratedCommitMessage } from "./commit-naming";
import type { Repository } from "./git-operations";
import { findRepositoryByRoot, hasStagedChanges, stageAll } from "./git-operations";
import type { CommitType } from "./types";

const CURSOR_GENERATE_COMMAND = "cursor.generateGitCommitMessage";
const POLL_INTERVAL_MS = 200;
const GENERATE_TIMEOUT_MS = 30_000;
const SCM_SETTLE_MS = 350;

export interface GeneratedCommitDraft {
  readonly type: CommitType;
  readonly scope?: string;
  readonly subject: string;
  readonly body?: string;
}

export function isCursorIDE(): boolean {
  return vscode.env.appName.toLowerCase().includes("cursor");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cursorGenerateCommandExists(): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  return commands.includes(CURSOR_GENERATE_COMMAND);
}

async function waitForScmInputChange(
  repo: Repository,
  previous: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  const prior = previous.trim();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const current = repo.inputBox.value.trim();
    if (current.length > 0 && current !== prior) {
      return current;
    }
  }
  return undefined;
}

/**
 * Uses Cursor's built-in commit message generator (SCM sparkle button) by
 * invoking its command and reading the result from the Git input box.
 * Cursor-only; throws if unavailable or generation times out.
 */
export async function generateCommitMessageViaCursor(
  repo: Repository,
  stageAllFirst: boolean,
): Promise<GeneratedCommitDraft> {
  if (!isCursorIDE()) {
    throw new Error("AI commit generation is only available in Cursor.");
  }
  if (!(await cursorGenerateCommandExists())) {
    throw new Error("Cursor commit generator command is not available.");
  }

  const resolved =
    (await findRepositoryByRoot(repo.rootUri.fsPath)) ?? repo;

  if (stageAllFirst) {
    await stageAll(resolved);
    await sleep(SCM_SETTLE_MS);
  }

  if (!(await hasStagedChanges(resolved))) {
    throw new Error("Stage changes first — Cursor generates messages from the staged diff.");
  }

  const previousInput = resolved.inputBox.value;
  try {
    await vscode.commands.executeCommand("workbench.view.scm");
    // Cursor targets the first SCM repo when rootUri is omitted — pass it explicitly
    // so submodule repos get the correct staged diff and input box.
    await vscode.commands.executeCommand(CURSOR_GENERATE_COMMAND, resolved.rootUri);

    const generated = await waitForScmInputChange(resolved, previousInput, GENERATE_TIMEOUT_MS);
    if (!generated) {
      throw new Error("Timed out waiting for Cursor to generate a commit message.");
    }

    return parseGeneratedCommitMessage(generated);
  } finally {
    resolved.inputBox.value = previousInput;
  }
}
