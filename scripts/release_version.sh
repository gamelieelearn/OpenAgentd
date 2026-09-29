#!/bin/sh
# Print the release version: the [workspace.package] version in
# appv3/Cargo.toml. Every other release-facing version (web, desktop, mobile)
# follows it; scripts/check_version_consistency.sh enforces that.
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version = "\([^"]*\)".*/\1/p;}' "$ROOT_DIR/appv3/Cargo.toml")
if [ -z "$version" ]; then
    echo "error: no [workspace.package] version in appv3/Cargo.toml" >&2
    exit 1
fi
printf '%s\n' "$version"
