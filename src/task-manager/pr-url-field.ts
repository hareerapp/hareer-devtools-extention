import type { ClickUpCustomField, ClickUpTask } from "./types";

export interface LinkedPR {
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export function findPRField(
  task: ClickUpTask,
  fieldName: string,
): ClickUpCustomField | undefined {
  const wanted = fieldName.toLowerCase();
  return task.customFields.find((f) => f.name.toLowerCase() === wanted);
}

export function extractPRUrl(field: ClickUpCustomField | undefined): string | undefined {
  if (!field) return undefined;
  const v = field.value;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (v && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.url === "string") return rec.url;
  }
  return undefined;
}

export function parsePRUrl(url: string): LinkedPR | undefined {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
  if (!m) return undefined;
  return {
    url,
    owner: m[1],
    repo: m[2],
    number: Number(m[3]),
  };
}

export function getLinkedPR(task: ClickUpTask, fieldName: string): LinkedPR | undefined {
  const url = extractPRUrl(findPRField(task, fieldName));
  if (!url) return undefined;
  return parsePRUrl(url);
}
