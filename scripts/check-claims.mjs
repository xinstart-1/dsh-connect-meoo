/**
 * 文档断言检查：不许写「没有上游证据的做不到」。
 *
 * 这条规则来自项目记忆里踩过的两次误判（「本机没装客户端只能手粘 cookie」、
 * 「纯 HTTP 无法翻转任务状态」），两次都是实现方疏忽被写成了上游限制。
 *
 * 检查方式：README / docs 里出现「做不到 / 不支持 / 上游限制 / 无法实现」这类
 * 断言时，同一行（或紧邻的上下两行）必须带上可核对的东西 —— HTTP 状态码、
 * 业务码、或一个指向 `docs/PROTOCOL.md` 的取证段落。
 *
 * 用法：`node scripts/check-claims.mjs`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 会构成「断言」的措辞。 */
const CLAIM_PATTERNS = [
  /做不到/,
  /不支持/,
  /无法实现/,
  /上游限制/,
  /只能手动/,
  /没有办法/,
  /做不到的/,
];

/** 允许的支撑证据形态。 */
const EVIDENCE_PATTERNS = [
  /HTTP\s*\d{3}/i,
  /状态码/,
  /\b(?:40\d|50\d)\b/,
  /errCode/i,
  /业务码/,
  /PROTOCOL\.md/,
  /实测/,
  /取证/,
];

/** 递归收集 markdown 文件。 */
function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const problems = [];
const files = ['README.md', ...markdownFiles('docs')].filter((file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
});

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!CLAIM_PATTERNS.some((pattern) => pattern.test(line))) return;
    // 证据可以写在同行，也可以写在紧邻的上下两行（表格与列表常常换行写）。
    const window = [lines[index - 2], lines[index - 1], line, lines[index + 1], lines[index + 2]]
      .filter((entry) => typeof entry === 'string')
      .join('\n');
    if (EVIDENCE_PATTERNS.some((pattern) => pattern.test(window))) return;
    problems.push(`${file}:${String(index + 1)} ${line.trim().slice(0, 100)}`);
  });
}

if (problems.length > 0) {
  console.error('发现没有上游证据的「做不到」断言：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n要么补上 HTTP 状态码 / 业务码 / PROTOCOL.md 的取证段落，要么改成「待验证」。');
  process.exitCode = 1;
} else {
  console.log(`ok   ${String(files.length)} 份文档里没有无证据的限制断言`);
}
