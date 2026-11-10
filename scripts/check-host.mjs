/**
 * 宿主解析验证：DSH 真的能 `import()` 这个包并读到它的 `dsh` 声明吗？
 *
 * `smoke-apply.mjs` 用假 ctx 测了装配逻辑，但**没有验证包本身**：
 * - `main` 指向的文件存在吗、能被 Node 以 ESM 加载吗？
 * - `dsh.bundle.patch` / `dsh.client` 声明齐全吗？
 * - `exports['./client']` 指向的文件存在吗？
 * - `cordis.patch.yml` 的 row name 等于包名吗（不等则客户端模块解析不到）？
 *
 * 这些都是「装上去才发现」的故障，必须在这里卡住。
 *
 * 用法：`node scripts/check-host.mjs`
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const problems = [];
function check(label, ok, detail) {
  if (ok) console.log(`ok   ${label}`);
  else problems.push(`${label}${detail === undefined ? '' : `：${detail}`}`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name = pkg.name;

// 1. 入口能被 Node 以 ESM 真加载（不是只看文件存在）。
const entry = resolve(pkg.main ?? 'lib/index.js');
check(`main 指向的文件存在（${pkg.main}）`, statSync(entry).isFile());
let mod;
try {
  mod = await import(`file://${entry.replace(/\\/g, '/')}`);
  check('main 能被 import() 加载', true);
} catch (error) {
  check('main 能被 import() 加载', false, error instanceof Error ? error.message : String(error));
}

if (mod !== undefined) {
  // 2. Cordis 插件形状。
  check('导出 name 等于包名', mod.name === name, `实际 ${String(mod.name)}`);
  check('导出 apply 函数', typeof mod.apply === 'function');
  check(
    'inject 含 llm',
    Array.isArray(mod.inject) && mod.inject.includes('llm'),
    `实际 ${JSON.stringify(mod.inject)}`,
  );
}

// 3. 浏览器半边的入口存在且是经典脚本。
const clientPath = pkg.exports?.['./client'];
check("声明 exports['./client']", clientPath !== undefined);
if (clientPath !== undefined) {
  const clientFile = resolve(clientPath);
  let exists = false;
  try {
    exists = statSync(clientFile).isFile();
  } catch {
    exists = false;
  }
  check(`client 文件存在（${clientPath}）`, exists);
  if (exists) {
    const source = readFileSync(clientFile, 'utf8');
    check('client 是经典脚本（调用了 __ModuleLoader__.load）', source.includes('__ModuleLoader__.load'));
    check('client 里没有 import/export', !/^\s*(?:import|export)\s/m.test(source));
  }
}

// 4. `dsh` 声明：bundle patch 与 client 平台。
check('声明 dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string');
check('声明 dsh.client.platform', pkg.dsh?.client?.platform === 'web');
check('dsh.client.inject 非空', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0);

// 5. cordis.patch.yml 的 row name 必须等于包名。
//    不等的话，客户端模块的 node 半边会 require.resolve 不到这个包。
if (typeof pkg.dsh?.bundle?.patch === 'string') {
  const patchFile = resolve(pkg.dsh.bundle.patch);
  let patchText = '';
  try {
    patchText = readFileSync(patchFile, 'utf8');
  } catch {
    patchText = '';
  }
  check('cordis.patch.yml 存在且非空', patchText.length > 0);
  const rowName = /name:\s*['"]?([^'"\s]+)['"]?/.exec(patchText)?.[1];
  check(
    'cordis.patch.yml 的 row name 等于包名',
    rowName === name,
    `row name = ${String(rowName)}，包名 = ${name}`,
  );
}

// 6. peerDependencies 覆盖了实际 import 的 @deepseek-ai 包。
const declared = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
]);
for (const required of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/schemastery',
  '@earendil-works/pi-ai',
]) {
  check(`依赖声明覆盖 ${required}`, declared.has(required));
}

// 7. engines 声明了 dsh 版本范围（没有它会装进不兼容的宿主）。
check('声明 engines.dsh', typeof pkg.engines?.dsh === 'string');

// 8. 装进 profile 之后还能解析到依赖吗？
//
//    这是被真实缺陷逼出来的：`dsh plugin add` 有两种落地形态 ——
//    符号链接（源码目录）与复制目录。复制形态下，profile 的 node_modules 里
//    没有 `@deepseek-ai/*`，插件的 `import '@deepseek-ai/dsh-llm-pi-ai'` 会
//    MODULE_NOT_FOUND，**整个插件挂载失败**（侧栏当然也不出现）。
//
//    检查方式：如果本仓库被装进了某个 profile，就模拟一次「从 profile 路径加载」。
//    没有装进任何 profile 时跳过（本地开发阶段）。
const PROFILE_ROOTS = [
  process.env.DSH_PROFILE_DIR,
  'C:/Users/xingx/.dsh/profiles/desktop',
  'C:/Users/xingx/.dsh/profiles/web',
].filter((entry) => typeof entry === 'string' && entry !== '');

let checkedProfile = false;
for (const root of PROFILE_ROOTS) {
  const installed = `${root}/node_modules/${name}/lib/index.js`;
  let exists = false;
  try {
    exists = statSync(installed).isFile();
  } catch {
    exists = false;
  }
  if (!exists) continue;
  checkedProfile = true;
  try {
    const url = `file://${installed.replace(/\\/g, '/')}`;
    const loaded = await import(url);
    check(`从 profile 路径能加载（${root}）`, loaded.name === name);
  } catch (error) {
    check(
      `从 profile 路径能加载（${root}）`,
      false,
      `${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n` +
        '    修法：把 profile 里的复制目录换成 junction（New-Item -ItemType Junction），' +
        '让它解析到本仓库的 node_modules。',
    );
  }
  break;
}
if (!checkedProfile) {
  console.log('--   没有装进任何 profile，跳过「从 profile 加载」检查');
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} 项未通过：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n宿主解析验证通过：DSH 能加载这个包。');
