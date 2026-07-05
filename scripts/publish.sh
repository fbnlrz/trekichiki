#!/usr/bin/env bash
#
# One-command release for the Famichiki Counter TREK plugin.
#
#   ./scripts/publish.sh            # pack → tag → GitHub release → preflight → registry PR
#   ./scripts/publish.sh --sign     # same, but sign the artifact (recommended)
#
# The git tag is derived from "version" in trek-plugin.json, so tag == version
# is guaranteed. Run it from the repo root, from a clean, pushed commit.
#
set -euo pipefail

REPO="fbnlrz/trekichiki"

# --- locate repo root & manifest -------------------------------------------
cd "$(dirname "$0")/.."
if [[ ! -f trek-plugin.json ]]; then
  echo "✗ trek-plugin.json not found — run this from the repo root." >&2
  exit 1
fi

VERSION="$(node -p "require('./trek-plugin.json').version")"
TAG="v${VERSION}"

echo "▸ Plugin:  $(node -p "require('./trek-plugin.json').id") ${VERSION}"
echo "▸ Repo:    ${REPO}"
echo "▸ Tag:     ${TAG}"
echo

# --- preflight checks on the environment -----------------------------------
command -v gh >/dev/null 2>&1 || { echo "✗ GitHub CLI (gh) not installed → https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "✗ Not logged in to GitHub → run: gh auth login" >&2; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree has uncommitted changes. Commit & push first, then publish." >&2
  exit 1
fi

# warn (don't block) if the current commit isn't on the remote yet
if ! git branch -r --contains HEAD 2>/dev/null | grep -q .; then
  echo "⚠  Current commit doesn't appear to be pushed. The registry CI reads your"
  echo "   repo at the tagged commit, so push it first (e.g. git push origin main)."
  read -r -p "   Continue anyway? [y/N] " ok
  [[ "${ok:-N}" == [yY] ]] || exit 1
fi

# --- go --------------------------------------------------------------------
echo "▸ Running: npx trek-plugin-sdk publish --repo ${REPO} --tag ${TAG} $*"
echo
npx --yes trek-plugin-sdk publish --repo "${REPO}" --tag "${TAG}" "$@"
