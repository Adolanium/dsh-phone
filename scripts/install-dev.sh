#!/bin/sh
# Link this checkout into a DSH profile so the Host loads the bridge from
# source. The desktop profile is the default; set DSH_PROFILE_DIR to target
# another profile (for example a disposable test profile).
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROOT="${DSH_PLUGIN_DIR:-$REPO/packages/dsh-plugin-phone-bridge}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PATCH="$PROFILE_DIR/cordis.patch.yml"
PACKAGE="dsh-plugin-phone-bridge"
PLUGIN_ID="phone-bridge"
LINK="$PROFILE_DIR/node_modules/$PACKAGE"

if [ ! -f "$PATCH" ]; then
  echo "No profile patch at $PATCH" >&2
  echo "Start DeepSeek Harness once, or set DSH_PROFILE_DIR to another profile." >&2
  exit 1
fi

for required in package.json lib/index.js lib/client.js cordis.patch.yml; do
  if [ ! -f "$ROOT/$required" ]; then
    echo "Not a complete plugin checkout: missing $required" >&2
    exit 1
  fi
done

mkdir -p "$PROFILE_DIR/node_modules"
if [ -L "$LINK" ]; then
  if [ "$(readlink "$LINK")" = "$ROOT" ]; then
    echo "Link already present: $LINK"
  else
    echo "Refusing to replace existing symlink $LINK -> $(readlink "$LINK")" >&2
    exit 1
  fi
elif [ -e "$LINK" ]; then
  echo "Refusing to replace existing $LINK (not a symlink)" >&2
  exit 1
else
  ln -s "$ROOT" "$LINK"
  echo "Linked $LINK -> $ROOT"
fi

if grep -q "name: $PACKAGE" "$PATCH"; then
  echo "Loader entry already present in $PATCH"
else
  STAMP=$(date +%Y%m%d-%H%M%S)
  cp "$PATCH" "$PATCH.bak-$STAMP"
  node - "$PATCH" "$PACKAGE" "$PLUGIN_ID" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [patchPath, packageName, pluginId] = process.argv.slice(2)
const current = readFileSync(patchPath, 'utf8')
const block = `# ${packageName} development link (scripts/install-dev.sh)\n- insert:\n    - id: ${pluginId}\n      name: ${packageName}\n`
let updated
if (/^\[\]\s*$/m.test(current)) {
  updated = `${current.replace(/^\[\]\s*$/m, '').replace(/\s+$/u, '')}\n\n${block}`
} else {
  updated = `${current.replace(/\s+$/u, '')}\n\n${block}`
}
writeFileSync(patchPath, updated)
NODE
  echo "Added the Loader entry to $PATCH (backup: $PATCH.bak-$STAMP)"
fi

echo
echo "Linked $ROOT"
echo "The desktop profile watches its patch layer, so the Host may load the"
echo "bridge without a restart. If 8787 does not appear, restart DeepSeek"
echo "Harness when no turn or job is running."
echo
echo "Open Settings → Phone in DSH to see the QR, pairing code, device list,"
echo "and diagnostics. The listener returns 401 until a device is paired."
echo "The iPhone app lives in apps/ios."
echo "Health check:"
echo "  curl http://\$(tailscale ip -4):8787/__health"
