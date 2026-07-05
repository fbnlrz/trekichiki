# Publishing the Famichiki Counter to the TREK-Plugins registry

This guide takes you from this repository to a live listing in the
[TREK-Plugins](https://github.com/mauriceboe/TREK-Plugins) community registry.

**How TREK distribution works:** your plugin's code, README, screenshot and
release artifact live in **this repo** (`fbnlrz/trekichiki`). The registry only
stores one small metadata file per plugin — `registry/plugins/trekichiki.json`.
"Getting listed" means opening a pull request that adds that one file. TREK
instances then fetch the registry index and can install your release.

---

## 0. One-time prerequisites (on your PC)

| Need | Check | Get it |
|---|---|---|
| **Node ≥ 18** | `node -v` | https://nodejs.org |
| **git** | `git --version` | https://git-scm.com |
| **GitHub CLI, logged in** | `gh auth status` | https://cli.github.com → `gh auth login` |
| **This repo is PUBLIC** | open the repo page while logged out | GitHub → Settings → change visibility to Public |

> The registry CI downloads your release asset and reads `trek-plugin.json` from
> your repo at the tagged commit. Both must be publicly reachable, so the repo
> **must be public** before you publish.

---

## 1. Get the code onto your PC and merged to `main`

The commit you publish must exist on the public repo. Cleanest is to have it on
`main`:

```bash
git clone https://github.com/fbnlrz/trekichiki.git
cd trekichiki

# If the widget is still on the feature branch, merge it into main:
git checkout main
git merge --ff-only origin/claude/famichiki-counter-widget-jmlkt5   # or open & merge a PR on GitHub
git push origin main
```

(If you merged a PR on GitHub instead, just `git checkout main && git pull`.)

---

## 2. Publish — the one command

From the repo root:

```bash
npm run release              # convenience wrapper, see scripts/publish.sh
```

or call the SDK directly:

```bash
npx trek-plugin-sdk publish --repo fbnlrz/trekichiki --tag v1.0.0
```

That single command does **everything**:

1. **pack** → builds `plugin.zip` in the exact install layout and computes its `sha256`
2. **tag + release** → creates git tag `v1.0.0` and a GitHub Release with `plugin.zip` attached
3. **preflight** → runs the *entire* registry CI locally (tag→commit, manifest parity, sha256/size, native-binary scan, README quality gate)
4. **submit** → forks `mauriceboe/TREK-Plugins`, writes `registry/plugins/trekichiki.json`, pushes, and **opens the PR** — printing its URL

If preflight finds a problem it **stops before opening the PR**, so a broken
entry never becomes a doomed pull request. Fix what it reports and re-run.

> **The tag must equal the manifest version.** This repo is at `version: 1.0.0`,
> so the tag is `v1.0.0`. `npm run release` reads the version from
> `trek-plugin.json` for you, so it always matches.

When the PR is merged, a TREK maintainer's CI stamps it, regenerates the public
index, and your plugin is discoverable under **Admin → Plugins → Discover** in
any TREK instance.

---

## 3. (Recommended) Sign your release

A signature proves *you* built the bytes (a compromised registry still can't
ship code under your name). One-time key, then add `--sign`:

```bash
npx trek-plugin-sdk keygen           # once → ~/.trek-plugin/signing.key
#  ⚠️  BACK THIS FILE UP. Losing it means you can't ship signed updates.

npm run release -- --sign            # or: npx trek-plugin-sdk publish --repo fbnlrz/trekichiki --tag v1.0.0 --sign
```

Signing is a one-way door: once you've shipped signed, an unsigned or
differently-keyed update is refused until an admin re-trusts it. Keep the key
stable and backed up.

---

## 4. Manual path (if you prefer to see every step)

```bash
npx trek-plugin-sdk pack .                                   # → plugin.zip + sha256
gh release create v1.0.0 plugin.zip --title "Famichiki Counter v1.0.0" --notes "First release"
npx trek-plugin-sdk entry --repo fbnlrz/trekichiki --tag v1.0.0 \
  --out registry/plugins/trekichiki.json                     # fills commitSha/downloadUrl/sha256/size…
npx trek-plugin-sdk preflight --repo fbnlrz/trekichiki --tag v1.0.0   # must be green
# then fork mauriceboe/TREK-Plugins, add ONLY registry/plugins/trekichiki.json, open the PR
```

**PR rule:** the pull request must change **exactly one file** —
`registry/plugins/trekichiki.json`. Never touch `dist/` or set
`reviewedAt`/`boundOwner`; the registry CI owns those.

---

## 5. Shipping an update later (v1.1.0, …)

```bash
# 1. bump "version" to 1.1.0 in trek-plugin.json, make your changes, commit, push to main
npm run release              # reads 1.1.0 → tags v1.1.0 → release → preflight → PR (merges the new
                             # version onto your existing entry, newest first)
```

If a new version requests **more** permissions, admins must re-approve it on
their instance before it activates.

---

## Troubleshooting (common CI gates)

| Symptom | Cause | Fix |
|---|---|---|
| `gitTag does not resolve` | tag not pushed, or ≠ manifest version | use `npm run release` (derives the tag); ensure `git push` ran |
| `manifest parity` fails | repo not public, or tagged commit not pushed | make repo public; publish from a committed, pushed HEAD |
| `sha256 mismatch` | release asset was re-uploaded/edited | never mutate a released `plugin.zip` — bump the version and cut a new release |
| README gate fails | missing section / screenshot / a declared permission not explained | keep the **What it does / Screenshots / Permissions / Setup** sections and `docs/screenshot.png` (already in place here) |
| `egress` gate | `http:outbound*` permission without `egress[]` | not applicable — this plugin makes no network calls |
| `gh: not authenticated` | `gh auth login` not done | run `gh auth login`, then retry |

Full reference: the TREK wiki
[Plugin-Publishing](https://github.com/mauriceboe/TREK/wiki/Plugin-Publishing)
page and the registry's `schema/plugin-entry.schema.json`.
