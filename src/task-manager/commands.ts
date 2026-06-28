import * as vscode from "vscode";
import { clearClickUpToken, setClickUpToken, validateTokenShape } from "./auth";
import { getAuthorizedUser, getTeams, ClickUpApiError } from "./clickup-api";
import type { TaskService } from "./task-service";

const OPEN_CLICKUP_URL = "https://app.clickup.com/";

export async function connectClickUp(
  context: vscode.ExtensionContext,
  service: TaskService,
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Connect ClickUp by pasting a Personal API Token. In ClickUp: avatar → Settings → Apps (or Workspace Settings → ClickUp API) → Generate.",
    "Open ClickUp",
    "Paste Token",
  );
  if (choice === "Open ClickUp") {
    await vscode.env.openExternal(vscode.Uri.parse(OPEN_CLICKUP_URL));
  }
  if (choice !== "Paste Token" && choice !== "Open ClickUp") return;

  const token = await vscode.window.showInputBox({
    prompt: "Paste your ClickUp Personal API Token",
    placeHolder: "pk_XXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    password: true,
    ignoreFocusOut: true,
    validateInput: validateTokenShape,
  });
  if (!token) return;

  try {
    const user = await getAuthorizedUser(token.trim());
    const teams = await getTeams(token.trim());
    if (teams.length === 0) {
      void vscode.window.showErrorMessage(
        "Hareer: That token is valid but has no workspaces. Check ClickUp permissions.",
      );
      return;
    }
    await setClickUpToken(context, token.trim());
    void vscode.window.showInformationMessage(
      `Hareer: Connected to ClickUp as ${user.username} (${teams.length} workspace${teams.length === 1 ? "" : "s"}).`,
    );
    await service.refresh();
  } catch (err) {
    const msg = err instanceof ClickUpApiError ? err.message : err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Hareer: Could not verify token — ${msg}`);
  }
}

export async function disconnectClickUp(
  context: vscode.ExtensionContext,
  service: TaskService,
): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    "Disconnect ClickUp? The token will be removed from this machine.",
    { modal: true },
    "Disconnect",
  );
  if (confirmed !== "Disconnect") return;
  await clearClickUpToken(context);
  service.clearCache();
  await service.refresh();
  void vscode.window.showInformationMessage("Hareer: ClickUp disconnected.");
}

export async function switchClickUpWorkspace(service: TaskService): Promise<void> {
  const snap = service.getSnapshot();
  if (!snap) {
    void vscode.window.showWarningMessage("Hareer: Connect ClickUp first.");
    return;
  }
  if (snap.teams.length <= 1) {
    void vscode.window.showInformationMessage("Hareer: Only one workspace is available.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    snap.teams.map((t) => ({
      label: t.name,
      description: t.id === snap.activeTeam.id ? "active" : undefined,
      teamId: t.id,
    })),
    { placeHolder: "Switch active ClickUp workspace" },
  );
  if (!picked || picked.teamId === snap.activeTeam.id) return;
  await service.setActiveTeam(picked.teamId);
}
