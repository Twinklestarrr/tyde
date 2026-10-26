import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { postgresTool } from './lib/postgres-tools.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(root, '.local/postgres');
const command = process.argv[2];
if (!['start', 'stop', 'status'].includes(command)) throw new Error('请输入 start / stop / status');
function run(name, args, options = {}) {
  const result = spawnSync(postgresTool(name), args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`无法运行 ${name}，请安装 PostgreSQL 或设置 PG_BIN`);
  return result.status ?? 1;
}
if (command === 'start') {
  const initialized = existsSync(join(data, 'PG_VERSION'));
  if (process.argv.includes('--existing-only') && !initialized) {
    console.error('未找到已有本地 PostgreSQL 数据目录，请先显式完成初始化；本次未创建数据库。');
    process.exit(1);
  }
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (!initialized) {
    const pwfile = resolve(root, '.local/pg-admin-password');
    await writeFile(pwfile, randomBytes(32).toString('base64url'), { mode: 0o600 });
    if (
      run('initdb', [
        '-D',
        data,
        '--encoding=UTF8',
        '--locale=C',
        '--auth-local=trust',
        '--auth-host=scram-sha-256',
        `--pwfile=${pwfile}`,
      ])
    )
      process.exit(1);
  }
  if (run('pg_ctl', ['-D', data, 'status'], { stdio: 'ignore' }) === 0)
    console.info('本项目 PostgreSQL 已启动');
  else
    process.exitCode = run('pg_ctl', [
      '-D',
      data,
      '-l',
      join(data, 'server.log'),
      '-o',
      `-h 127.0.0.1 -p 5432 -k '${data.replaceAll("'", "'\\''")}'`,
      '-w',
      'start',
    ]);
} else
  process.exitCode = run('pg_ctl', [
    '-D',
    data,
    ...(command === 'stop' ? ['-m', 'fast', '-w'] : []),
    command,
  ]);
