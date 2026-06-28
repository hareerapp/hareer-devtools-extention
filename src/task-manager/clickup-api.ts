import * as https from "node:https";
import type {
  ClickUpCustomField,
  ClickUpList,
  ClickUpStatus,
  ClickUpTag,
  ClickUpTask,
  ClickUpTeam,
  ClickUpUser,
} from "./types";

const HOST = "api.clickup.com";
const BASE_PATH = "/api/v2";

export class ClickUpApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ClickUpApiError";
  }
}

interface RawUser {
  id: number;
  username: string | null;
  email: string | null;
  color?: string;
  profilePicture?: string;
}

interface RawMember {
  user: RawUser;
}

interface RawTeam {
  id: string;
  name: string;
  color?: string;
  avatar?: string;
  members: RawMember[];
}

interface RawStatus {
  status: string;
  color: string;
  type: string;
  orderindex?: number;
}

interface RawCustomField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
}

interface RawListRef {
  id: string;
  name: string;
}

interface RawSpaceRef {
  id: string;
  name?: string;
}

interface RawFolderRef {
  id: string;
  name: string;
  hidden?: boolean;
}

interface RawTag {
  name: string;
  tag_fg?: string;
  tag_bg?: string;
}

interface RawTask {
  id: string;
  custom_id?: string | null;
  name: string;
  description?: string;
  text_content?: string;
  status: RawStatus;
  url: string;
  assignees: RawUser[];
  watchers?: RawUser[];
  creator?: RawUser;
  due_date?: string | null;
  start_date?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
  priority?: { id: string; priority: string; color: string } | null;
  tags?: RawTag[];
  time_estimate?: number | null;
  time_spent?: number | null;
  custom_fields: RawCustomField[];
  list: RawListRef;
  space: RawSpaceRef;
  folder?: RawFolderRef;
}

interface QueryParam {
  readonly key: string;
  readonly value: string;
}

function buildQuery(params: readonly QueryParam[]): string {
  if (params.length === 0) return "";
  const parts = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`);
  return `?${parts.join("&")}`;
}

function request<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: HOST,
      path: `${BASE_PATH}${path}`,
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const status = res.statusCode ?? 0;
        if (status === 204 || raw.length === 0) {
          resolve(undefined as T);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          reject(new ClickUpApiError(`Invalid JSON from ClickUp: ${raw.slice(0, 200)}`, status));
          return;
        }
        if (status >= 400) {
          const err = parsed as { err?: string; ECODE?: string };
          const msg = err.err ? `${err.err}${err.ECODE ? ` (${err.ECODE})` : ""}` : `HTTP ${status}`;
          reject(new ClickUpApiError(`ClickUp: ${msg}`, status));
          return;
        }
        resolve(parsed as T);
      });
    });

    req.on("error", (e) => reject(new ClickUpApiError(e.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

function mapUser(raw: RawUser): ClickUpUser {
  // ClickUp returns username: null for members invited but not yet onboarded;
  const email = raw.email ?? "";
  return {
    id: raw.id,
    username: raw.username || email || "Unknown",
    email,
    color: raw.color,
    profilePicture: raw.profilePicture,
  };
}

function mapStatus(raw: RawStatus): ClickUpStatus {
  const type =
    raw.type === "open" || raw.type === "closed" || raw.type === "done" ? raw.type : "custom";
  return {
    status: raw.status,
    color: raw.color,
    type,
    orderindex: raw.orderindex,
  };
}

function mapCustomField(raw: RawCustomField): ClickUpCustomField {
  return { id: raw.id, name: raw.name, type: raw.type, value: raw.value };
}

function mapList(raw: RawListRef): ClickUpList {
  return { id: raw.id, name: raw.name };
}

function mapTag(t: RawTag): ClickUpTag {
  return { name: t.name, fg: t.tag_fg, bg: t.tag_bg };
}

function mapTask(raw: RawTask): ClickUpTask {
  return {
    id: raw.id,
    customId: raw.custom_id ?? undefined,
    name: raw.name,
    description: raw.description ?? raw.text_content ?? "",
    status: mapStatus(raw.status),
    url: raw.url,
    assignees: raw.assignees.map(mapUser),
    watchers: (raw.watchers ?? []).map(mapUser),
    creator: raw.creator ? mapUser(raw.creator) : undefined,
    dueDate: raw.due_date ?? undefined,
    startDate: raw.start_date ?? undefined,
    createdAt: raw.date_created ?? undefined,
    updatedAt: raw.date_updated ?? undefined,
    priority: raw.priority ?? undefined,
    tags: (raw.tags ?? []).map(mapTag),
    timeEstimateMs: raw.time_estimate ?? undefined,
    timeSpentMs: raw.time_spent ?? undefined,
    customFields: raw.custom_fields.map(mapCustomField),
    list: mapList(raw.list),
    space: { id: raw.space.id, name: raw.space.name ?? "" },
    folder: raw.folder ? { id: raw.folder.id, name: raw.folder.name, hidden: raw.folder.hidden } : undefined,
  };
}

export async function getAuthorizedUser(token: string): Promise<ClickUpUser> {
  const res = await request<{ user: RawUser }>("GET", "/user", token);
  return mapUser(res.user);
}

export async function getTeams(token: string): Promise<ClickUpTeam[]> {
  const res = await request<{ teams: RawTeam[] }>("GET", "/team", token);
  return res.teams.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    avatar: t.avatar,
    members: t.members.map((m) => mapUser(m.user)),
  }));
}

export interface FilteredTasksQuery {
  readonly assigneeIds: readonly number[];
  readonly includeClosed?: boolean;
  readonly subtasks?: boolean;
  readonly page?: number;
}

export async function getFilteredTeamTasks(
  token: string,
  teamId: string,
  query: FilteredTasksQuery,
): Promise<ClickUpTask[]> {
  const params: QueryParam[] = [];
  for (const id of query.assigneeIds) {
    params.push({ key: "assignees[]", value: String(id) });
  }
  if (query.includeClosed !== undefined) {
    params.push({ key: "include_closed", value: String(query.includeClosed) });
  }
  if (query.subtasks !== undefined) {
    params.push({ key: "subtasks", value: String(query.subtasks) });
  }
  params.push({ key: "page", value: String(query.page ?? 0) });

  const res = await request<{ tasks: RawTask[] }>(
    "GET",
    `/team/${encodeURIComponent(teamId)}/task${buildQuery(params)}`,
    token,
  );
  return res.tasks.map(mapTask);
}

export async function getTask(token: string, taskId: string): Promise<ClickUpTask> {
  const res = await request<RawTask>(
    "GET",
    `/task/${encodeURIComponent(taskId)}`,
    token,
  );
  return mapTask(res);
}

export async function setCustomFieldValue(
  token: string,
  taskId: string,
  fieldId: string,
  value: unknown,
): Promise<void> {
  await request(
    "POST",
    `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
    token,
    { value },
  );
}

export async function updateTaskStatus(
  token: string,
  taskId: string,
  status: string,
): Promise<void> {
  await request(
    "PUT",
    `/task/${encodeURIComponent(taskId)}`,
    token,
    { status },
  );
}

export async function getListStatuses(
  token: string,
  listId: string,
): Promise<ClickUpStatus[]> {
  const res = await request<{ statuses: RawStatus[] }>(
    "GET",
    `/list/${encodeURIComponent(listId)}`,
    token,
  );
  return res.statuses.map(mapStatus);
}
