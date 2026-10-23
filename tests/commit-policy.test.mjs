import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/check-commit-policy.mjs', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tyde-commit-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  delete env.TYDE_COMMIT_POLICY_FILE;
  const git = (...args) =>
    execFileSync('git', ['-c', `core.hooksPath=${join(directory, 'hooks')}`, ...args], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  git('init', '--quiet');
  const policyFile = join(directory, 'policy.json');
  writeFileSync(policyFile, JSON.stringify({ terms: ['Moonstone'] }));
  const write = (name, value) => {
    const path = join(repo, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };
  const run = (args = ['staged'], policy = policyFile, cwd = repo) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: { ...env, ...(policy === null ? {} : { TYDE_COMMIT_POLICY_FILE: policy }) },
      encoding: 'utf8',
    });
  return { directory, repo, git, policyFile, write, run };
}

function rejected(result) {
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /moonstone/i);
}

const digest = `Moonstone${'A'.repeat(77)}==`;
const integrity = `sha512-${digest}`;
const lockfile = (value = integrity) =>
  `lockfileVersion: '9.0'\n\npackages:\n\n  public-package@1.0.0:\n    resolution: {integrity: ${value}}\n\nsnapshots: {}\n`;

test('合法锁文件摘要的字面碰撞不误报，检查不修改索引或工作区', (t) => {
  const { git, write, run } = fixture(t);
  for (const [algorithm, value] of [
    ['sha1', `Moonstone${'A'.repeat(18)}=`],
    ['sha256', `Moonstone${'A'.repeat(34)}=`],
    ['sha384', `Moonstone${'A'.repeat(55)}`],
    ['sha512', digest],
  ]) {
    const content = lockfile(`${algorithm}-${value}`);
    const path = write('pnpm-lock.yaml', content);
    git('add', 'pnpm-lock.yaml');
    const index = git('ls-files', '--stage', '-z');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(git('ls-files', '--stage', '-z'), index);
    assert.equal(readFileSync(path, 'utf8'), content);
  }
});

test('弃用说明的普通文本引号不使合法摘要误报', (t) => {
  const { git, write, run } = fixture(t);
  for (const description of [
    "Use the platform's native API instead",
    'Use the "public-api" package instead',
  ]) {
    const content = lockfile().replace(
      '\n\nsnapshots:',
      `\n    deprecated: ${description}\n\nsnapshots:`,
    );
    const path = write('pnpm-lock.yaml', content);
    git('add', 'pnpm-lock.yaml');
    const index = git('ls-files', '--stage', '-z');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(git('ls-files', '--stage', '-z'), index);
    assert.equal(readFileSync(path, 'utf8'), content);
  }
});

test('不合法或不支持的摘要仍完整检查', (t) => {
  const { git, write, run } = fixture(t);
  for (const value of [
    `sha999-${digest}`,
    `SHA512-${digest}`,
    `sha512-${digest.slice(0, -4)}`,
    `sha512-${digest.replace(/==$/, 'B==')}`,
    `sha512-${digest.replace(/A==$/, 'B==')}`,
    `sha512-${digest.replace(/==$/, '=')}`,
    `sha512-${digest.replace(/==$/, '!')}`,
    `${integrity} ${integrity}`,
    `${integrity}?option`,
  ]) {
    write('pnpm-lock.yaml', lockfile(value));
    git('add', 'pnpm-lock.yaml');
    rejected(run());
  }
});

test('仍检查锁文件的包名、地址、旁注及其他字段', (t) => {
  const { git, write, run } = fixture(t);
  for (const content of [
    lockfile().replace('public-package@', 'Moonstone@'),
    lockfile().replace('}\n\nsnapshots', '} # Moonstone\n\nsnapshots'),
    lockfile().replace(
      '}\n\nsnapshots',
      ', tarball: https://moonstone.example.test/pkg.tgz}\n\nsnapshots',
    ),
    lockfile().replace(
      '}\n\nsnapshots',
      '}\n    tarball: https://moonstone.example.test/pkg.tgz\n\nsnapshots',
    ),
    lockfile().replace('\n\nsnapshots:', "\n    deprecated: Use Moonstone's API\n\nsnapshots:"),
    lockfile().replace('\n\nsnapshots:', '\n    deprecated: Use "Moonstone" instead\n\nsnapshots:'),
    `${lockfile()}note: Moonstone\n`,
  ]) {
    write('pnpm-lock.yaml', content);
    git('add', 'pnpm-lock.yaml');
    rejected(run());
  }
});

test('只识别根锁文件的包解析字段，不豁免其它路径或伪造上下文', (t) => {
  const { git, write, run } = fixture(t);
  for (const name of ['note.txt', 'docs/pnpm-lock.yaml', 'package-lock.json']) {
    write(name, lockfile());
    git('add', name);
    rejected(run());
    git('rm', '--cached', '--quiet', name);
  }
  for (const content of [
    lockfile().replace('packages:', 'importers:'),
    lockfile().replace('packages:', 'snapshots:'),
    lockfile().replace('resolution:', 'note:'),
    lockfile().replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"),
    lockfile().replace('packages:', 'note: "\n    deprecated: public text\npackages:') + '"\n',
    lockfile().replace(
      'public-package@1.0.0:\n',
      'public-package@1.0.0:\n    deprecated: public: "\n',
    ) + '    deprecated: public end "\n',
    lockfile().replace(
      'packages:',
      "importers:\n  example:\n    deprecated: publisher's note\npackages:",
    ),
    `${lockfile()}note: publisher's unsupported scalar\n`,
    lockfile().replace('packages:', 'note: "\npackages:') + '"\n',
  ]) {
    write('pnpm-lock.yaml', content);
    git('add', 'pnpm-lock.yaml');
    rejected(run());
  }
});

