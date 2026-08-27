#!/usr/bin/env node
/*
 * Cross-platform one-command release for the Famichiki Counter TREK plugin.
 * Works on Windows (PowerShell/CMD), macOS and Linux — no bash required.
 *
 *   npm run release            # check -> pack -> tag + GitHub release -> preflight -> registry PR
 *   npm run release -- --sign  # same, but sign the artifact
 *
 * A failed check (step 1) releases nothing at all; a failure in preflight or the
 * PR step rolls back the release and tags this run created, so you fix and re-run
 * against the same version.
 *
 * Signing: this wrapper runs the SDK with inherited stdio, so `publish` is
 * interactive and OFFERS to sign, creating the key for you — `--sign` is only
 * needed non-interactively (CI). The first signed release also retro-signs the
 * already-published unsigned versions.
 *
 * The git tag is derived from "version" in trek-plugin.json, so tag == version
 * is guaranteed. Run from the repo root, on a clean, pushed commit.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = 'fbnlrz/trekichiki';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  // shell:true so `npx`/`gh` resolve to .cmd shims on Windows
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, ...opts });
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function die(msg) { console.error('✗ ' + msg); process.exit(1); }

// --- read version -> tag ----------------------------------------------------
let version;
try {
  version = JSON.parse(readFileSync(join(root, 'trek-plugin.json'), 'utf8')).version;
} catch {
  die('trek-plugin.json not found or invalid — run this from the repo root.');
}
const tag = 'v' + version;

console.log(`▸ Repo: ${REPO}`);
console.log(`▸ Tag:  ${tag}  (from trek-plugin.json version ${version})\n`);

// --- environment checks -----------------------------------------------------
if (capture('gh', ['--version']).code !== 0)
  die('GitHub CLI (gh) not found → https://cli.github.com');
if (capture('gh', ['auth', 'status']).code !== 0)
  die('Not logged in to GitHub → run: gh auth login');
if (capture('git', ['status', '--porcelain']).out !== '')
  die('Working tree has uncommitted changes. Commit & push first, then release.');
if (capture('git', ['branch', '-r', '--contains', 'HEAD']).out === '')
  console.warn('⚠  Current commit may not be pushed yet — push it so the registry CI can read it.\n');

// --- go ---------------------------------------------------------------------
const passthrough = process.argv.slice(2); // e.g. --sign
const args = ['--yes', 'trek-plugin-sdk', 'publish', '--repo', REPO, '--tag', tag, ...passthrough];
console.log('▸ npx ' + args.join(' ') + '\n');
const res = run('npx', args);
process.exit(res.status ?? 1);
