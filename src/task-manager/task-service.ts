import * as vscode from "vscode";
import {
  ClickUpApiError,
  getAuthorizedUser,
  getFilteredTeamTasks,
  getTeams,
} from "./clickup-api";
import type { ClickUpTask, ClickUpTeam, ClickUpUser } from "./types";
import { clearClickUpToken, getClickUpToken } from "./auth";
import { PersistentCache, TTL } from "../cache";

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

const snapshotKey = (teamId: string): string => `tasks.${teamId}`;
const teammateKey = (teamId: string, userId: number): string =>
  `teammate.${teamId}.${userId}`;

export class TaskService {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private snapshot: Snapshot | undefined;
  private loading = false;
  private lastError: string | undefined;
  private readonly teammateCache = new Map<number, TeammateCache>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cache: PersistentCache,
  ) {
    // Seed from the persisted snapshot for the last active team so the tree
    // paints instantly on activation; refresh() revalidates in the background.
    const savedTeam = this.context.workspaceState.get<string>(TEAM_KEY);
    if (savedTeam) {
      const cached = this.cache.get<Snapshot>(snapshotKey(savedTeam));
      if (cached) this.snapshot = cached.value;
    }
  }

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

    const teamId = snap.activeTeam.id;
    const key = teammateKey(teamId, userId);

    // Serve persisted tasks instantly; only show a spinner on a true cold load.
    const cached = this.cache.get<readonly ClickUpTask[]>(key);
    if (cached) {
      this.teammateCache.set(userId, { loading: false, tasks: cached.value });
      this._onDidChange.fire();
      if (Date.now() - cached.updatedAt < TTL.teammateTasks) return; // fresh enough
    } else {
      this.teammateCache.set(userId, { loading: true });
      this._onDidChange.fire();
    }

    const token = await getClickUpToken(this.context);
    if (!token) return;

    try {
      const tasks = await getFilteredTeamTasks(token, teamId, {
        assigneeIds: [userId],
        includeClosed: false,
        subtasks: false,
        page: 0,
      });
      this.cache.set(key, tasks);
      this.teammateCache.set(userId, { loading: false, tasks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Keep showing stale tasks on failure; only surface an error with nothing cached.
      const prior = this.teammateCache.get(userId)?.tasks;
      this.teammateCache.set(userId, {
        loading: false,
        tasks: prior,
        error: prior ? undefined : msg,
      });
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

  /**
   * Refresh the task snapshot. Stale-while-revalidate: a cached snapshot stays
   * visible while we fetch, and a snapshot younger than the TTL skips the
   * network entirely. `force` (manual refresh) always re-fetches.
   */
  async refresh(force = false): Promise<void> {
    const token = await getClickUpToken(this.context);
    if (!token) {
      this.snapshot = undefined;
      this.lastError = undefined;
      this.teammateCache.clear();
      this._onDidChange.fire();
      return;
    }

    // Freshness short-circuit: serve the cached snapshot without a network hit.
    const savedTeam = this.context.workspaceState.get<string>(TEAM_KEY);
    if (!force && savedTeam) {
      const cached = this.cache.get<Snapshot>(snapshotKey(savedTeam));
      if (cached && Date.now() - cached.updatedAt < TTL.tasks) {
        this.snapshot = cached.value;
        this.loading = false;
        this.lastError = undefined;
        this._onDidChange.fire();
        return;
      }
    }

    // Only show the spinner on a true cold load; otherwise keep prior tasks shown.
    this.loading = this.snapshot === undefined;
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

      const snapshot: Snapshot = { user, teams, activeTeam, myTasks };
      this.snapshot = snapshot;
      this.cache.set(snapshotKey(activeTeam.id), snapshot);
    } catch (err) {
      if (err instanceof ClickUpApiError && err.status === 401) {
        await clearClickUpToken(this.context);
        this.clearCache();
        this.snapshot = undefined;
        this.lastError = "ClickUp token rejected. Please reconnect.";
      } else if (!this.snapshot) {
        // No stale data to fall back on — surface the error.
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      // Otherwise keep the stale snapshot visible and stay silent.
    } finally {
      this.loading = false;
      this._onDidChange.fire();
    }
  }

  /** Drop all persisted task data (on disconnect or auth failure). */
  clearCache(): void {
    this.cache.deleteByPrefix("tasks.");
    this.cache.deleteByPrefix("teammate.");
    this.teammateCache.clear();
    this.snapshot = undefined;
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
