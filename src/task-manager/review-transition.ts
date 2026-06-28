import * as vscode from "vscode";
import { getClickUpToken } from "./auth";
import { getTask, updateTaskStatus } from "./clickup-api";
import { deriveScopeFromBranch } from "./commit-naming";
import { getLinkedPR } from "./pr-url-field";
import type { TaskService } from "./task-service";
import type { ClickUpTask } from "./types";

export interface ReviewedPR {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headRef: string;
}

/**
 * Move the ClickUp task linked to a reviewed PR to `targetStatus`. Gated by the
 * shared `hareer.clickup.autoTransition` setting so all auto-transitions share
 * one opt-in. Best-effort and silent: a missing token, an unresolvable task, or
 * a status name that doesn't exist in the workspace is ignored.
 */
export async function transitionTaskForReview(
  context: vscode.ExtensionContext,
  service: TaskService,
  pr: ReviewedPR,
  targetStatus: string,
): Promise<void> {
  const auto = vscode.workspace
    .getConfiguration("hareer.clickup")
    .get<boolean>("autoTransition", true);
  if (!auto) return;

  const token = await getClickUpToken(context);
  if (!token) return;

  const task = await findLinkedTask(token, service, pr);
  if (!task) return;
  if (task.status.status.toLowerCase() === targetStatus.toLowerCase()) return;

  try {
    await updateTaskStatus(token, task.id, targetStatus);
    void service.refresh(true);
  } catch {
    /* status name may not exist in this workspace — stay silent */
  }
}

async function findLinkedTask(
  token: string,
  service: TaskService,
  pr: ReviewedPR,
): Promise<ClickUpTask | undefined> {
  // 1) Branch convention `{type}/{clickup-id}-{slug}` — resolve the id directly.
  const branchId = deriveScopeFromBranch(pr.headRef);
  if (branchId) {
    try {
      return await getTask(token, branchId);
    } catch {
      /* not a resolvable id (e.g. a custom id containing dashes) — fall back */
    }
  }

  // 2) Match the PR-URL custom field across tasks already in memory.
  const fieldName = vscode.workspace
    .getConfiguration("hareer.clickup")
    .get<string>("prUrlFieldName", "Github PR Url");
  for (const task of service.getAllKnownTasks()) {
    const linked = getLinkedPR(task, fieldName);
    if (linked && linked.owner === pr.owner && linked.repo === pr.repo && linked.number === pr.number) {
      return task;
    }
  }
  return undefined;
}
