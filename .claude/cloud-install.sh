#!/bin/bash
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# the pnpm the setup script installed, pinned by `packageManager`
ver=$(sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\).*/\1/p' package.json)
[ -n "$ver" ] || { echo "cloud-install: no pnpm pin in packageManager" >&2; exit 1; }
exe="${PNPM_HOME:-$HOME/.local/share/pnpm}/.tools/pnpm-exe/$ver/pnpm"

# link the binary, not the `pnpm` wrapper in PNPM_HOME: the wrapper resolves the
# binary beside its own path, so a link to it breaks.
bin="$HOME/.kru-bin"
mkdir -p "$bin"
ln -sf "$exe" "$bin/pnpm"
# the setup script installs the repo's node (`.nvmrc`) into /usr/local, but nvm and
# the image's /opt/node22/bin come first on PATH and would run every command on 22.
node_bin=/usr/local/bin/node
if ! "$node_bin" --version 2>/dev/null | grep -q "^v$(cat .nvmrc)\."; then
  rm -f "$bin/node"
  echo "cloud-install: $node_bin is not node $(cat .nvmrc); rerun the setup script" >&2
  exit 1
fi
ln -sf "$node_bin" "$bin/node"
start_path=$PATH
export PATH="$bin:$PATH"

# later shells: Bash tool commands source CLAUDE_ENV_FILE, and a nested `bash -lc`
# or `bash -ic` reruns nvm's init, so the line goes last in all three files. Without
# it they find the image's pnpm, which self-switches to `packageManager` with
# lifecycle scripts off, and turbo, which spawns that placeholder directly, fails
# with `Exec format error`.
pin="export PATH=\"$bin:\$PATH\""
login_rc=$HOME/.profile
for f in "$HOME/.bash_profile" "$HOME/.bash_login"; do [ -f "$f" ] && { login_rc=$f; break; }; done
# other SessionStart hooks append to CLAUDE_ENV_FILE too, so append there, never rewrite
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ "$(tail -n 1 "$CLAUDE_ENV_FILE" 2>/dev/null)" != "$pin" ]; then
  echo "$pin" >> "$CLAUDE_ENV_FILE"
fi
for rc in "$HOME/.bashrc" "$login_rc"; do
  touch "$rc"
  rest=$(grep -vxF "$pin" "$rc" || true)
  { [ -z "$rest" ] || printf '%s\n' "$rest"; printf '%s\n' "$pin"; } > "$rc"
done
check() {
  got=$(env PATH="$start_path" bash "$@" </dev/null 2>/dev/null | tail -n 1)
  [ "$got" = "$bin/node" ] || { echo "cloud-install: a new 'bash $1' runs node from '$got', not $bin/node" >&2; exit 1; }
}
check -lc 'command -v node'
check -ic 'command -v node'
[ -z "${CLAUDE_ENV_FILE:-}" ] || check -c '. "$1"; command -v node' _ "$CLAUDE_ENV_FILE"

pnpm install --frozen-lockfile
