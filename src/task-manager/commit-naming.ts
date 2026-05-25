import type { BranchType, CommitDescriptor, CommitType } from "./types";

const BRANCH_TO_COMMIT: Record<BranchType, CommitType> = {
  feature: "feat",
  bugfix: "fix",
  hotfix: "fix",
  chore: "chore",
  docs: "docs",
  refactor: "refactor",
  test: "test",
  style: "style",
  perf: "perf",
};

export function inferCommitType(branchType: BranchType): CommitType {
  return BRANCH_TO_COMMIT[branchType];
}

export function formatCommitMessage(desc: CommitDescriptor): string {
  const scope = desc.scope?.trim();
  const prefix = scope ? `${desc.type}(${scope})` : desc.type;
  const subject = desc.subject.trim();
  const header = `${prefix}: ${subject}`;

  const lines: string[] = [header];
  if (desc.body && desc.body.trim().length > 0) {
    lines.push("", desc.body.trim());
  }
  return lines.join("\n");
}

const GENERIC_BRANCHES = new Set(["develop", "staging", "main", "master"]);
const TASK_BRANCH_PATTERN =
  /^(?:feature|bugfix|hotfix|chore|refactor|docs|test|style|perf|release|build|ci)\/([^/-]+)(?:-|$)/i;

/**
 * Derive the commit scope (ClickUp task id) from a branch name.
 * Returns undefined for generic branches (develop/staging/main) or anything
 * that doesn't match the `<category>/<clickup_task_id>-<slug>` shape.
 */
export function deriveScopeFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const name = branch.trim();
  if (GENERIC_BRANCHES.has(name.toLowerCase())) return undefined;
  const match = name.match(TASK_BRANCH_PATTERN);
  return match ? match[1] : undefined;
}

export interface SubjectCheck {
  readonly length: number;
  readonly warning?: string;
}

const KNOWN_COMMIT_TYPES = new Set<CommitType>([
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "style",
  "perf",
  "build",
  "ci",
]);

/** Parses a conventional-commit string (e.g. from Cursor's SCM generator). */
export function parseGeneratedCommitMessage(raw: string): {
  type: CommitType;
  scope?: string;
  subject: string;
  body?: string;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { type: "chore", subject: "" };
  }

  const lines = trimmed.split(/\r?\n/);
  const header = lines[0] ?? "";
  const headerMatch = header.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);

  if (!headerMatch) {
    return { type: "chore", subject: header.trim() || trimmed };
  }

  const [, typeRaw, scopeRaw, subjectRaw] = headerMatch;
  const type = KNOWN_COMMIT_TYPES.has(typeRaw as CommitType)
    ? (typeRaw as CommitType)
    : "chore";
  const scope = scopeRaw?.trim();
  const subject = subjectRaw.trim();

  const body = lines
    .slice(1)
    .join("\n")
    .replace(/^\s*\n+/, "")
    .trim();

  return {
    type,
    scope: scope && scope.length > 0 ? scope : undefined,
    subject,
    body: body.length > 0 ? body : undefined,
  };
}

export function checkSubjectLength(subject: string): SubjectCheck {
  const len = subject.trim().length;
  if (len === 0) return { length: 0, warning: "Subject is required." };
  if (len > 72) return { length: len, warning: "Subject is longer than 72 characters." };
  return { length: len };
}
