#!/usr/bin/env bash
#
# build.sh — bundle the Hive desktop app and stage it into ~/hive-up.
#
# Produces a runnable Electron "linux-unpacked" tree at ~/hive-up, mirroring the
# layout of ~/hive (the `hive` executable + runtime files sit at the top level).
# Run it with:  ~/hive-up/hive
#
set -euo pipefail

PNPM_VERSION="10.24.0"

# Repo root = directory containing this script (so it works from anywhere).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT_DIR="$SCRIPT_DIR/.build"            # electron-builder output dir
UNPACKED="$OUT_DIR/linux-unpacked"      # the unpacked app it produces
DEST="$HOME/hive-up"                    # final staging location

# electron-builder's node-module collector shells out to `pnpm`. This repo pins
# pnpm via `npx pnpm@<ver>` and may have no global pnpm, so provide a shim on
# PATH for the duration of the build.
if ! command -v pnpm >/dev/null 2>&1; then
  SHIM_DIR="$(mktemp -d)"
  cat > "$SHIM_DIR/pnpm" <<EOF
#!/bin/sh
exec npx -y pnpm@${PNPM_VERSION} "\$@"
EOF
  chmod +x "$SHIM_DIR/pnpm"
  export PATH="$SHIM_DIR:$PATH"
  trap 'rm -rf "$SHIM_DIR"' EXIT
fi

echo "==> [1/3] Compiling renderer/main/preload (electron-vite build)…"
npx pnpm@"${PNPM_VERSION}" run build

echo "==> [2/3] Packaging unpacked app (electron-builder --dir)…"
npx electron-builder --dir -c.directories.output="$OUT_DIR"

if [ ! -x "$UNPACKED/hive" ]; then
  echo "ERROR: expected executable not found at $UNPACKED/hive" >&2
  exit 1
fi

echo "==> [3/3] Staging into $DEST …"
# Build succeeded before this point, so it is safe to replace the destination.
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$UNPACKED/." "$DEST/"

echo
echo "Done. Launch with:"
echo "    $DEST/hive"
