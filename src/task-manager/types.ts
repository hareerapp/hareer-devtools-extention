export interface ClickUpUser {
  readonly id: number;
  readonly username: string;
  readonly email: string;
  readonly color?: string;
  readonly profilePicture?: string;
}

export interface ClickUpTeam {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly avatar?: string;
  readonly members: readonly ClickUpUser[];
}

export interface ClickUpStatus {
  readonly status: string;
  readonly color: string;
  readonly type: "open" | "custom" | "closed" | "done";
  readonly orderindex?: number;
}

export interface ClickUpCustomField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly value?: unknown;
}

export interface ClickUpList {
  readonly id: string;
  readonly name: string;
}

export interface ClickUpSpace {
  readonly id: string;
  readonly name: string;
}

export interface ClickUpFolder {
  readonly id: string;
  readonly name: string;
  readonly hidden?: boolean;
}

export interface ClickUpTag {
  readonly name: string;
  readonly fg?: string;
  readonly bg?: string;
}

export interface ClickUpTask {
  readonly id: string;
  readonly customId?: string;
  readonly name: string;
  readonly description: string;
  readonly status: ClickUpStatus;
  readonly url: string;
  readonly assignees: readonly ClickUpUser[];
  readonly watchers: readonly ClickUpUser[];
  readonly creator?: ClickUpUser;
  readonly dueDate?: string;
  readonly startDate?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly priority?: { id: string; priority: string; color: string };
  readonly tags: readonly ClickUpTag[];
  readonly timeEstimateMs?: number;
  readonly timeSpentMs?: number;
  readonly customFields: readonly ClickUpCustomField[];
  readonly list: ClickUpList;
  readonly space: ClickUpSpace;
  readonly folder?: ClickUpFolder;
}

export type BranchType =
  | "feature"
  | "bugfix"
  | "hotfix"
  | "chore"
  | "docs"
  | "refactor"
  | "test"
  | "style"
  | "perf";

export type CommitType =
  | "feat"
  | "fix"
  | "chore"
  | "docs"
  | "refactor"
  | "test"
  | "style"
  | "perf"
  | "build"
  | "ci";

export interface BranchDescriptor {
  readonly type: BranchType;
  readonly taskId: string;
  readonly title: string;
}

export interface CommitDescriptor {
  readonly type: CommitType;
  readonly scope?: string;
  readonly subject: string;
  readonly taskId?: string;
  readonly body?: string;
}
