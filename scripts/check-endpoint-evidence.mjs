/**
 * 端点取证一致性检查（离线部分）。
 *
 * `probe-endpoints.mjs` 是**联网**的现场取证；这个脚本是它的**离线断言**：
 * 文档里凡是写「上游没有 X」的地方，必须指向一份取证记录，而那份记录里
 * 必须同时有「已知端点 401（存在）」与「目标路径 404（不存在）」两组证据。
 *
 * 为什么分开：gate 要在没有网络时也能跑（CI、离线环境）。联网取证按需手动跑，
 * 跑完把结论写进 `docs/PROTOCOL.md`；这里只校验「结论有没有证据支撑」。
 *
 * 用法：`node scripts/check-endpoint-evidence.mjs`
 */

import { readFileSync } from 'node:fs';

const problems = [];
const notes = [];

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const protocol = read('docs/PROTOCOL.md');
const agents = read('AGENTS.md');
const readme = read('README.md');

/**
 * 文档里出现「上游没有 / 没有 X 接口」这类断言时，必须能看到对照组证据。
 *
 * 只查**强断言**（明确说「没有」某接口），不查「未取证 / 待验证」——
 * 后者是诚实的，不该被拦。
 */
const NEGATIVE_CLAIMS = [
  /没有签到接口/,
  /不提供签到/,
  /没有生图接口/,
  /不提供生图/,
];

/** 证据标记：文档里必须出现这些词之一。 */
const EVIDENCE_MARKERS = [
  'probe-endpoints',
  '对照组',
  '404',
];

for (const [file, text] of [
  ['docs/PROTOCOL.md', protocol],
  ['AGENTS.md', agents],
  ['README.md', readme],
]) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!NEGATIVE_CLAIMS.some((pattern) => pattern.test(line))) return;
    // 证据可以写在同行或上下两行。
    const window = [lines[index - 2], lines[index - 1], line, lines[index + 1], lines[index + 2]]
      .filter((entry) => typeof entry === 'string')
      .join('\n');
    if (EVIDENCE_MARKERS.some((marker) => window.includes(marker))) {
      notes.push(`ok   ${file}:${String(index + 1)} 的否定断言有取证支撑`);
    } else {
      problems.push(`${file}:${String(index + 1)} 写了「没有」但没指向取证：${line.trim().slice(0, 80)}`);
    }
  });
}

// 取证记录本身必须包含「已知端点存在」的对照 —— 只有 404 不能证明什么。
if (protocol.includes('404')) {
  const hasControlGroup = /401/.test(protocol);
  if (hasControlGroup) notes.push('ok   PROTOCOL.md 的取证同时记录了 401（对照组）与 404');
  else problems.push('PROTOCOL.md 只记了 404，缺少「已知端点 401」的对照组');
}

// 取证脚本必须存在且可跑。
const probeScript = read('scripts/probe-endpoints.mjs');
if (probeScript.includes('expect: \'control\'') || probeScript.includes('definitely-not-a-real-route')) {
  notes.push('ok   probe-endpoints.mjs 有「必然不存在」的对照组');
} else {
  problems.push('probe-endpoints.mjs 缺少「必然不存在」的对照组路径');
}

for (const line of notes) console.log(line);
if (problems.length > 0) {
  console.error(`\n${String(problems.length)} 项未通过：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n否定断言必须指向一份带对照组的取证记录。');
  process.exit(1);
}
console.log('\n端点取证一致性通过。');
