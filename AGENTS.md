# Hareer VS Code Extension (`vscode-extension`)

Extension under `apps/vscode-extension/` for the Hareer umbrella repo: browse Makefile targets from the sidebar and run them in a dedicated terminal.

## Commands

Use **Bun** in this folder, or **`make`** for common tasks (`make install`, `make build`, etc. — see [README](./README.md)).

```bash
cd apps/vscode-extension
make install
make build
```

Development:

- `make run` — opens Extension Development Host if `code` or `cursor` is on `PATH`; or  
- Open `apps/vscode-extension/` in Cursor/VS Code and press **F5** (**Run Extension**).

In the Extension Host window, open the monorepo root so the umbrella `Makefile` is available.

Package for local install:

```bash
make package
# or
bun run compile && bunx --bun @vscode/vsce package
```

## Behaviour

- Resolves **`Makefile`** in the workspace: first workspace folder with a `./Makefile`; otherwise first match via `**/Makefile`.
- Parses the root **`help:`** recipe for grouped targets plus **`.PHONY`** and rule headers for orphan targets (“Other”).
- Runs **`make <target>`** in a terminal named **Hareer** rooted at the directory that contains that `Makefile`.

## Source layout

| File                     | Purpose                        |
|--------------------------|--------------------------------|
| `src/extension.ts`       | Activation, commands, TreeView |
| `src/makefile-parser.ts` | Parse Makefile → groups        |
| `src/tree-provider.ts`   | `TreeDataProvider` for sidebar |
| `src/terminal-runner.ts` | Shared terminal + `make`       |

Standalone rules for assistants: workspace-wide tooling is in repo root [`AGENTS.md`](../../AGENTS.md).
