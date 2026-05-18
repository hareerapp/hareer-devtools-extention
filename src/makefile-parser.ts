export interface MakefileTarget {
  readonly name: string;
  readonly description: string;
}

export interface MakefileGroup {
  readonly title: string;
  readonly targets: readonly MakefileTarget[];
}

/** Strips makefile color variable fragments for readable titles/descriptions. */
function stripEchoColorVars(fragment: string): string {
  return fragment
    .replaceAll("$(BLUE)", "")
    .replaceAll("$(GREEN)", "")
    .replaceAll("$(YELLOW)", "")
    .replaceAll("$(RESET)", "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPhonyTargetNames(content: string): Set<string> {
  /** Block ends at first variable assignment line after `.PHONY` (e.g. `ROOT := …`). */
  const start = content.indexOf(".PHONY:");
  if (start === -1) return new Set();
  const sliceFromPhony = content.slice(start + ".PHONY:".length);
  const anchorOffset = /\n\s*[A-Za-z_][A-Za-z0-9_]*\s*:=/.exec(sliceFromPhony)?.index ?? -1;
  if (anchorOffset === -1) return new Set();
  const block = sliceFromPhony.slice(0, anchorOffset);
  const flat = block.replace(/\\\s*\n\s*/g, " ");
  const tokens = flat.split(/\s+/).filter((t) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t));
  return new Set(tokens);
}

function extractHelpRecipeLines(makefile: string): string[] {
  const lines = makefile.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].startsWith("help:")) break;
  }
  if (i >= lines.length) return [];
  const out: string[] = [];
  i++;
  while (i < lines.length && lines[i].startsWith("\t")) {
    out.push(lines[i]);
    i++;
  }
  return out;
}

function extractEchoInner(recipeLine: string): string | undefined {
  const m = recipeLine.match(/^\t@echo "(.*)"\s*$/);
  if (!m) return undefined;
  return m[1];
}

function extractGreenTargets(inner: string): string[] {
  const re = /\$\(GREEN\)([a-zA-Z0-9_-]+)\$\(RESET\)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function descriptionAfterLastGreenReset(inner: string): string {
  const token = "$(RESET)";
  const last = inner.lastIndexOf(token);
  if (last === -1) return "";
  return stripEchoColorVars(inner.slice(last + token.length));
}

/**
 * Rule headers at column 0: `target:` or `a b c: deps`. Skips variable assignments (`:=`).
 */
function extractRuleTargetNames(makefileContent: string): Set<string> {
  const lines = makefileContent.split("\n");
  const out = new Set<string>();
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("\t")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const afterColon = line.slice(idx + 1);
    if (afterColon.startsWith("=")) continue;
    const left = line.slice(0, idx).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*(\s+[a-zA-Z][a-zA-Z0-9_.-]*)*$/.test(left)) {
      continue;
    }
    for (const name of left.split(/\s+/)) {
      out.add(name);
    }
  }
  return out;
}

/**
 * Parses the root Makefile `help` recipe into grouped targets, then appends an **Other**
 * section for `.PHONY` / rule targets missing from `help`.
 */
export function parseMakefile(makefileContent: string): MakefileGroup[] {
  const phony = extractPhonyTargetNames(makefileContent);
  const ruleNames = extractRuleTargetNames(makefileContent);
  const knownNames = new Set<string>([...phony, ...ruleNames]);

  const groups: MakefileGroup[] = [];
  let currentTitle = "General";
  let currentTargets: MakefileTarget[] = [];
  const seenFromHelp = new Set<string>();

  const flush = (): void => {
    if (currentTargets.length === 0) return;
    groups.push({
      title: currentTitle,
      targets: currentTargets,
    });
    currentTargets = [];
  };

  for (const recipeLine of extractHelpRecipeLines(makefileContent)) {
    const inner = extractEchoInner(recipeLine);
    if (inner === undefined || inner === "") continue;

    const greenTargets = extractGreenTargets(inner);
    if (greenTargets.length === 0) {
      const heading = stripEchoColorVars(inner);
      if (/[a-zA-Z]/.test(heading)) {
        flush();
        currentTitle = heading;
      }
      continue;
    }

    const description = descriptionAfterLastGreenReset(inner);
    for (const name of greenTargets) {
      seenFromHelp.add(name);
      currentTargets.push({ name, description });
    }
  }
  flush();

  const other: MakefileTarget[] = [];
  for (const name of knownNames) {
    if (name === "help") continue;
    if (seenFromHelp.has(name)) continue;
    other.push({ name, description: "" });
  }
  other.sort((a, b) => a.name.localeCompare(b.name));
  if (other.length > 0) {
    groups.push({
      title: "Other",
      targets: other,
    });
  }

  return groups;
}
