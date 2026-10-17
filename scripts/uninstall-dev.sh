#!/bin/sh
# Remove the development link and this plugin's Loader entry.
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROOT="${DSH_PLUGIN_DIR:-$REPO/packages/dsh-plugin-phone-bridge}"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PATCH="$PROFILE_DIR/cordis.patch.yml"
PACKAGE="dsh-plugin-phone-bridge"
PLUGIN_ID="phone-bridge"
LINK="$PROFILE_DIR/node_modules/$PACKAGE"

if [ -L "$LINK" ]; then
  if [ "$(readlink "$LINK")" = "$ROOT" ]; then
    rm "$LINK"
    echo "Removed link $LINK"
  else
    echo "Refusing to remove $LINK: it points at $(readlink "$LINK"), not $ROOT" >&2
  fi
elif [ -e "$LINK" ]; then
  echo "Refusing to remove $LINK: not a development symlink" >&2
else
  echo "No link at $LINK"
fi

if [ -f "$PATCH" ]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  cp "$PATCH" "$PATCH.bak-$STAMP"
  node - "$PATCH" "$PACKAGE" "$PLUGIN_ID" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [patchPath, packageName, pluginId] = process.argv.slice(2)
const current = readFileSync(patchPath, 'utf8')
const commented = `# ${packageName} development link (scripts/install-dev.sh)\n- insert:\n    - id: ${pluginId}\n      name: ${packageName}\n`
const bare = `- insert:\n    - id: ${pluginId}\n      name: ${packageName}\n`
let updated = current
updated = updated.replace(`\n\n${commented}`, '\n')
updated = updated.replace(commented, '')
updated = updated.replace(`\n\n${bare}`, '\n')
updated = updated.replace(bare, '')
updated = updated.replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '')
// A comments-only patch is not a YAML sequence; restore the empty array the
// profile template ships so the next boot still parses it.
if (!/^\s*-\s+\S/mu.test(updated)) updated += '\n[]'
updated += '\n'
if (updated !== current) {
  writeFileSync(patchPath, updated)
  console.log('Removed the Loader entry')
} else {
  console.log('No managed Loader block found')
}
NODE
  echo "Profile patch backup: $PATCH.bak-$STAMP"
fi

echo "Done. The Host may unload the bridge immediately; if 8787 remains,"
echo "restart DeepSeek Harness when no turn or job is running."
