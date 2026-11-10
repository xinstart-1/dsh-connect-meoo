/**
 * 客户端 bundle 的静态自检。
 *
 * 浏览器半边是**手写的经典脚本**、从不进打包器（进了会引入第二份 React），
 * 所以没有类型检查兜底。这个脚本补上最要紧的四类检查：
 *
 * 1. **能解析**：用 `new Function` 让引擎真的解析一遍（语法错立刻暴露）。
 * 2. **没有模块语法**：`import` / `export` 会让它不再是经典脚本，加载即失败。
 * 3. **引用的 i18n 键都存在**：`t('xxx')` 里写了不存在的键，界面会显示原始键名。
 * 4. **状态文档字段都读得到**：页面读的 `status.xxx` 必须在宿主的状态类型里。
 *
 * 用法：`node scripts/check-client.mjs`
 */

import { readFileSync } from 'node:fs';

const path = 'src/client/bundle.js';
const source = readFileSync(path, 'utf8');
const problems = [];

// 1. 能解析。
try {
  // 顶层有 `window.__ModuleLoader__.load(...)`，需要 `window` 存在才不抛运行时错误；
  // 这里只要语法解析，所以不让 factory 真的执行。
  new Function(source);
  console.log('ok   语法可解析');
} catch (error) {
  problems.push(`语法错误：${error instanceof Error ? error.message : String(error)}`);
}

// 2. 没有模块语法。只在行首匹配，避免字符串与注释里的内容误报。
const moduleSyntax = [];
source.split(/\r?\n/).forEach((line, index) => {
  const trimmed = line.trim();
  if (/^(import|export)\s/.test(trimmed) || /^(import|export)\{/.test(trimmed)) {
    moduleSyntax.push(`${String(index + 1)}: ${trimmed.slice(0, 60)}`);
  }
});
if (moduleSyntax.length === 0) console.log('ok   没有 import/export');
else problems.push(`发现模块语法（必须改掉）：\n    ${moduleSyntax.join('\n    ')}`);

// 3. i18n 键齐全。字典是 `var zh = { ... }` 形式，用正则抓键名。
function keysOf(dictName) {
  const start = source.indexOf(`var ${dictName} = {`);
  if (start === -1) return undefined;
  const end = source.indexOf('\n  };', start);
  if (end === -1) return undefined;
  const body = source.slice(start, end);
  const keys = new Set();
  for (const match of body.matchAll(/^\s{4}([A-Za-z_][\w]*):/gm)) keys.add(match[1]);
  return keys;
}

const zh = keysOf('zh');
const en = keysOf('en');
if (zh === undefined || en === undefined) {
  problems.push('找不到 zh / en 字典');
} else {
  console.log(`ok   zh 键 ${String(zh.size)} 个，en 键 ${String(en.size)} 个`);

  // 两张字典必须同键，否则切语言会露原始键名。
  const onlyZh = [...zh].filter((key) => !en.has(key));
  const onlyEn = [...en].filter((key) => !zh.has(key));
  if (onlyZh.length === 0 && onlyEn.length === 0) console.log('ok   zh 与 en 键一致');
  else {
    if (onlyZh.length > 0) problems.push(`只有 zh 有：${onlyZh.join(', ')}`);
    if (onlyEn.length > 0) problems.push(`只有 en 有：${onlyEn.join(', ')}`);
  }

  // 所有 t('x') 引用都要在字典里。
  const used = new Set();
  for (const match of source.matchAll(/\bt\('([A-Za-z_][\w]*)'/g)) used.add(match[1]);
  const missing = [...used].filter((key) => !zh.has(key) && !en.has(key));
  if (missing.length === 0) console.log(`ok   用到的 ${String(used.size)} 个 i18n 键都存在`);
  else problems.push(`t() 引用了不存在的键：${missing.join(', ')}`);
}

// 4. 关键契约：bundle id 必须是包名，且调用了 ModuleLoader。
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!source.includes('__ModuleLoader__.load')) problems.push('没有调用 __ModuleLoader__.load');
else console.log('ok   调用了 __ModuleLoader__.load');
if (!source.includes(`'${pkg.name}'`)) problems.push(`没有出现包名 '${pkg.name}'`);
else console.log(`ok   出现包名 ${pkg.name}`);

// 5. 页面读的状态字段必须真的在宿主的状态文档里（拼错一个字段名 = 界面上一个空值）。
const statusSource = readFileSync('src/host/status.ts', 'utf8');
const knownFields = new Set();
for (const match of statusSource.matchAll(/^\s{2}([a-zA-Z_]\w*)\??:/gm)) knownFields.add(match[1]);
// 嵌套段落里的字段（points / settings / login 的成员）也收进来。
for (const match of statusSource.matchAll(/^\s{4}([a-zA-Z_]\w*)\??:/gm)) knownFields.add(match[1]);

const readFields = new Set();
for (const match of source.matchAll(/\b(?:status|doc|snapshot)\??\.([a-zA-Z_]\w*)/g)) readFields.add(match[1]);
const unknownFields = [...readFields].filter((field) => !knownFields.has(field));
if (unknownFields.length === 0) {
  console.log(`ok   页面读的 ${String(readFields.size)} 个状态字段都在 status.ts 里`);
} else {
  problems.push(`页面读了状态文档里没有的字段：${unknownFields.join(', ')}`);
}

if (problems.length > 0) {
  console.error('\n发现问题：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\n客户端 bundle 自检全部通过。');
}
