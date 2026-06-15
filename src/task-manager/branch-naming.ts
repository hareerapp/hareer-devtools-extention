import type { BranchDescriptor } from "./types";

const MAX_SLUG_LEN = 50;

export function slugify(input: string, maxLen: number = MAX_SLUG_LEN): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= maxLen) return base;
  const truncated = base.slice(0, maxLen);
  const lastDash = truncated.lastIndexOf("-");
  if (lastDash >= Math.floor(maxLen * 0.6)) {
    return truncated.slice(0, lastDash);
  }
  return truncated.replace(/-+$/, "");
}

export function formatBranchName(desc: BranchDescriptor): string {
  const slug = slugify(desc.title);
  const id = desc.taskId.trim();
  if (slug.length === 0) return `${desc.type}/${id}`;
  return `${desc.type}/${id}-${slug}`;
}

export function formatPRTitle(taskId: string, currentTitle: string): string {
  const id = taskId.trim();
  const prefix = `[${id}]`;
  const title = currentTitle.trim();
  if (id.length === 0) return title;
  if (title === prefix || title.startsWith(`${prefix} `)) return title;
  return title.length > 0 ? `${prefix} ${title}` : prefix;
}

/**
 * Validate against git's ref naming rules
 * (https://git-scm.com/docs/git-check-ref-format).
 */
export function validateGitRef(ref: string): string | undefined {
  if (ref.length === 0) return "Branch name cannot be empty.";
  if (ref.startsWith("-")) return "Branch name cannot start with '-'.";
  if (ref.startsWith(".") || ref.endsWith(".")) return "Branch name cannot start or end with '.'.";
  if (ref.endsWith("/")) return "Branch name cannot end with '/'.";
  if (ref.endsWith(".lock")) return "Branch name cannot end with '.lock'.";
  if (ref.includes("..")) return "Branch name cannot contain '..'.";
  if (ref.includes("//")) return "Branch name cannot contain '//'.";
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)) {
    return "Branch name contains forbidden characters.";
  }
  return undefined;
}
