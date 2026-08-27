# Publishing the Famichiki Counter to the TREK-Plugins registry

This guide takes you from this repository to a live listing in the
[TREK-Plugins](https://github.com/liketrek/TREK-Plugins) community registry.

**How TREK distribution works:** your plugin's code, README, screenshot and
release artifact live in **this repo** (`fbnlrz/trekichiki`). The registry only
stores one small metadata file per plugin — `registry/plugins/trekichiki.json`.
"Getting listed" means opening a pull request that adds that one file. TREK
instances then fetch the registry index and can install your release.

> The SDK's default registry is `liketrek/TREK-Plugins`. Earlier releases of this
> plugin were submitted under the project's former `mauriceboe/…` name. If the
> default ever points somewhere else than you expect, pass `--registry <owner/name>`.

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

## 1. Commit and push what you are publishing

**The registry grades the tagged commit, not your working tree.** The classic
failure is a README that is perfect on disk and missing from the commit, which
passes `validate` locally and then fails `preflight` at the pinned commit.

```bash
git checkout main
git add -A && git commit -m "Famichiki Counter 2.0.0"
git push origin main
```

---

## 2. Where am I? — `status`

```bash
npm run status               # npx trek-plugin-sdk status .
```

`status` never fails; it grades every gate that can be answered offline
(Manifest / Code / Docs / Release / Repo) and names exactly one next command.
`npm run validate` runs the same checks as a real gate with an exit code, which
is what CI wants.

---

## 3. Publish — the one command

From the repo root:

```bash
npm run release              # cross-platform wrapper (node scripts/publish.mjs)
```

> **Windows note:** `npm run release` uses a Node wrapper, so it works in
> PowerShell/CMD. You still need **GitHub CLI** installed
> (`winget install --id GitHub.cli -e`) and authenticated (`gh auth login`);
> a `spawnSync gh ENOENT` error means it isn't on your PATH yet.

or call the SDK directly:

```bash
npx trek-plugin-sdk publish --repo fbnlrz/trekichiki --tag v2.0.0 --sign
```

That single command runs **five** steps, in this order:

1. **check** → every offline gate (manifest, lucide icon, README quality, screenshot on disk, permission parity)
2. **pack** → builds `plugin.zip` in the exact install layout and computes its `sha256`
3. **release** → creates git tag `v2.0.0` and a GitHub Release with `plugin.zip` attached
4. **preflight** → runs the *entire* registry CI (tag→commit, manifest parity, artifact download + sha256, native-binary scan, **README re-graded at the pinned commit**, owner binding, signature checks)
5. **submit** → forks the registry, writes `registry/plugins/trekichiki.json`, pushes, and **opens the PR** — printing its URL

If a step-1 gate fails, **nothing** is packed, tagged, pushed or released. If a
*later* step fails, `publish` **rolls back what this run created** — the
release, the remote tag and the local tag — so you fix the problem and re-run
against the **same version**. (`--keep-release` opts out of the rollback;
`unrelease <tag>` cleans up a release that was already stranded.)

> **The tag must equal the manifest version.** This repo is at `version: 2.0.0`,
> so the tag is `v2.0.0`. `npm run release` reads the version from
> `trek-plugin.json` for you, so it always matches.

When the PR is merged, the registry CI stamps it, regenerates the public index,
and your plugin is discoverable under **Admin → Plugins → Discover** in any TREK
instance. Admins see the update on their next registry poll; applying it is an
explicit action, and because 2.0.0 requests **more permissions than 1.x**, every
admin has to re-approve it before it activates.

---

## 4. Signing — say yes

A signature proves *you* built the bytes; the `sha256` pin only proves they are
what the registry served. Only the signature survives a compromised registry.

In a terminal, `publish` **offers to sign and creates the key for you** — just
say yes. In scripts or CI, which are never prompted, pass `--sign`:

```bash
npx trek-plugin-sdk keygen           # optional, by hand → ~/.trek-plugin/signing.key
#  ⚠️  BACK THIS FILE UP. One key covers all your plugins, forever.

npm run release -- --sign
```

**Signing late is fine.** This plugin's 1.x releases are unsigned, and going
unsigned → signed at 2.0.0 breaks nobody: nothing is pinned until a signed
version installs. The SDK **retro-signs the older versions automatically** on
the first signed update — it downloads each pinned artifact, verifies it against
its recorded `sha256`, and signs it with the same key (a mismatch aborts the
run), because the registry requires every version signed once a key is present.

What you cannot do is **stop**. Once a plugin has shipped signed, TREK refuses —
on every instance that already has it — an update that drops the key, changes
the key, or ships unsigned. A key *rotation* is recoverable (a maintainer applies
`allow-key-change` and every admin re-trusts); a dropped key has no override at
all. So back the key up.

---

## 5. Manual path (if you prefer to see every step)

```bash
npx trek-plugin-sdk pack .                                   # → plugin.zip + sha256
gh release create v2.0.0 plugin.zip --title "Famichiki Counter v2.0.0" --notes "…"
git fetch origin --tags                                      # ← REQUIRED: gh creates the tag
                                                             #   remotely only, and `entry`
                                                             #   resolves it locally
npx trek-plugin-sdk entry --repo fbnlrz/trekichiki --tag v2.0.0 --sign \
  --merge registry/plugins/trekichiki.json \
  --out registry/plugins/trekichiki.json                     # newest version first
npx trek-plugin-sdk preflight --repo fbnlrz/trekichiki --tag v2.0.0   # must be green
# then fork the registry, add ONLY registry/plugins/trekichiki.json, open the PR
```

`entry` hashes your **local** `plugin.zip`, so it has to be byte-identical to
the asset you uploaded — never re-pack in between. On a hand-written entry, take
`sha256` and `size` from the uploaded asset itself.

**PR rule:** the pull request must change **exactly one file** —
`registry/plugins/trekichiki.json`. Never touch `dist/` or set
`reviewedAt`/`boundOwner`; the registry CI owns those. Leave the older
`versions[]` blocks alone — CI re-validates all of them, over the network.

---

## 6. Shipping an update later (2.1.0, …)

```bash
# 1. bump "version" in trek-plugin.json AND package.json, make your changes
# 2. commit and push — the commit is what gets graded
npm run release -- --sign    # reads the version → tags → release → preflight → PR
```

Remember that the `trek` range in the manifest is enforced at install **and** at
activation, with no admin override. This version declares `>=4.0.0 <5.0.0`, so
TREK 3.x instances keep resolving "install latest" to 1.0.3 rather than breaking.

---

## Troubleshooting (common CI gates)

| Symptom | Cause | Fix |
|---|---|---|
| `could not resolve the commit for tag` | `gh` created the tag remotely only | `git fetch origin --tags` before `entry`/`preflight` |
| `gitTag does not resolve` | tag not pushed, or ≠ manifest version | use `npm run release` (derives the tag); ensure `git push` ran |
| `manifest parity` fails | repo not public, or tagged commit not pushed | make repo public; publish from a committed, pushed HEAD |
| `sha256 mismatch` | release asset re-uploaded, or entry hashed a re-pack | never mutate a released `plugin.zip`; bump the version and cut a new release |
| README gate fails | missing section, <400 chars of prose, placeholder left, screenshot unreachable, or a declared permission not named | keep all four sections, real prose, `docs/screenshot.png` committed, and every permission string present verbatim |
| `icon` rejected | not a real lucide name | `validate` catches this offline — an unknown name silently falls back to `Blocks` in TREK |
| `egress` gate | `http:outbound*` permission without `egress[]` | not applicable — this plugin makes no network calls |
| `release already exists` | re-running without a version bump | bump the version, or `unrelease <tag>` first |
| `gh: not authenticated` | `gh auth login` not done | run `gh auth login`, then retry |

Full reference: the TREK wiki
[Plugin-Publishing](https://github.com/liketrek/TREK/wiki/Plugin-Publishing)
page and the registry's `schema/plugin-entry.schema.json`.
