import * as vscode from "vscode";
import {
  ClickUpApiError,
  getAuthorizedUser,
  getFilteredTeamTasks,
  getTeams,
} from "./clickup-api";
import type { ClickUpTask, ClickUpTeam, ClickUpUser } from "./types";
import { clearClickUpToken, getClickUpToken } from "./auth";

const TEAM_KEY = "hareer.clickup.activeTeamId";

interface Snapshot {
  readonly user: ClickUpUser;
  readonly teams: readonly ClickUpTeam[];
  readonly activeTeam: ClickUpTeam;
  readonly myTasks: readonly ClickUpTask[];
}

interface TeammateCache {
  tasks?: readonly ClickUpTask[];
  loading: boolean;
  error?: string;
}

export class TaskService {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private snapshot: Snapshot | undefined;
  private loading = false;
  private lastError: string | undefined;
  private readonly teammateCache = new Map<number, TeammateCache>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  getTeammates(): readonly ClickUpUser[] {
    const snap = this.snapshot;
    if (!snap) return [];
    return snap.activeTeam.members.filter((m) => m.id !== snap.user.id);
  }

  getTeammateState(userId: number): TeammateCache {
    return this.teammateCache.get(userId) ?? { loading: false };
  }

  async loadTeammateTasks(userId: number): Promise<void> {
    const snap = this.snapshot;
    if (!snap) return;
    const current = this.teammateCache.get(userId);
    if (current?.tasks || current?.loading) return;

    const token = await getClickUpToken(this.context);
    if (!token) return;

    this.teammateCache.set(userId, { loading: true });
    this._onDidChange.fire();

    try {
      const tasks = await getFilteredTeamTasks(token, snap.activeTeam.id, {
        assigneeIds: [userId],
        includeClosed: false,
        subtasks: false,
        page: 0,
      });
      this.teammateCache.set(userId, { loading: false, tasks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.teammateCache.set(userId, { loading: false, error: msg });
    } finally {
      this._onDidChange.fire();
    }
  }

  getSnapshot(): Snapshot | undefined {
    return this.snapshot;
  }

  isLoading(): boolean {
    return this.loading;
  }

  getError(): string | undefined {
    return this.lastError;
  }

  async refresh(): Promise<void> {
    const token = await getClickUpToken(this.context);
    if (!token) {
      this.snapshot = undefined;
      this.lastError = undefined;
      this._onDidChange.fire();
      return;
    }

    this.loading = true;
    this.lastError = undefined;
    this.teammateCache.clear();
    this._onDidChange.fire();

    try {
      const [user, teams] = await Promise.all([
        getAuthorizedUser(token),
        getTeams(token),
      ]);

      if (teams.length === 0) {
        this.snapshot = undefined;
        this.lastError = "No ClickUp workspaces are available for this account.";
        return;
      }

      const activeTeam = await this.resolveActiveTeam(teams);
      const myTasks = await getFilteredTeamTasks(token, activeTeam.id, {
        assigneeIds: [user.id],
        includeClosed: false,
        subtasks: true,
        page: 0,
      });

      this.snapshot = { user, teams, activeTeam, myTasks };
    } catch (err) {
      this.snapshot = undefined;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof ClickUpApiError && err.status === 401) {
        await clearClickUpToken(this.context);
        this.lastError = "ClickUp token rejected. Please reconnect.";
      }
    } finally {
      this.loading = false;
      this._onDidChange.fire();
    }
  }

  async setActiveTeam(teamId: string): Promise<void> {
    await this.context.workspaceState.update(TEAM_KEY, teamId);
    await this.refresh();
  }

  private async resolveActiveTeam(teams: readonly ClickUpTeam[]): Promise<ClickUpTeam> {
    const saved = this.context.workspaceState.get<string>(TEAM_KEY);
    if (saved) {
      const match = teams.find((t) => t.id === saved);
      if (match) return match;
    }
    if (teams.length === 1) {
      await this.context.workspaceState.update(TEAM_KEY, teams[0].id);
      return teams[0];
    }
    const picked = await vscode.window.showQuickPick(
      teams.map((t) => ({ label: t.name, description: `id ${t.id}`, teamId: t.id })),
      { placeHolder: "Select a ClickUp workspace" },
    );
    if (picked) {
      await this.context.workspaceState.update(TEAM_KEY, picked.teamId);
      return teams.find((t) => t.id === picked.teamId) ?? teams[0];
    }
    return teams[0];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
