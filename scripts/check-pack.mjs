/**
 * 打包检查：`files` 字段真的会把关键产物带进 tarball 吗？
 *
 * 为什么单独查：`prepublish-check` 查的是「本地 lib/ 存在」，但发布走的是
 * `package.json` 的 `files` 白名单 —— 白名单漏一个目录，本地全绿而装的人
 * 拿到一个没有界面（或没有宿主半边）的包。
 *
 * 用法：`node scripts/check-pack.mjs`
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [];

/**
 * 用 pnpm pack 拿到真实文件清单。
 *
 * 本机 PATH 上没有 npm（项目记忆里写明了，发布用运行时自带的 pnpm），
 * 且 pnpm 是 `.mjs` 脚本不是可执行文件 —— 必须用 `node <pnpm.mjs>` 调用。
 */
function packedFiles() {
  // pnpm 的位置：环境变量优先，其次运行时默认位置。
  const pnpmScript =
    process.env.DSH_PNPM ??
    'C:/Users/xingx/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
  const attempts = [
    { command: process.execPath, args: [pnpmScript, 'pack', '--pack-destination', '.pack-check'] },
    { command: 'pnpm', args: ['pack', '--pack-destination', '.pack-check'] },
    { command: 'npm', args: ['pack', '--dry-run', '--json'] },
  ];
  for (const attempt of attempts) {
    try {
      const output = execFileSync(attempt.command, attempt.args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const tarball = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.tgz'))
        .pop();
      if (tarball === undefined) continue;
      const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
      return listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.endsWith('/'))
        .map((line) => line.replace(/^package\//, ''));
    } catch {
      // 换下一种方式。
    }
  }
  return undefined;
}

const files = packedFiles();

if (files === undefined) {
  // 退化路径：只查白名单声明。
  const declared = Array.isArray(pkg.files) ? pkg.files : [];
  for (const required of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (declared.includes(required)) console.log(`ok   files 声明了 ${required}`);
    else problems.push(`files 白名单缺少 ${required}`);
  }
} else {
  console.log(`ok   tarball 里共 ${String(files.length)} 个文件`);
  const required = [
    'lib/index.js',
    'lib/client.js',
    'lib/index.d.ts',
    'cordis.patch.yml',
    'package.json',
    'README.md',
    'LICENSE',
  ];
  for (const file of required) {
    if (files.includes(file)) console.log(`ok   tarball 含 ${file}`);
    else problems.push(`tarball 缺少 ${file}`);
  }
  // 不该进包的东西：源码、测试、临时脚本。
  const forbidden = files.filter(
    (file) => file.startsWith('src/') || file.startsWith('test/') || file.startsWith('scripts/'),
  );
  if (forbidden.length === 0) console.log('ok   源码 / 测试 / 脚本都没进包');
  else problems.push(`这些不该进包：${forbidden.join(', ')}`);
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} 项未通过：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n打包检查通过。');
