# Hareer DevTools

VS Code / Cursor extension for the Hareer mono repo. Three sidebar panels:

- **Task Manager** — ClickUp tasks, branch creation, conventional commits, push, and PR linking
- **Code Review** — GitHub PRs on submodules with inline comments and merging
- **Makefile Commands** — browse and run umbrella-root `Makefile` targets

## Requirements

- [Bun](https://bun.sh) (`bun install`, `bun run …`)
- [Make](https://www.gnu.org/software/make/) if you prefer the wrappers
- Git on `PATH` (uses VS Code's built-in Git extension API; falls back to `git` CLI for some operations)

## Task Manager

### Connecting ClickUp

1. Open the **Hareer DevTools** activity bar icon → **Task Manager** view
2. Click **Connect ClickUp**
3. Generate a Personal API Token in [ClickUp Settings → Apps](https://app.clickup.com/settings/apps) and paste it
4. The token is stored in your OS keychain via `SecretStorage`

If you belong to multiple workspaces, you'll be asked to pick one. Use the **organization** title-bar button to switch later.

### Sidebar layout

```
📋 Task Manager
├── My Tasks
│   ├── 🟡 in progress (3)
│   │   ├── Import products publish default     86exkfy54
│   │   └── Fix auth redirect                    86exfm2pq
│   ├── 🔵 to do (12)
│   └── 🟢 review (1)
└── Team
    ├── Ahmed
    └── Sara
```

Click any task → opens a detail panel with task info, branch tools, and a commit/push form.

### Branch & PR flow

When a task has **no linked PR**:

1. Pick a branch type (`feature`, `bugfix`, `hotfix`, `chore`, `docs`, `refactor`, …)
2. Branch name is generated as `{type}/{clickup-id}-{slug-of-task-name}` — preview shown live
3. **Create branch & checkout** runs `git fetch` then creates the branch off `origin/<default>`
4. After your first push, you're offered **Open Create PR** (opens GitHub's compare page) or **Paste PR URL** to write the URL back into the ClickUp custom field

When a task **has a linked PR**:

1. The panel shows the PR number, owner/repo, and an Open ↗ link
2. **Checkout PR branch** fetches the PR's head ref from GitHub and checks it out locally

### Commit panel

- Conventional types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`
- Branch type implies the commit type (e.g. `bugfix` → `fix`)
- Optional scope, required subject (72-char cap warning)
- Optional body
- **CU-{id}** appended as a git trailer so commits link back to the ClickUp task
- Buttons: **Commit**, **Commit & Push**, **Push only**
- Optional "Stage all changes" before committing

### Settings

| Setting | Default | Purpose |
|---|---|---|
| `hareer.clickup.prUrlFieldName` | `Github PR Url` | Name of the ClickUp custom field that holds the PR URL |
| `hareer.clickup.autoTransition` | `true` | When `true`: move task to "in progress" on branch creation, "in review" when PR is linked, and back to "in progress" when a reviewer requests changes or leaves a comment review |
| `hareer.clickup.branchTypes` | `[feature, bugfix, hotfix, chore, docs, refactor]` | Branch type chips shown in the panel |
| `hareer.clickup.pollIntervalMs` | `0` | Auto-refresh interval (ms). 0 disables polling |

### Commands

| Command | Title |
|---|---|
| `hareer.connectClickUp` | Hareer: Connect ClickUp |
| `hareer.disconnectClickUp` | Hareer: Disconnect ClickUp |
| `hareer.switchClickUpWorkspace` | Hareer: Switch ClickUp Workspace |
| `hareer.refreshTasks` | Hareer: Refresh Tasks |
| `hareer.openTaskDetail` | Hareer: Open Task Detail |

## Code Review

Browse GitHub PRs across the `.gitmodules` submodules of your workspace, view diffs with inline comments, submit reviews, and merge PRs. Uses VS Code's built-in GitHub authentication.

## Makefile Commands

Browse the umbrella-root `Makefile` and run targets in a shared **Hareer** terminal. The `help:` recipe defines groups; `.PHONY` targets that aren't in `help` show up under **Other**.

## Quick start

```bash
cd apps/vscode-extension
bun install
bun run compile
```

Then **F5** in the editor to launch the Extension Development Host.

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

## Packaging a VSIX

```bash
make package
# or
bun run compile && bunx --bun @vscode/vsce package
```

Install via **Extensions: Install from VSIX…** in Cursor / VS Code.

## Project layout

```
src/
├── extension.ts                  # activation, command registration
├── makefile-parser.ts            # parse Makefile help/.PHONY
├── tree-provider.ts              # Makefile sidebar
├── terminal-runner.ts            # shared Hareer terminal
├── code-review/                  # GitHub PR review
│   ├── code-review-provider.ts
│   ├── comment-provider.ts
│   ├── diff-provider.ts
│   ├── git-checkout.ts
│   ├── github-api.ts
│   ├── submodule-parser.ts
│   └── types.ts
└── task-manager/                 # ClickUp Task Manager
    ├── auth.ts                   # token via SecretStorage
    ├── branch-naming.ts          # type/CU-id-slug
    ├── clickup-api.ts            # HTTPS client (no deps)
    ├── commands.ts               # connect / disconnect / switch
    ├── commit-naming.ts          # conventional commits + CU trailer
    ├── git-operations.ts         # vscode.git API wrapper
    ├── pr-url-field.ts           # find/update PR URL custom field
    ├── task-detail-webview.ts    # webview manager + inlined HTML/JS
    ├── task-service.ts           # state, refresh, lazy teammate loads
    ├── task-tree-provider.ts     # sidebar tree
    └── types.ts
```

Agent-oriented notes live in [`AGENTS.md`](./AGENTS.md). Workspace-wide conventions are documented in `AGENTS.md` at the monorepo root.
