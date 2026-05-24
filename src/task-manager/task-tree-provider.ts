import * as vscode from "vscode";
import type { TaskService } from "./task-service";
import type { ClickUpStatus, ClickUpTask, ClickUpUser } from "./types";

export type TaskTreeNode =
  | { readonly kind: "message"; readonly text: string; readonly icon?: vscode.ThemeIcon }
  | { readonly kind: "section"; readonly title: string; readonly section: "mine" | "team" }
  | { readonly kind: "statusGroup"; readonly status: ClickUpStatus; readonly tasks: readonly ClickUpTask[] }
  | { readonly kind: "teammate"; readonly user: ClickUpUser }
  | { readonly kind: "task"; readonly task: ClickUpTask };

interface StatusBucket {
  readonly status: ClickUpStatus;
  readonly tasks: ClickUpTask[];
}

function groupByStatus(tasks: readonly ClickUpTask[]): StatusBucket[] {
  const buckets = new Map<string, StatusBucket>();
  for (const task of tasks) {
    const key = task.status.status;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { status: task.status, tasks: [] };
      buckets.set(key, bucket);
    }
    bucket.tasks.push(task);
  }
  return Array.from(buckets.values()).sort((a, b) => {
    const ai = a.status.orderindex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.status.orderindex ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

function hasLinkedPR(task: ClickUpTask, prFieldName: string): boolean {
  const wanted = prFieldName.toLowerCase();
  const field = task.customFields.find((f) => f.name.toLowerCase() === wanted);
  if (!field) return false;
  const value = field.value;
  if (typeof value === "string" && value.trim().length > 0) return true;
  if (value && typeof value === "object" && "url" in (value as Record<string, unknown>)) {
    const url = (value as Record<string, unknown>).url;
    return typeof url === "string" && url.length > 0;
  }
  return false;
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly service: TaskService) {
    service.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(node: TaskTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "message": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = node.icon;
        return item;
      }
      case "section": {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.section === "mine" ? "person" : "organization");
        item.contextValue = `taskSection.${node.section}`;
        return item;
      }
      case "statusGroup": {
        const item = new vscode.TreeItem(
          `${node.status.status}  (${node.tasks.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.foreground"));
        item.tooltip = `${node.status.status} — ${node.status.type}`;
        return item;
      }
      case "teammate": {
        const item = new vscode.TreeItem(
          node.user.username,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `teammate:${node.user.id}`;
        item.description = node.user.email;
        item.iconPath = new vscode.ThemeIcon("account");
        item.tooltip = `${node.user.username} <${node.user.email}>`;
        item.contextValue = "teammate";
        return item;
      }
      case "task": {
        const { task } = node;
        const prFieldName = vscode.workspace
          .getConfiguration("hareer.clickup")
          .get<string>("prUrlFieldName", "Github PR Url");
        const hasPR = hasLinkedPR(task, prFieldName);
        const item = new vscode.TreeItem(task.name, vscode.TreeItemCollapsibleState.None);
        item.id = `task:${task.id}`;
        item.description = task.customId ?? task.id;
        item.tooltip = new vscode.MarkdownString(
          `**${task.name}**\n\nStatus: ${task.status.status}\n\nList: ${task.list.name}`,
        );
        item.iconPath = new vscode.ThemeIcon(hasPR ? "git-branch" : "circle-large-outline");
        item.contextValue = hasPR ? "task.withPR" : "task.noPR";
        item.command = {
          command: "hareer.openTaskDetail",
          title: "Open Task",
          arguments: [task.id],
        };
        return item;
      }
    }
  }

  getChildren(element?: TaskTreeNode): TaskTreeNode[] {
    if (element === undefined) {
      return this.topLevel();
    }
    switch (element.kind) {
      case "section": {
        if (element.section === "mine") return this.myTaskGroups();
        if (element.section === "team") return this.teamMembers();
        return [];
      }
      case "statusGroup": {
        return element.tasks.map((task) => ({ kind: "task", task }));
      }
      case "teammate": {
        return this.teammateGroups(element.user);
      }
      default:
        return [];
    }
  }

  private topLevel(): TaskTreeNode[] {
    if (this.service.isLoading()) {
      return [{ kind: "message", text: "Loading tasks…", icon: new vscode.ThemeIcon("loading~spin") }];
    }
    const error = this.service.getError();
    if (error) {
      return [{ kind: "message", text: error, icon: new vscode.ThemeIcon("error") }];
    }
    const snap = this.service.getSnapshot();
    if (!snap) return [];
    const sections: TaskTreeNode[] = [
      { kind: "section", title: "My Tasks", section: "mine" },
    ];
    if (this.service.getTeammates().length > 0) {
      sections.push({ kind: "section", title: "Team", section: "team" });
    }
    return sections;
  }

  private myTaskGroups(): TaskTreeNode[] {
    const snap = this.service.getSnapshot();
    if (!snap || snap.myTasks.length === 0) {
      return [{ kind: "message", text: "No tasks assigned to you.", icon: new vscode.ThemeIcon("inbox") }];
    }
    return groupByStatus(snap.myTasks).map((bucket) => ({
      kind: "statusGroup",
      status: bucket.status,
      tasks: bucket.tasks,
    }));
  }

  private teamMembers(): TaskTreeNode[] {
    const teammates = this.service.getTeammates();
    if (teammates.length === 0) {
      return [{ kind: "message", text: "No teammates in this workspace." }];
    }
    return teammates
      .slice()
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((user) => ({ kind: "teammate", user }));
  }

  private teammateGroups(user: ClickUpUser): TaskTreeNode[] {
    const state = this.service.getTeammateState(user.id);
    if (state.tasks === undefined && !state.loading) {
      void this.service.loadTeammateTasks(user.id);
      return [{ kind: "message", text: "Loading…", icon: new vscode.ThemeIcon("loading~spin") }];
    }
    if (state.loading) {
      return [{ kind: "message", text: "Loading…", icon: new vscode.ThemeIcon("loading~spin") }];
    }
    if (state.error) {
      return [{ kind: "message", text: state.error, icon: new vscode.ThemeIcon("error") }];
    }
    const tasks = state.tasks ?? [];
    if (tasks.length === 0) {
      return [{ kind: "message", text: "No open tasks.", icon: new vscode.ThemeIcon("inbox") }];
    }
    return groupByStatus(tasks).map((bucket) => ({
      kind: "statusGroup",
      status: bucket.status,
      tasks: bucket.tasks,
    }));
  }
}