test('同名符号链接目标及提交说明中的摘要仍完整检查', (t) => {
  const { directory, repo, git, run } = fixture(t);
  symlinkSync(lockfile(), join(repo, 'pnpm-lock.yaml'));
  git('add', 'pnpm-lock.yaml');
  rejected(run());
  const message = join(directory, 'message');
  writeFileSync(message, `chore: ${integrity}`);
  rejected(run(['commit-msg', message]));
});

test('摘要豁免依据暂存版本，不被工作区锁文件掩盖', (t) => {
  const { git, write, run } = fixture(t);
  write('pnpm-lock.yaml', `${lockfile()}note: Moonstone\n`);
  git('add', 'pnpm-lock.yaml');
  write('pnpm-lock.yaml', lockfile());
  rejected(run());
  git('add', 'pnpm-lock.yaml');
  write('pnpm-lock.yaml', `${lockfile()}note: Moonstone\n`);
  assert.equal(run().status, 0);
});

test('检查暂存内容，不被工作区的清理掩盖', (t) => {
  const { git, write, run } = fixture(t);
  write('note.txt', 'MOONSTONE');
  git('add', 'note.txt');
  write('note.txt', 'public content');
  rejected(run());
  assert.equal(git('show', ':note.txt').toString(), 'MOONSTONE');
});

test('仅工作区命中时通过，且不修改工作区或索引', (t) => {
  const { git, write, run } = fixture(t);
  const path = write('note.txt', 'public content');
  git('add', 'note.txt');
  write('note.txt', 'Moonstone');
  const index = git('ls-files', '--stage', '-z');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), 'Moonstone');
  assert.deepEqual(git('ls-files', '--stage', '-z'), index);
  assert.equal(git('show', ':note.txt').toString(), 'public content');
});

test('允许删除已有命中内容，不读取旧版本', (t) => {
  const { git, write, run } = fixture(t);
  write('note.txt', 'Moonstone');
  git('add', 'note.txt');
  git(
    '-c',
    'user.name=Policy Test',
    '-c',
    'user.email=policy@example.test',
    'commit',
    '-qm',
    'baseline',
  );
  git('rm', '--quiet', 'note.txt');
  assert.equal(run().status, 0);
});

test('路径匹配不区分大小写，二进制也检查路径', (t) => {
  const { git, write, run } = fixture(t);
  write('MoOnStOnE.bin', Buffer.from([0, 255]));
  git('add', 'MoOnStOnE.bin');
  rejected(run());
});

test('检查提交说明，拒绝命中且不泄露术语', (t) => {
  const { directory, run } = fixture(t);
  const message = join(directory, 'message');
  writeFileSync(message, 'chore: MoOnStOnE');
  rejected(run(['commit-msg', message]));
  writeFileSync(message, 'chore: public update');
  assert.equal(run(['commit-msg', message]).status, 0);
});

test('默认本地规则缺失时跳过暂存内容和提交说明检查', (t) => {
  const { directory, git, write, run } = fixture(t);
  write('note.txt', 'Moonstone');
  git('add', 'note.txt');
  assert.equal(run(['staged'], null).status, 0);
  const message = join(directory, 'message');
  writeFileSync(message, 'chore: Moonstone');
  assert.equal(run(['commit-msg', message], null).status, 0);
});

test('从子目录调用时使用仓库根目录的本地规则', (t) => {
  const { directory, repo, git, write, run } = fixture(t);
  write('commit-policy.json', JSON.stringify({ terms: ['Moonstone'] }));
  write('nested/note.txt', 'public content');
  git('add', 'nested/note.txt');
  const cwd = join(repo, 'nested');
  assert.equal(run(['staged'], null, cwd).status, 0);
  write('nested/note.txt', 'Moonstone');
  git('add', 'nested/note.txt');
  rejected(run(['staged'], null, cwd));
  const message = join(directory, 'message');
  writeFileSync(message, 'chore: Moonstone');
  rejected(run(['commit-msg', message], null, cwd));
  writeFileSync(message, 'chore: public update');
  assert.equal(run(['commit-msg', message], null, cwd).status, 0);
});

test('显式路径缺失、损坏和空规则配置均阻止检查', (t) => {
  const { directory, policyFile, write, run } = fixture(t);
  rejected(run(['staged'], join(directory, 'missing.json')));
  for (const value of [
    '{"terms":["Moonstone"]',
    '{"terms":[]}',
    '{"terms":[""]}',
    '{"terms":[" "]}',
  ]) {
    writeFileSync(policyFile, value);
    rejected(run());
    write('commit-policy.json', value);
    rejected(run(['staged'], null));
  }
});

test('二进制正文仅提示人工检查，带 BOM 的文本仍检查内容', (t) => {
  const { git, write, run } = fixture(t);
  write('image.bin', Buffer.from([0, 255, 1]));
  git('add', 'image.bin');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /人工 OCR、元数据与来源核验/);
  write('wide.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('Moonstone', 'utf16le')]));
  git('add', 'wide.txt');
  rejected(run());
});
