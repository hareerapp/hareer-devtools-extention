# vscode-extension

VS Code / Cursor extension for the Hareer mono repo: a sidebar UI to browse the **umbrella root** `Makefile` and run targets in an integrated terminal.

## Requirements

- [Bun](https://bun.sh) (`bun install`, `bun run …`)
- [Make](https://www.gnu.org/software/make/) if you prefer the wrappers below instead of invoking `bun` directly

## Quick start

From the monorepo root:

```bash
cd apps/vscode-extension
make install
make build
```

Or with Bun only:

```bash
cd apps/vscode-extension
bun install
bun run compile
```

## Makefile targets

| Target | What it does |
|--------|----------------|
| `make` / `make help` | Print available targets |
| `make install` | `bun install` |
| `make build` / `make compile` | `bun run compile` (outputs `dist/`) |
| `make watch` | `bun run watch` (TypeScript watch) |
| `make typecheck` | `bun run typecheck` |
| `make clean` | Remove `dist/` |
| `make run` | Launch Extension Development Host via `code` or `cursor` on `PATH` |
| `make package` | Compile and produce a `.vsix` with `@vscode/vsce` |

If `make run` fails because neither CLI is on `PATH`, open `apps/vscode-extension` in the editor and use **Run and Debug → Run Extension** (F5). In the **Extension Development** window, open the **hareer-mono** workspace so the root `Makefile` exists.

## Packaging a VSIX

```bash
make package
```

Install the generated `.vsix` from the editor’s **Extensions: Install from VSIX…** command.

## Icons

Three common places icons show up:

1. **Activity bar (left stripe)** — set in **`package.json`** → **`contributes.viewsContainers.activitybar[].icon`** (path relative to the extension root). This extension uses **`media/favicon.png`**. Prefer **SVG** (`fill="currentColor"`) for crisp scaling where you can otherwise use Codicons (`"$(terminal)"`). **PNG works** too for the activity bar icon.

2. **Extensions list / Marketplace** — top-level **`"icon"`** in **`package.json`**, usually **128×128 PNG**. This package uses **`media/favicon.png`**.

3. **Commands / tree rows** — Codicons such as **`"icon": "$(refresh)"`** (see [Codicons](https://code.visualstudio.com/api/references/icons-in-labels)); in code **`new vscode.ThemeIcon("play")`** for **`TreeItem.iconPath`**.

For packaged READMEs, **relative links into `media/`** need a **`repository`** field in **`package.json`** (with **`directory`** if the extension lives in a monorepo subfolder); otherwise **`@vscode/vsce`** warns or fails rewriting links.

## Project layout

- `media/favicon.png` — Marketplace + activity-bar icon
- `src/extension.ts` — activation, TreeView, commands
- `src/makefile-parser.ts` — parse umbrella `Makefile` `help` + `.PHONY` / rules
- `src/tree-provider.ts` — sidebar tree
- `src/terminal-runner.ts` — shared **Hareer** terminal and `make <target>`

Agent-oriented notes live in [`AGENTS.md`](./AGENTS.md). Workspace-wide conventions are documented in **`AGENTS.md` at the monorepo root** (parent of **`apps/`**).
