import * as path from "node:path";
import * as vscode from "vscode";
import { parseMakefile } from "./makefile-parser";
import { HareerTreeProvider } from "./tree-provider";
import { disposeHareerTerminal, runMakeTarget } from "./terminal-runner";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let makefileRootUri: vscode.Uri | undefined;

  const provider = new HareerTreeProvider();
  const treeView = vscode.window.createTreeView("hareerMakeTargets", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  async function findMakefileDirectory(): Promise<vscode.Uri | undefined> {
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const makefile = vscode.Uri.joinPath(wf.uri, "Makefile");
      try {
        await vscode.workspace.fs.stat(makefile);
        return wf.uri;
      } catch {
        /* try next */
      }
    }

    const found = await vscode.workspace.findFiles(
      "**/Makefile",
      "**/{node_modules,.git}/**",
      32,
    );
    if (found.length === 0) {
      return undefined;
    }
    found.sort((a, b) => a.fsPath.length - b.fsPath.length);
    return vscode.Uri.file(path.dirname(found[0].fsPath));
  }

  async function reload(): Promise<void> {
    makefileRootUri = await findMakefileDirectory();
    if (!makefileRootUri) {
      provider.setGroups([]);
      treeView.message = "No Makefile found in the workspace.";
      return;
    }

    treeView.message = undefined;
    const makefileUri = vscode.Uri.joinPath(makefileRootUri, "Makefile");
    try {
      const bytes = await vscode.workspace.fs.readFile(makefileUri);
      const text = new TextDecoder("utf-8").decode(bytes);
      provider.setGroups(parseMakefile(text));
    } catch (e) {
      provider.setGroups([]);
      const msg = e instanceof Error ? e.message : String(e);
      treeView.message = `Could not read Makefile: ${msg}`;
    }
  }

  await reload();

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("hareer.runTarget", async (targetName: unknown) => {
      if (typeof targetName !== "string" || targetName.length === 0) {
        return;
      }
      if (!makefileRootUri) {
        void vscode.window.showWarningMessage(
          "Hareer: no Makefile in the workspace; open a folder that contains it.",
        );
        return;
      }
      runMakeTarget(makefileRootUri.fsPath, targetName);
    }),
    vscode.commands.registerCommand("hareer.refresh", async () => {
      await reload();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reload();
    }),
    new vscode.Disposable(() => {
      disposeHareerTerminal();
    }),
  );
}

export function deactivate(): void {
  disposeHareerTerminal();
}
