import * as vscode from "vscode";
import { getOpenPRs, getPRFiles } from "./pr-cache";
import { checkoutPRBranch } from "./git-checkout";
import type { PRFile, PullRequest, Submodule } from "./types";

export type CodeReviewNode =
  | { readonly kind: "submodule"; readonly submodule: Submodule }
  | { readonly kind: "prSelector"; readonly submodule: Submodule }
  | {
      readonly kind: "folder";
      readonly submodule: Submodule;
      readonly pr: PullRequest;
      readonly folderPath: string;
    }
  | {
      readonly kind: "file";
      readonly submodule: Submodule;
      readonly pr: PullRequest;
      readonly file: PRFile;
    };

interface FolderTree {
  folders: Map<string, FolderTree>;
  files: PRFile[];
}

function buildFolderTree(files: PRFile[]): FolderTree {
  const root: FolderTree = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.filename.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.folders.has(seg)) {
        node.folders.set(seg, { folders: new Map(), files: [] });
      }
      node = node.folders.get(seg)!;
    }
    node.files.push(file);
  }
  return root;
}

function getSubtreeAt(root: FolderTree, folderPath: string): FolderTree | undefined {
  if (folderPath === "") return root;
  const parts = folderPath.split("/");
  let node: FolderTree | undefined = root;
  for (const seg of parts) {
    node = node?.folders.get(seg);
  }
  return node;
}

interface SubmoduleState {
  selectedPR: PullRequest | undefined;
  files: PRFile[];
  folderTree: FolderTree;
  loading: boolean;
}

