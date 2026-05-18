import * as vscode from "vscode";

const TERMINAL_NAME = "Hareer";

let shared: { readonly cwd: string; readonly terminal: vscode.Terminal } | undefined;

function disposeShared(): void {
  if (shared) {
    shared.terminal.dispose();
    shared = undefined;
  }
}

/** Safe for Hareer makefile target names ([a-zA-Z0-9_-]+). */
function quoteMakeTarget(target: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(target)) {
    return target;
  }
  return `'${target.replace(/'/g, `'\\''`)}'`;
}

export function runMakeTarget(cwd: string, target: string): void {
  if (!shared || shared.cwd !== cwd) {
    disposeShared();
    shared = {
      cwd,
      terminal: vscode.window.createTerminal({ name: TERMINAL_NAME, cwd }),
    };
  }

  shared.terminal.show(true);
  shared.terminal.sendText(`make ${quoteMakeTarget(target)}`, true);
}

export function disposeHareerTerminal(): void {
  disposeShared();
}
