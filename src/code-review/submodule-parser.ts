import type { Submodule } from "./types";

function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | undefined {
  const sshMatch = url.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
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
