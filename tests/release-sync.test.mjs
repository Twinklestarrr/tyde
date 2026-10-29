import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/sync-release-to-upstream.yml', import.meta.url),
  'utf8',
);
const mergeScript = workflow.match(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/m)[1].replace(/^ {10}/gm, '');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Release sync test',
  GIT_AUTHOR_EMAIL: 'sync-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release sync test',
  GIT_COMMITTER_EMAIL: 'sync-test@example.invalid',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const runMerge = (cwd) =>
  spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', mergeScript], {
    cwd,
    env,
    encoding: 'utf8',
  });

function fixture(t, { conflict = false, backport = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tyde-release-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, 'seed');
  const source = join(root, 'source');
  const target = join(root, 'target');
  const remote = join(root, 'production.git');
  git(root, 'init', '--initial-branch=main', seed);
  writeFileSync(join(seed, 'common.txt'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'base');
  git(root, 'clone', '--bare', seed, remote);
  git(root, 'clone', seed, source);
  git(source, 'switch', '-c', 'release');
  writeFileSync(join(source, conflict ? 'common.txt' : 'release.txt'), 'release\n');
  if (backport && !conflict) writeFileSync(join(source, 'production.txt'), 'production\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'release change');
  git(root, 'clone', remote, target);
  writeFileSync(join(target, conflict ? 'common.txt' : 'production.txt'), 'production\n');
  git(target, 'add', '.');
  git(target, 'commit', '-m', 'production-only fix');
  git(target, 'push', 'origin', 'main');
  return { root, source, target, remote };
}

test('release merge retains both histories and reruns without empty commits', (t) => {
  const { source, target, remote } = fixture(t);
  const productionHead = git(remote, 'rev-parse', 'main');
  const result = runMerge(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, 'show', 'main:release.txt'), 'release');
  assert.equal(git(remote, 'show', 'main:production.txt'), 'production');
  assert.equal(git(remote, 'rev-parse', 'main^{tree}'), git(source, 'rev-parse', 'HEAD^{tree}'));
  git(remote, 'merge-base', '--is-ancestor', productionHead, 'main');
  assert.equal(git(remote, 'rev-parse', 'main^2'), git(source, 'rev-parse', 'HEAD'));
  const mergedHead = git(remote, 'rev-parse', 'main');
  const retry = runMerge(target);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(git(remote, 'rev-parse', 'main'), mergedHead);
});

test('conflicting release fails without changing production main', (t) => {
  const { target, remote } = fixture(t, { conflict: true });
  const before = git(remote, 'rev-parse', 'main');
  assert.notEqual(runMerge(target).status, 0);
  assert.equal(git(remote, 'rev-parse', 'main'), before);
});

test('production-only changes must be backported to release before publishing', (t) => {
  const { target, remote } = fixture(t, { backport: false });
  const before = git(remote, 'rev-parse', 'main');
  const result = runMerge(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Production main contains changes missing from release/);
  assert.equal(git(remote, 'rev-parse', 'main'), before);
});

test('a concurrent production update is rejected without overwriting it', (t) => {
  const { root, target, remote } = fixture(t);
  const other = join(root, 'other');
  git(root, 'clone', remote, other);
  writeFileSync(join(other, 'concurrent.txt'), 'another production fix\n');
  git(other, 'add', '.');
  git(other, 'commit', '-m', 'concurrent production update');
  git(other, 'push', 'origin', 'main');
  const before = git(remote, 'rev-parse', 'main');
  assert.notEqual(runMerge(target).status, 0);
  assert.equal(git(remote, 'rev-parse', 'main'), before);
  assert.equal(git(remote, 'show', 'main:concurrent.txt'), 'another production fix');
});
