/**
 * 文档断言检查（第二道）：README / docs 里承诺的**功能**必须在代码里存在。
 *
 * 为什么需要它：上一轮发现 README 写了 `/meoo` 系列命令，但代码里一条都没实现 ——
 * 用户照着 README 敲 `/meoo login` 会得到「未知命令」。这类「文档承诺 ≠ 实现」
 * 的缺陷，单测查不出来（单测只测已实现的东西），必须单独卡。
 *
 * 检查方式：从 README 里抽出「承诺形态」的字符串（命令、路由、文件路径、
 * 动作名），逐一在 `src/` 里找是否存在。
 *
 * 用法：`node scripts/check-doc-contract.mjs`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const notes = [];

/** 读一个文件，失败返回空串。 */
function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** 递归收集 src 下的所有 ts/js。 */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const sources = sourceFiles('src');
const allSource = sources.map((file) => read(file)).join('\n');
const readme = read('README.md');
const verify = read('docs/VERIFY.md');

function check(label, present) {
  if (present) notes.push(`ok   ${label}`);
  else problems.push(label);
}

// ---------------------------------------------------------------------------
// 1. README 里承诺的 `/meoo` 子命令，代码里必须有对应分支
// ---------------------------------------------------------------------------
const documentedSubcommands = new Set();
// 注意要吃掉参数：README 里写的是 `/meoo project <urlId>`、`/meoo key <ak>`，
// 只匹配 `[a-z]+` 会把带参数的两条漏掉（上一版就漏了）。
for (const match of readme.matchAll(/`\/meoo(?:\s+([a-z]+))?[^`]*`/g)) {
  documentedSubcommands.add(match[1] ?? 'status');
}
// VERIFY.md 里也可能提到
for (const match of verify.matchAll(/`\/meoo(?:\s+([a-z]+))?[^`]*`/g)) {
  documentedSubcommands.add(match[1] ?? 'status');
}
const commandsSource = read('src/host/commands.ts');
for (const subcommand of [...documentedSubcommands].sort()) {
  // 代码里以 `case 'xxx':` 的形式出现
  check(`README 承诺的 /meoo ${subcommand} 在 commands.ts 里有分支`, commandsSource.includes(`case '${subcommand}'`));
}
notes.push(`     （共 ${String(documentedSubcommands.size)} 个子命令）`);

// ---------------------------------------------------------------------------
// 2. README 里承诺的宿主路由，代码里必须注册
// ---------------------------------------------------------------------------
for (const match of readme.matchAll(/`(\/plugins\/[a-z0-9-]+\/[a-z]+)`/g)) {
  const route = match[1];
  check(`README 承诺的路由 ${route} 在代码里有`, allSource.includes(route));
}

// ---------------------------------------------------------------------------
// 3. README 里承诺的动作名，必须在白名单里
// ---------------------------------------------------------------------------
const routesSource = read('src/host/routes.ts');
for (const action of ['refresh', 'login', 'logout', 'settings', 'project', 'ak', 'test-model']) {
  if (readme.includes(`\`${action}\``) || routesSource.includes(`'${action}'`)) {
    check(`动作 ${action} 在路由白名单里`, routesSource.includes(`'${action}'`));
  }
}

// ---------------------------------------------------------------------------
// 4. README 里承诺的文件路径，必须在代码里出现过
// ---------------------------------------------------------------------------
for (const match of readme.matchAll(/`(\$DSH_HOME\/[A-Za-z0-9._-]+)`/g)) {
  const filename = match[1].split('/').pop();
  check(`README 承诺的文件 ${filename} 在代码里出现`, allSource.includes(filename));
}

// ---------------------------------------------------------------------------
// 5. README 承诺的配置项，必须在 config.ts 的 schema 里
// ---------------------------------------------------------------------------
const configSource = read('src/config.ts');
const yamlBlock = /```yaml\n([\s\S]*?)```/.exec(readme);
if (yamlBlock !== null) {
  for (const match of yamlBlock[1].matchAll(/^\s{4}([a-zA-Z][\w]*):/gm)) {
    const key = match[1];
    check(`README 的配置项 ${key} 在 config.ts 里`, configSource.includes(`${key}: z`));
  }
}

// ---------------------------------------------------------------------------
// 6. README 承诺的五个分栏，浏览器半侧必须都有 tab
// ---------------------------------------------------------------------------
const clientSource = read('src/client/bundle.js');
for (const tab of ['tabAccount', 'tabModels', 'tabPoints', 'tabSettings', 'tabDiag']) {
  check(`浏览器半侧有 ${tab} 标签`, clientSource.includes(`${tab}:`));
}
// 五个 tab 必须真的在 tabs 数组里（否则定义了却没渲染）。
for (const id of ['account', 'models', 'points', 'settings', 'diag']) {
  check(`tabs 数组包含 ${id}`, new RegExp(`id: '${id}'`).test(clientSource));
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
for (const line of notes) console.log(line);
if (problems.length > 0) {
  console.error(`\n${String(problems.length)} 项文档承诺没有实现：`);
  for (const line of problems) console.error(`  - ${line}`);
  console.error('\n要么实现它，要么把 README 里那条删掉。');
  process.exit(1);
}
console.log('\n文档承诺与实现一致。');
