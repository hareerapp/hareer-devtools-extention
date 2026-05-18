# Hareer VS Code extension (apps/vscode-extension): local dev and build.
.PHONY: \
	help \
	install \
	build compile watch typecheck clean \
	run run-extension package

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.DEFAULT_GOAL := help

help:
	@printf '%s\n' \
		'' \
		'vscode-extension Makefile ($(ROOT))' \
		'' \
		'  make install          bun install dependencies' \
		'  make build            compile TypeScript → dist/' \
		'  make watch            watch mode compile' \
		'  make typecheck        tsc --noEmit' \
		'  make clean            remove dist/' \
		'  make run              open Extension Development Host (code or cursor)' \
		'  make package          build .vsix with @vscode/vsce' \
		''

install:
	@cd "$(ROOT)" && bun install

build compile:
	@cd "$(ROOT)" && bun run compile

watch:
	@cd "$(ROOT)" && bun run watch

typecheck:
	@cd "$(ROOT)" && bun run typecheck

clean:
	@rm -rf "$(ROOT)/dist"

run run-extension:
	@if command -v code >/dev/null 2>&1; then \
		code "$(ROOT)" --extensionDevelopmentPath="$(ROOT)"; \
	elif command -v cursor >/dev/null 2>&1; then \
		cursor "$(ROOT)" --extensionDevelopmentPath="$(ROOT)"; \
	else \
		echo "No 'code' or 'cursor' on PATH. Open this folder in the editor and use Run Extension (F5)." >&2; \
		exit 1; \
	fi

package:
	@cd "$(ROOT)" && bun run compile && bunx --bun @vscode/vsce package
