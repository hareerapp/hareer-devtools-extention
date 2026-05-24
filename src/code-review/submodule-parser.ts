import type { Submodule } from "./types";

function stripRepoSuffix(raw: string): string {
  let out = raw.trim().replace(/\/+$/, "");
  if (out.toLowerCase().endsWith(".git")) out = out.slice(0, -4);
  return out;
}

function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | undefined {
  const cleaned = url.trim();
  const sshMatch = cleaned.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: stripRepoSuffix(sshMatch[2]) };
  }
  const httpsMatch = cleaned.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+)$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: stripRepoSuffix(httpsMatch[2]) };
  }
  return undefined;
}

export function parseGitmodules(content: string): Submodule[] {
  const submodules: Submodule[] = [];

  const blockRegex = /\[submodule "([^"]+)"\]([\s\S]*?)(?=\[submodule |\s*$)/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    const name = match[1];
    const block = match[2];

    const pathMatch = block.match(/^\s*path\s*=\s*(.+)$/m);
    const urlMatch = block.match(/^\s*url\s*=\s*(.+)$/m);

    if (!pathMatch || !urlMatch) continue;

    const subPath = pathMatch[1].trim();
    const url = urlMatch[1].trim();

    const parsed = parseGitHubOwnerRepo(url);
    if (!parsed) continue;

    submodules.push({
      name,
      path: subPath,
      url,
      owner: parsed.owner,
      repo: parsed.repo,
    });
  }

  return submodules;
}
