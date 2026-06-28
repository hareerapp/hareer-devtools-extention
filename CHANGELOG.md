# Changelog

All notable changes to the **Hareer DevTools** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.7] - 2026-06-28

### Fixed
- **Teammates list no longer crashes on pending members** — sorting the team panel
  threw `Cannot read properties of null (reading 'localeCompare')` when a ClickUp
  member was invited but had not finished onboarding (the API returns a `null`
  username). User mapping now falls back to the member's email, so the panel and
  task views stay safe.

## [0.5.6] - 2026-06-15

### Added
- **Clear button in the Code Review section** — a title-bar action that deselects
  all PRs at once. Only appears when there is a selection to clear.
- **Loading indicator on task actions** — opening a task now shows a spinner on the
  action buttons while repos, branches, and PRs are gathered, then reveals them all
  at once instead of silently popping in.

### Changed
- **"Link existing PR" is now a guided flow** — pick a submodule → pick one of its
  pull requests → the PR is renamed to the ClickUp-ID convention (`[CU-123] …`) and
  linked to the task. Enforces one linked PR per task (relinking replaces the old one
  after a confirm). Falls back to manual URL entry when there are no GitHub submodules.
- **Code Review section auto-cleans on task switch** — pressing a task's Code Review
  button clears any PR left selected from a previously-reviewed task, so only the
  current task's PRs are shown.
- **Checkout button hides when already checked out** — the Checkout action disappears
  once every matching submodule is on its branch, and its count reflects only the
  repos that still need checking out.

## [0.5.5] - 2026-06-11

### Added
- Makefile install targets for Cursor and VS Code, with updated help docs.

### Changed
- PR fetching now applies pagination limits and stricter typing for merged PRs.
- Task detail view adds branch-deletion checks and refined state management.

## [0.5.4] - 2026-06-11

### Changed
- Improved task-loading logic in the task service for better performance.

## [0.5.2] - 2026-06-01

### Added
- Branch deletion from the PR detail view.

### Changed
- Streamlined task merging by removing automatic branch-deletion prompts.

## [0.5.1] - 2026-06-01

### Added
- Task filtering and clearing commands, with improved filter options and UI.

## [0.4.0] - 2026-05-31

- Baseline release.
