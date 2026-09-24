# Build the desktop app and its backend sidecar.
#
# The sidecar runtime is chosen with ``SIDECAR`` (default ``v2``):
#   SIDECAR=v2          Python backend (python-build-standalone + site-packages)
#   SIDECAR=v3          Native Rust backend (single ``bin/openagentd`` binary)
# Each build wipes ``sidecar-bundle/`` first, so a bundle holds exactly one.
#
# Targets:
#   make sidecar        Build the sidecar bundle selected by SIDECAR.
#   make sidecar-v2     Build a slim Python (v2) sidecar bundle for this OS/arch.
#   make sidecar-v3     Build the native Rust (v3) sidecar bundle.
#   make sidecar-full   v2 bundle with [audio,azure-doc-intel] extras.
#   make icons          Regenerate .icns / .ico from icons/icon.png.
#   make dev            Tauri shell + Vite dev server, using the bundled
#                       sidecar connection model. Run Vite in another terminal
#                       if you need frontend HMR.
#   make dev-bundled    Tauri shell with the *bundled* sidecar (requires
#                       ``make sidecar`` first). Use this to test the
#                       sidecar handshake / auth wiring end-to-end.
#   make build          Build a release desktop app from the existing bundle.
#   make build-v3       Build the v3 sidecar, then a release desktop app.
#   *-v3                ``dev-bundled-v3`` / ``build-dev-app-v3`` are the same
#                       as the plain targets with SIDECAR=v3.
#   make open           Open the dev macOS app bundle.
#   make open-prod      Open the production macOS app bundle.
#   make clean          Remove build artefacts.
#
# Dev-mode two-terminal flow (``make dev``):
#
#     terminal 1:   cd web && bun dev          # Vite :5173 for HMR
#     terminal 2:   cd desktop && make dev     # Tauri shell → bundled sidecar
#
# The Tauri shell no longer points at an implicit dev backend. To use a
# standalone server, add it from the app's Server connection dialog.

.PHONY: sidecar sidecar-v2 sidecar-v3 sidecar-full icons dev dev-bundled build-dev-app build clean open open-prod
.PHONY: dev-bundled-v3 build-dev-app-v3 build-v3

ROOT       := $(abspath ..)
BUNDLE     := sidecar-bundle
PYVER      := 3.14
EXTRAS     ?=                       # set to e.g. "audio,azure-doc-intel,full"
# Sidecar runtime: v2 (Python) or v3 (native Rust).
SIDECAR    ?= v2
EXE        := $(if $(filter Windows_NT,$(OS)),.exe,)

ifeq ($(filter v2 v3,$(SIDECAR)),)
$(error SIDECAR must be v2 or v3, got '$(SIDECAR)')
endif

sidecar: sidecar-$(SIDECAR)

# build_sidecar.py removes the whole bundle dir before building.
sidecar-v2:
	@python3 ../scripts/build_sidecar.py \
		--root "$(ROOT)" \
		--out  "$(BUNDLE)" \
		--python-version "$(PYVER)" \
		$(if $(EXTRAS),--extras "$(EXTRAS)",)

# `dist` = fat LTO (smaller, a few % faster, ~3x slower build); use
# V3_PROFILE=release for quicker local bundles. Profiles keep symbols
# (strip = false), so strip the bundled copy.
V3_PROFILE ?= dist
sidecar-v3:
	cargo build --profile $(V3_PROFILE) --manifest-path ../appv3/Cargo.toml -p appv3-cli
	@rm -rf "$(BUNDLE)"
	@mkdir -p "$(BUNDLE)/bin"
	@cp -f "../appv3/target/$(V3_PROFILE)/openagentd$(EXE)" "$(BUNDLE)/bin/openagentd$(EXE)"
	@if command -v strip >/dev/null 2>&1; then strip "$(BUNDLE)/bin/openagentd$(EXE)"; fi
	@"$(BUNDLE)/bin/openagentd$(EXE)" --version
	@du -sh "$(BUNDLE)"

open:
	@open "src-tauri/target/release/bundle/macos/OpenAgentd (dev).app"

open-prod:
	@open "src-tauri/target/release/bundle/macos/OpenAgentd.app"

sidecar-full:
	@$(MAKE) sidecar-v2 EXTRAS="audio,azure-doc-intel"

icons:
	python3 ../scripts/generate_icons.py

# Dev: load the debug WebView from Vite :5173 and use the same connection
# model as production: bundled sidecar by default, saved external servers
# only when selected from the app.
#
# ``-c tauri.dev.conf.json`` overrides the bundle identifier + product
# name so the dev build coexists with a Homebrew-cask-installed prod
# build (they get separate Dock icons, tray entries, and log dirs).
# Without this, macOS routes ``open -a OpenAgentd`` to whichever
# instance is already running, masking which app you're testing.
dev:
	@echo "→ Tauri dev shell. Make sure Vite (:5173) is running. Backend uses bundled sidecar when available."
	cd src-tauri && cargo tauri dev -c tauri.dev.conf.json

# Dev with the bundled CPython sidecar — the closest thing to ``make build``
# without producing a .dmg. Useful for testing handshake, token injection,
# Job-Object cleanup, and the ``app.cli serve`` entry path.
#
# The XDG roots are pinned to ``<repo>/.openagentd/dev/...`` so the bundled
# sidecar shares state (DB, config, workspace) with ``make dev`` at
# the repo root. Without these overrides ``APP_ENV=development`` would
# resolve them relative to the sidecar's cwd (``desktop/src-tauri/``).
dev-bundled:
	@$(MAKE) sidecar
	cd src-tauri && \
		OPENAGENTD_APP_ENV=development \
		OPENAGENTD_DATA_DIR="$(ROOT)/.openagentd/dev/data" \
		OPENAGENTD_CONFIG_DIR="$(ROOT)/.openagentd/dev/config" \
		OPENAGENTD_STATE_DIR="$(ROOT)/.openagentd/dev/state" \
		OPENAGENTD_CACHE_DIR="$(ROOT)/.openagentd/dev/cache" \
		OPENAGENTD_WORKSPACE_DIR="$(ROOT)/.openagentd/dev/workspace" \
		cargo tauri dev -c tauri.dev-bundled.conf.json

build-dev-app:
	@$(MAKE) sidecar
	cd src-tauri && cargo tauri build -c tauri.dev-bundled.conf.json --bundles app

build:
	cd src-tauri && cargo tauri build

dev-bundled-v3:
	@$(MAKE) dev-bundled SIDECAR=v3

build-dev-app-v3:
	@$(MAKE) build-dev-app SIDECAR=v3

build-v3:
	@$(MAKE) sidecar-v3
	@$(MAKE) build

clean:
	rm -rf "$(BUNDLE)" src-tauri/target
