# Hareer VS Code extension (apps/vscode-extension): local dev and build.
.PHONY: \
	help \
	install \
	build compile watch typecheck clean \
	run run-extension package \
	install-cursor install-vscode

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.DEFAULT_GOAL := help

# Derive the latest .vsix in release/ by modification time
LATEST_VSIX = $(shell ls -t "$(ROOT)/release"/*.vsix 2>/dev/null | head -1)

help:
	@printf '%s\n' \
		'' \
		'vscode-extension Makefile ($(ROOT))' \
		'' \
		'  make install            bun install dependencies' \
		'  make build              compile TypeScript → dist/' \
		'  make watch              watch mode compile' \
		'  make typecheck          tsc --noEmit' \
		'  make clean              remove dist/' \
		'  make run                open Extension Development Host (code or cursor)' \
		'  make package            build .vsix → release/' \
		'  make install-cursor     install latest release into Cursor' \
		'  make install-vscode     install latest release into VS Code' \
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
	@cd "$(ROOT)" && bun run compile && bunx --bun @vscode/vsce package --out "$(ROOT)/release/"
	@echo "Packaged → release/"
	@ls -1 "$(ROOT)/release/"

install-cursor:
	@if [ -z "$(LATEST_VSIX)" ]; then \
		echo "No .vsix found in release/. Run 'make package' first." >&2; exit 1; \
	fi
	@cursor --install-extension "$(LATEST_VSIX)" --force
	@echo "Installed successfully — please reload the Cursor window"

install-vscode:
	@if [ -z "$(LATEST_VSIX)" ]; then \
		echo "No .vsix found in release/. Run 'make package' first." >&2; exit 1; \
	fi
	@code --install-extension "$(LATEST_VSIX)" --force
	@echo "Installed successfully — please reload the VS Code window"