export class CodeReviewProvider implements vscode.TreeDataProvider<CodeReviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    CodeReviewNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private submodules: Submodule[] = [];
  private readonly state = new Map<string, SubmoduleState>();
  private pendingCountFor: (submodule: Submodule, pr: PullRequest) => number = () => 0;
  private onPRSelected: (submodule: Submodule, pr: PullRequest) => void = () => {};

  setPendingCountResolver(
    resolver: (submodule: Submodule, pr: PullRequest) => number,
  ): void {
    this.pendingCountFor = resolver;
  }

  setOnPRSelected(handler: (submodule: Submodule, pr: PullRequest) => void): void {
    this.onPRSelected = handler;
  }

  setSubmodules(submodules: Submodule[]): void {
    this.submodules = submodules;
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getSelectedPR(submodule: Submodule): PullRequest | undefined {
    return this.state.get(submodule.name)?.selectedPR;
  }

  async selectPR(submodule: Submodule): Promise<void> {
    const st = this.ensureState(submodule);
    st.loading = true;
    this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });

    let prs: PullRequest[];
    try {
      prs = await getOpenPRs(submodule.owner, submodule.repo);
    } catch (err) {
      st.loading = false;
      this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to fetch PRs — ${msg}`);
      return;
    }

    const items: vscode.QuickPickItem[] = [
      {
        label: "$(edit) Enter PR number…",
        alwaysShow: true,
        description: "Type a pull request number",
      },
      ...prs.map((pr) => ({
        label: `#${pr.number}: ${pr.title}`,
        description: `${pr.headRef} → ${pr.baseRef}`,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Select a pull request for ${submodule.repo}`,
      matchOnDescription: true,
    });

    if (!picked) {
      st.loading = false;
      this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
      return;
    }

    let selectedPR: PullRequest | undefined;

    if (picked.label.startsWith("$(edit)")) {
      const input = await vscode.window.showInputBox({
        prompt: "Enter pull request number",
        placeHolder: "e.g. 42",
        validateInput: (v: string) => (/^\d+$/.test(v.trim()) ? undefined : "Must be a number"),
      });
      if (!input) {
        st.loading = false;
        this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
        return;
      }
      const num = parseInt(input.trim(), 10);
      try {
        const { fetchPRByNumber } = await import("./github-api");
        selectedPR = await fetchPRByNumber(submodule.owner, submodule.repo, num);
      } catch (err) {
        st.loading = false;
        this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Hareer: PR #${num} not found — ${msg}`);
        return;
      }
    } else {
      const match = picked.label.match(/^#(\d+):/);
      if (!match) {
        st.loading = false;
        this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
        return;
      }
      const num = parseInt(match[1], 10);
      selectedPR = prs.find((pr) => pr.number === num);
    }

    if (!selectedPR) {
      st.loading = false;
      this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
      return;
    }

    let files: PRFile[];
    try {
      files = await getPRFiles(submodule.owner, submodule.repo, selectedPR.number);
    } catch (err) {
      st.loading = false;
      this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to fetch PR files — ${msg}`);
      return;
    }

    st.selectedPR = selectedPR;
    st.files = files;
    st.folderTree = buildFolderTree(files);
    st.loading = false;
    this._onDidChangeTreeData.fire(undefined);

    // Open the PR detail panel immediately; don't make the user click the row.
    this.onPRSelected(submodule, selectedPR);

    await checkoutPRBranch(submodule, selectedPR.headRef);
  }

  async selectPRByNumber(
    submodule: Submodule,
    prNumber: number,
    openDetail: boolean,
  ): Promise<void> {
    const st = this.ensureState(submodule);
    st.loading = true;
    this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });

    const { fetchPRByNumber } = await import("./github-api");
    let pr: PullRequest;
    try {
      pr = await fetchPRByNumber(submodule.owner, submodule.repo, prNumber);
    } catch (err) {
      st.loading = false;
      this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: PR #${prNumber} not found — ${msg}`);
      return;
    }

    let files: PRFile[];
    try {
      files = await getPRFiles(submodule.owner, submodule.repo, prNumber);
    } catch (err) {
      st.loading = false;
      this._onDidChangeTreeData.fire({ kind: "prSelector", submodule });
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Hareer: Failed to fetch PR files — ${msg}`);
      return;
    }

    st.selectedPR = pr;
    st.files = files;
    st.folderTree = buildFolderTree(files);
    st.loading = false;
    this._onDidChangeTreeData.fire(undefined);

    // Reveal the PR row in the tree.
    void this._onDidChangeTreeData.fire(undefined);

    if (openDetail) {
      this.onPRSelected(submodule, pr);
    }
    await checkoutPRBranch(submodule, pr.headRef);
  }

  private ensureState(submodule: Submodule): SubmoduleState {
    let st = this.state.get(submodule.name);
    if (!st) {
      st = {
        selectedPR: undefined,
        files: [],
        folderTree: { folders: new Map(), files: [] },
        loading: false,
      };
      this.state.set(submodule.name, st);
    }
    return st;
  }

  getTreeItem(node: CodeReviewNode): vscode.TreeItem {
    switch (node.kind) {
      case "submodule": {
        const item = new vscode.TreeItem(
          node.submodule.path,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "submodule";
        item.tooltip = node.submodule.url;
        return item;
      }

      case "prSelector": {
        const st = this.state.get(node.submodule.name);

        if (st?.loading) {
          const item = new vscode.TreeItem(
            "Loading pull requests…",
            vscode.TreeItemCollapsibleState.None,
          );
          item.iconPath = new vscode.ThemeIcon("loading~spin");
          item.contextValue = "prSelectorLoading";
          return item;
        }

        if (st?.selectedPR) {
          const { selectedPR } = st;
          const collapsible =
            st.files.length > 0
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.None;
          const pendingCount = this.pendingCountFor(node.submodule, selectedPR);
          const item = new vscode.TreeItem(
            `#${selectedPR.number}: ${selectedPR.title}`,
            collapsible,
          );
          item.iconPath = new vscode.ThemeIcon("git-pull-request");
          const baseDesc = `${selectedPR.baseRef} ← ${selectedPR.headRef}`;
          item.description =
            pendingCount > 0 ? `${baseDesc}  ·  ${pendingCount} pending` : baseDesc;
          item.tooltip = selectedPR.url;
          item.contextValue = pendingCount > 0 ? "prSelectorActivePending" : "prSelectorActive";
          item.command = {
            command: "hareer.openPRDetail",
            title: "Open Pull Request",
            arguments: [node.submodule, selectedPR.number],
          };
          return item;
        }

        const item = new vscode.TreeItem(
          "Select pull request…",
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon("git-pull-request");
        item.description = "click to choose";
        item.contextValue = "prSelector";
        item.command = {
          command: "hareer.selectPR",
          title: "Select Pull Request",
          arguments: [node],
        };
        return item;
      }

      case "folder": {
        const folderName = node.folderPath.split("/").pop() ?? node.folderPath;
        const item = new vscode.TreeItem(
          folderName,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "folder";
        return item;
      }

      case "file": {
        const { file } = node;
        const fileName = file.filename.split("/").pop() ?? file.filename;
        const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
        item.iconPath = fileStatusIcon(file.status);
        item.description = fileStatusLabel(file.status);
        item.tooltip = file.filename;
        item.contextValue = "file";
        item.command = {
          command: "hareer.openDiff",
          title: "Open Diff",
          arguments: [node],
        };
        return item;
      }
    }
  }

  getChildren(element?: CodeReviewNode): CodeReviewNode[] {
    if (element === undefined) {
      return this.submodules.map((submodule) => ({ kind: "submodule", submodule }));
    }

    switch (element.kind) {
      case "submodule": {
        return [{ kind: "prSelector", submodule: element.submodule }];
      }

      case "prSelector": {
        const st = this.state.get(element.submodule.name);
        if (!st?.selectedPR) return [];
        return folderChildren("", st.folderTree, element.submodule, st.selectedPR);
      }

      case "folder": {
        const st = this.state.get(element.submodule.name);
        if (!st?.selectedPR) return [];
        const subtree = getSubtreeAt(st.folderTree, element.folderPath);
        if (!subtree) return [];
        return folderChildren(element.folderPath, subtree, element.submodule, element.pr);
      }

      case "file":
        return [];
    }
  }

  getParent(element: CodeReviewNode): CodeReviewNode | undefined {
    switch (element.kind) {
      case "submodule":
        return undefined;
      case "prSelector":
        return { kind: "submodule", submodule: element.submodule };
      case "folder": {
        const parts = element.folderPath.split("/");
        if (parts.length === 1) {
          return { kind: "prSelector", submodule: element.submodule };
        }
        const parentPath = parts.slice(0, -1).join("/");
        return {
          kind: "folder",
          submodule: element.submodule,
          pr: element.pr,
          folderPath: parentPath,
        };
      }
      case "file": {
        const parts = element.file.filename.split("/");
        if (parts.length === 1) {
          return { kind: "prSelector", submodule: element.submodule };
        }
        const parentPath = parts.slice(0, -1).join("/");
        return {
          kind: "folder",
          submodule: element.submodule,
          pr: element.pr,
          folderPath: parentPath,
        };
      }
    }
  }
}

function folderChildren(
  basePath: string,
  tree: FolderTree,
  submodule: Submodule,
  pr: PullRequest,
): CodeReviewNode[] {
  const nodes: CodeReviewNode[] = [];

  for (const [seg] of tree.folders) {
    const childPath = basePath ? `${basePath}/${seg}` : seg;
    nodes.push({ kind: "folder", submodule, pr, folderPath: childPath });
  }

  for (const file of tree.files) {
    nodes.push({ kind: "file", submodule, pr, file });
  }

  return nodes;
}

function fileStatusIcon(status: PRFile["status"]): vscode.ThemeIcon {
  switch (status) {
    case "added":
      return new vscode.ThemeIcon("diff-added");
    case "removed":
      return new vscode.ThemeIcon("diff-removed");
    case "renamed":
      return new vscode.ThemeIcon("diff-renamed");
    case "modified":
    case "changed":
    default:
      return new vscode.ThemeIcon("diff-modified");
  }
}

function fileStatusLabel(status: PRFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "renamed":
      return "R";
    case "modified":
    case "changed":
      return "M";
    default:
      return "";
  }
}
