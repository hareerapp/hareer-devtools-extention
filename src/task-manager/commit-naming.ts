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
  if (desc.taskId) {
    lines.push("", `CU-${desc.taskId.trim()}`);
  }
  return lines.join("\n");
}

export interface SubjectCheck {
  readonly length: number;
  readonly warning?: string;
}

export function checkSubjectLength(subject: string): SubjectCheck {
  const len = subject.trim().length;
  if (len === 0) return { length: 0, warning: "Subject is required." };
  if (len > 72) return { length: len, warning: "Subject is longer than 72 characters." };
  return { length: len };
}
