import * as vscode from "vscode";

const SECRET_KEY = "hareer.clickup.token";
const CONTEXT_KEY = "hareer.clickup.connected";

let cached: string | undefined;

export async function getClickUpToken(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  if (cached) return cached;
  const stored = await context.secrets.get(SECRET_KEY);
  cached = stored;
  return stored;
}

export async function setClickUpToken(
  context: vscode.ExtensionContext,
  token: string,
): Promise<void> {
  await context.secrets.store(SECRET_KEY, token);
  cached = token;
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, true);
}

export async function clearClickUpToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  cached = undefined;
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
}

export async function syncConnectedContext(context: vscode.ExtensionContext): Promise<void> {
  const token = await getClickUpToken(context);
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, Boolean(token));
}

/**
 * Personal tokens look like `pk_<digits>_<alphanum>`. OAuth tokens are opaque.
 * We accept either as long as it's non-empty and has no whitespace.
 */
export function validateTokenShape(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Token cannot be empty.";
  if (/\s/.test(trimmed)) return "Token cannot contain whitespace.";
  if (trimmed.length < 20) return "That doesn't look like a ClickUp token.";
  return undefined;
}
