/**
 * 测试汇总：跑全部测试并把结论写进 `test-report.txt`。
 *
 * 为什么需要它：`node --test "test/*.test.ts"` 的输出在 Windows 终端里被截断/串行，
 * 而失败信息恰好在中段。这里用 `spawnSync` 拿完整 stdout，再只抽取结论行，
 * 于是「通过/失败」不依赖终端窗口大小。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('test')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('test', name))
  .sort();

const report = [];
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', file], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const pass = /^ℹ pass (\d+)/m.exec(output)?.[1] ?? '?';
  const fail = /^ℹ fail (\d+)/m.exec(output)?.[1] ?? '?';
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  report.push(`${file}\tpass=${pass}\tfail=${fail}\tstatus=${String(result.status)}${timedOut ? '\tTIMEOUT' : ''}`);
  if (timedOut || result.status !== 0) {
    failed += 1;
    const failing = output
      .split('\n')
      .filter((line) => line.startsWith('✖') || line.includes('AssertionError') || line.includes('Error:'))
      .slice(0, 12);
    report.push(...failing.map((line) => `  ${line.trim()}`));
  }
}

writeFileSync('test-report.txt', `${report.join('\n')}\n`, 'utf8');
console.log(report.join('\n'));
if (failed > 0) process.exitCode = 1;
