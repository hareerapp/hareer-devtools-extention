# Hareer DevTools

VS Code / Cursor extension for the Hareer mono repo. Provides three sidebar panels:

- **Task Manager** — ClickUp tasks, branch creation, conventional commits, push, and PR linking
- **Code Review** — GitHub PRs across submodules with inline comments and merging
- **Makefile Commands** — browse and run umbrella-root `Makefile` targets

---

## Requirements

| Tool | Purpose |
|------|---------|
| [Bun](https://bun.sh) | Package manager and script runner |
| [Make](https://www.gnu.org/software/make/) | Optional CLI wrappers |
| Git | On `PATH`; uses VS Code's built-in Git extension API with a `git` CLI fallback |
| [Cursor](https://cursor.com) or [VS Code](https://code.visualstudio.com) | Host editor |

---

## Quick Start

```bash
cd apps/vscode-extension
bun install
bun run compile
```

Then press **F5** in the editor to launch an Extension Development Host.

---

## Makefile Targets

| Target | What it does |
|--------|--------------|
| `make` / `make help` | Print available targets |
| `make install` | `bun install` |
| `make build` / `make compile` | Compile TypeScript → `dist/` |
| `make watch` | TypeScript watch mode |
| `make typecheck` | `tsc --noEmit` |
| `make clean` | Remove `dist/` |
| `make run` | Launch Extension Development Host via `code` or `cursor` on `PATH` |
| `make package` | Compile and produce a `.vsix` → `release/` |
| `make install-cursor` | Install the latest `.vsix` from `release/` into Cursor |
| `make install-vscode` | Install the latest `.vsix` from `release/` into VS Code |

### Packaging and Installing

```bash
# Build and output .vsix to release/
make package

# Install into Cursor (picks the newest .vsix in release/ automatically)
make install-cursor

# Install into VS Code
make install-vscode
```

All `.vsix` files are stored under `release/`. Both install targets pick the newest file by modification time, so you never need to update a version string manually.

You can also install manually via **Extensions: Install from VSIX…** in Cursor / VS Code.

---

## Task Manager

Connects to ClickUp and provides a full task-driven Git workflow without leaving the editor.

### Connecting ClickUp

1. Open the **Hareer DevTools** activity bar icon → **Task Manager** view
2. Click **Connect ClickUp**
3. Generate a Personal API Token in [ClickUp Settings → Apps](https://app.clickup.com/settings/apps) and paste it
4. The token is stored in your OS keychain via VS Code's `SecretStorage`

If you belong to multiple workspaces you'll be asked to pick one. Use the **organization** title-bar button to switch later.

### Sidebar Layout

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

Click any task to open a detail panel with task info, branch tools, and a commit/push form.

### Branch & PR Flow

**When a task has no linked PR:**

1. Pick a branch type (`feature`, `bugfix`, `hotfix`, `chore`, `docs`, `refactor`, …)
2. Branch name is generated as `{type}/{clickup-id}-{slug-of-task-name}` — preview shown live
3. **Create branch & checkout** runs `git fetch` then creates the branch off `origin/<default>`
4. After your first push you're offered **Open Create PR** (opens GitHub's compare page) or **Paste PR URL** to write the URL back into the ClickUp custom field

**When a task has a linked PR:**

1. The panel shows the PR number, owner/repo, and an **Open ↗** link
2. **Checkout PR branch** fetches the PR's head ref from GitHub and checks it out locally

### Commit Panel

- Conventional types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`
- Branch type implies the commit type (e.g. `bugfix` → `fix`)
- Optional scope, required subject (72-char cap warning)
- Optional body
- `CU-{id}` appended as a git trailer so commits link back to the ClickUp task
- Buttons: **Commit**, **Commit & Push**, **Push only**
- Optional "Stage all changes" toggle before committing

### Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `hareer.clickup.prUrlFieldName` | `Github PR Url` | Name of the ClickUp custom field that holds the PR URL |
| `hareer.clickup.autoTransition` | `true` | Move task to "in progress" on branch creation, "in review" when PR is linked, and back to "in progress" when a reviewer requests changes |
| `hareer.clickup.branchTypes` | `[feature, bugfix, hotfix, chore, docs, refactor]` | Branch type chips shown in the panel |
| `hareer.clickup.pollIntervalMs` | `0` | Auto-refresh interval in ms; `0` disables polling |

### Commands

| Command ID | Title |
|-----------|-------|
| `hareer.connectClickUp` | Hareer: Connect ClickUp |
| `hareer.disconnectClickUp` | Hareer: Disconnect ClickUp |
| `hareer.switchClickUpWorkspace` | Hareer: Switch ClickUp Workspace |
| `hareer.refreshTasks` | Hareer: Refresh Tasks |
| `hareer.openTaskDetail` | Hareer: Open Task Detail |

---

## Code Review

Browse GitHub PRs across the `.gitmodules` submodules of your workspace. Features:

- Diff view with inline comment threads
- Submit reviews (approve, request changes, comment)
- Merge PRs
- Checkout PR branches locally

Uses VS Code's built-in GitHub authentication — no token setup required.

---

## Makefile Commands

Parses the umbrella-root `Makefile` and lists runnable targets in the sidebar. Targets are grouped by the `help:` recipe; `.PHONY` targets not in `help` appear under **Other**. Runs in a shared **Hareer** terminal panel.

---

## Project Layout

```
src/
├── extension.ts                  # Activation, command registration
├── makefile-parser.ts            # Parse Makefile help / .PHONY targets
├── tree-provider.ts              # Makefile sidebar tree
├── terminal-runner.ts            # Shared Hareer terminal
├── code-review/
│   ├── code-review-provider.ts
│   ├── comment-provider.ts
│   ├── diff-provider.ts
│   ├── git-checkout.ts
│   ├── github-api.ts
│   ├── submodule-parser.ts
│   └── types.ts
└── task-manager/
    ├── auth.ts                   # Token storage via SecretStorage
    ├── branch-naming.ts          # type/CU-id-slug generation
    ├── clickup-api.ts            # HTTPS client (no third-party deps)
    ├── commands.ts               # connect / disconnect / switch workspace
    ├── commit-naming.ts          # Conventional commits + CU trailer
    ├── git-operations.ts         # vscode.git API wrapper
    ├── pr-url-field.ts           # Find / update PR URL custom field
    ├── task-detail-webview.ts    # Webview manager + inlined HTML/JS
    ├── task-service.ts           # State, refresh, lazy teammate loads
    ├── task-tree-provider.ts     # Sidebar tree
    └── types.ts

release/                          # Built .vsix files (make package output)
```

Agent-oriented notes live in [AGENTS.md](./AGENTS.md). Workspace-wide conventions are documented in `AGENTS.md` at the monorepo root.
