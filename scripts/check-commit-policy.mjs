import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function decode(buffer) {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
    }
    if (buffer.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function policyText(path, text) {
  if (path !== 'pnpm-lock.yaml' || !/^lockfileVersion: '9\.0'\r?\n/.test(text)) return text;
  const packageKey = /^ {2}(?:'[^']+'|"[^"]+"|[^'"\s][^:]*):\s*$/;
  let inPackages = false;
  let inPackage = false;
  // pnpm emits plain deprecation messages containing literal quotes. Recognize only
  // this single-line package field for the quoting guard; its full value is still scanned.
  const quoteText = text
    .split('\n')
    .map((line) => {
      if (/^\S/.test(line)) {
        inPackages = /^packages:\s*$/.test(line);
        inPackage = false;
      }
      if (inPackages && /^ {2}\S/.test(line)) inPackage = packageKey.test(line);
      if (
        inPackages &&
        inPackage &&
        /^ {4}deprecated: [A-Za-z0-9](?:(?!:[ \t])[^\r\n])*\r?$/.test(line)
      ) {
        return '    deprecated: plain scalar';
      }
      return line;
    })
    .join('\n');
  // Only pnpm's single-line scalar format is supported; unfamiliar quoting stays fully checked.
  const scalars = quoteText.replace(/'[^'\r\n]*'|"(?:[^"\\\r\n]|\\.)*"|#[^\r\n]*/g, '');
  if (/['"]/.test(scalars)) return text;
  let packages = false;
  let packageEntry = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\S/.test(line)) {
        packages = /^packages:\s*$/.test(line);
        packageEntry = false;
      }
      if (!packages) return line;
      if (packageKey.test(line)) {
        packageEntry = true;
        return line;
      }
      const resolution = packageEntry
        ? /^ {4}resolution: \{integrity: (sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})\}([ \t]*(?:#.*)?)\r?$/.exec(
            line,
          )
        : null;
      packageEntry = false;
      if (!resolution) return line;
      const [, algorithm, value] = resolution;
      const bytes = Buffer.from(value, 'base64');
      const length = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }[algorithm];
      if (bytes.length !== length || bytes.toString('base64') !== value) return line;
      // Digest bytes are opaque machine data; keep the algorithm, surrounding fields and comments.
      return line.replace(`${algorithm}-${value}`, `${algorithm}-`);
    })
    .join('\n');
}

try {
  const args = process.argv.slice(2);
  const [mode, messageFile] = args;
  if (!((mode === 'staged' && args.length === 1) || (mode === 'commit-msg' && args.length === 2))) {
    fail('提交策略命令无效，请使用 staged 或 commit-msg 加提交说明文件。');
  }

  let root;
  const git = (...parameters) =>
    execFileSync('git', parameters, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  root = realpathSync(git('rev-parse', '--show-toplevel').toString().trimEnd());
  const configuredPolicyFile = process.env.TYDE_COMMIT_POLICY_FILE;
  let policySource;
  try {
    policySource = readFileSync(configuredPolicyFile ?? join(root, 'commit-policy.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && configuredPolicyFile === undefined) process.exit(0);
    throw error;
  }
  const policy = JSON.parse(policySource);
  if (
    !policy ||
    typeof policy !== 'object' ||
    Object.keys(policy).length !== 1 ||
    !Array.isArray(policy.terms) ||
    policy.terms.length === 0 ||
    policy.terms.some((term) => typeof term !== 'string' || !term.trim())
  ) {
    fail('提交策略配置无效，需要非空字符串规则列表，已阻止提交。');
  }
  const normalize = (text) => text.normalize('NFKC').toLowerCase();
  const terms = policy.terms.map((term) => normalize(term.trim()));
  const matches = (text) => terms.some((term) => normalize(text).includes(term));

  if (mode === 'commit-msg') {
    const message = decode(readFileSync(messageFile));
    if (message === null) fail('提交说明无法作为文本读取，已阻止提交。');
    if (matches(message)) fail('提交说明包含受限内容，已阻止提交。');
  } else {
    let binary = false;
    const entries = git('ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      const [mode, oid, stage] = entry.slice(0, tab).split(' ');
      if (stage !== '0' || !['100644', '100755', '120000'].includes(mode)) {
        fail('暂存区存在未合并文件或不支持的条目，已阻止提交。');
      }
      const path = entry.slice(tab + 1);
      if (matches(path)) fail('暂存路径包含受限内容，已阻止提交。');
      const text = decode(git('cat-file', 'blob', oid));
      if (text === null) binary = true;
      else if (matches(mode === '120000' ? text : policyText(path, text))) {
        fail('暂存文本包含受限内容，已阻止提交。');
      }
    }
    if (binary) {
      console.warn(
        '存在二进制暂存文件：仅自动检查其路径，正文仍需人工 OCR、元数据与来源核验，未完成自动全文检查。',
      );
    }
  }
} catch {
  fail('无法完成提交策略检查，请检查仓库状态及本机规则配置，已阻止提交。');
}
