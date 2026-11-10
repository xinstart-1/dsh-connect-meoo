/**
 * 发布前检查：只查「发出去会不会立刻坏」的项。
 *
 * 为什么不跑单测：单测跑的是 `src/`（Node 直接 strip types），不是 `lib/`。
 * 把它挂在 publish 前会给人「产物已验证」的错觉；这里钉的是**产物形状**。
 */

import { readFileSync, statSync } from 'node:fs';

const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) notes.push(`ok   ${message}`);
  else failures.push(message);
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

// 1. 版本号：三位，且与代码里的 VERSION 一致。
const pkg = JSON.parse(read('package.json') ?? '{}');
check(/^\d+\.\d+\.\d+$/.test(pkg.version ?? ''), `package.json version 是三位 semver：${pkg.version}`);
const constants = read('src/constants.ts') ?? '';
const versionInCode = /export const VERSION = '([^']+)'/.exec(constants)?.[1];
check(
  versionInCode === pkg.version,
  `src/constants.ts 的 VERSION（${versionInCode ?? '未找到'}）等于 package.json（${pkg.version}）`,
);

// 2. 产物存在且非空。
for (const file of ['lib/index.js', 'lib/client.js']) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  check(size > 1024, `${file} 存在且非空（${String(size)} bytes）`);
}

// 3. 浏览器半侧是经典脚本。
const client = read('lib/client.js') ?? '';
check(client.includes('__ModuleLoader__.load'), 'lib/client.js 调用了 __ModuleLoader__.load');
check(client.includes("var BUNDLE_NAME = 'dsh-connect-meoo'"), 'BUNDLE_NAME 与包名一致');
check(!/^\s*(?:import|export)\s/m.test(client), 'lib/client.js 里没有 import/export 语句（必须是经典脚本）');

// 4. 宿主半侧带两条路由。
const index = read('lib/index.js') ?? '';
for (const path of ['/plugins/dsh-connect-meoo/status', '/plugins/dsh-connect-meoo/action']) {
  check(index.includes(path), `lib/index.js 里有路由 ${path}`);
}

// 5. 包清单与 patch。
const files = Array.isArray(pkg.files) ? pkg.files : [];
check(files.includes('lib'), 'package.json 的 files 含 lib');
check(files.includes('cordis.patch.yml'), 'package.json 的 files 含 cordis.patch.yml');
check(pkg.exports?.['./client'] !== undefined, "package.json 声明了 exports['./client']");

const patch = read('cordis.patch.yml') ?? '';
check(
  patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: ${pkg.name}`),
  'cordis.patch.yml 的 row name 等于包名',
);

// 6. 许可与说明。
check((read('README.md') ?? '').length > 200, 'README.md 存在且有内容');
check(read('LICENSE') !== undefined, 'LICENSE 存在');

// 报告
for (const line of notes) console.log(line);
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} 项未通过：`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('\n全部通过，可以发布。');
