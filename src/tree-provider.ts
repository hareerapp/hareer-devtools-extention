import * as vscode from "vscode";
import type { MakefileGroup, MakefileTarget } from "./makefile-parser";

export type HareerTreeNode =
  | { readonly kind: "group"; readonly index: number }
  | {
      readonly kind: "target";
      readonly groupIndex: number;
      readonly targetIndex: number;
      readonly target: MakefileTarget;
    };

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export class HareerTreeProvider implements vscode.TreeDataProvider<HareerTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HareerTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: readonly MakefileGroup[] = [];

  setGroups(groups: readonly MakefileGroup[]): void {
    this.groups = groups;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: HareerTreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const g = this.groups[node.index];
      const item = new vscode.TreeItem(
        g?.title ?? "(unknown)",
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }

    const { target } = node;
    const item = new vscode.TreeItem(target.name, vscode.TreeItemCollapsibleState.None);
    if (target.description.length > 0) {
      item.description = truncateMiddle(target.description, 56);
      item.tooltip = target.description;
    } else {
      item.tooltip = `make ${target.name}`;
    }
    item.iconPath = new vscode.ThemeIcon("play");
    item.command = {
      command: "hareer.runTarget",
      title: "Run Make Target",
      arguments: [target.name],
    };
    return item;
  }

  getChildren(element?: HareerTreeNode): HareerTreeNode[] {
    if (element === undefined) {
      return this.groups.map((_, index) => ({ kind: "group", index } satisfies HareerTreeNode));
    }
    if (element.kind === "group") {
      const g = this.groups[element.index];
      if (!g) return [];
      return g.targets.map(
        (target, targetIndex) =>
          ({
            kind: "target",
            groupIndex: element.index,
            targetIndex,
            target,
          }) satisfies HareerTreeNode,
      );
    }
    return [];
  }

  getParent(element: HareerTreeNode): vscode.ProviderResult<HareerTreeNode> {
    if (element.kind === "group") {
      return undefined;
    }
    return { kind: "group", index: element.groupIndex };
  }
}
