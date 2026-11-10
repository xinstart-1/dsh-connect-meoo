/**
 * 一条命令跑完全部校验。
 *
 * 存在的理由：在这个 Windows 终端里手敲多条 `|` / `&` 组合容易被 PowerShell
 * 与 cmd 的引号规则打架，写进脚本就只剩一次调用。
 *
 * 用法：`node scripts/gate.mjs`（任何一项失败即以非 0 退出）
 */

import { spawnSync } from 'node:child_process';

const steps = [
  ['typecheck', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
  ['build', [process.execPath, 'node_modules/tsdown/dist/run.mjs']],
  ['copy-client', [process.execPath, 'scripts/copy-client.mjs']],
  ['check-client', [process.execPath, 'scripts/check-client.mjs']],
  // 文档里不许出现没有上游错误码支撑的「做不到」。
  ['check-claims', [process.execPath, 'scripts/check-claims.mjs']],
  // 文档里承诺的功能必须在代码里真的存在（上一版漏了 /meoo 命令）。
  ['check-doc-contract', [process.execPath, 'scripts/check-doc-contract.mjs']],
  ['prepublish-check', [process.execPath, 'scripts/prepublish-check.mjs']],
  // files 白名单漏一个目录 = 本地全绿、装的人拿到一个没界面的包。
  ['check-pack', [process.execPath, 'scripts/check-pack.mjs']],
  // 宿主能不能真的 import 这个包、读到它的 dsh 声明（装上去才发现就晚了）。
  ['check-host', [process.execPath, 'scripts/check-host.mjs']],
  // 用真的 Cordis Context 装载一次：假 ctx 验不出「Cordis 接不接受这套装配」。
  ['check-cordis', [process.execPath, 'scripts/check-cordis.mjs']],
  // 「上游没有某接口」这类断言必须有对照组取证，不能只读第三方实现就下结论。
  ['check-endpoint-evidence', [process.execPath, 'scripts/check-endpoint-evidence.mjs']],
  ['tests', [process.execPath, 'scripts/test-report.mjs']],
  // 浏览器半侧真的能被离屏渲染成 HTML（组件跑通、CSS 注入、没有 undefined）。
  // 单测覆盖了组件函数，这一步覆盖「整页拼起来之后还长这样」。
  ['preview-ui', [process.execPath, 'scripts/preview-ui.mjs', '--check']],
  // 单测覆盖各层，但没有一处证明 apply() 真的把它们接起来了。
  ['smoke-apply', [process.execPath, 'scripts/smoke-apply.mjs']],
];

const failures = [];
for (const [name, command] of steps) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures.push(name);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output !== '') console.log(output.split(/\r?\n/).slice(-15).join('\n'));
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`全部通过：${steps.map(([name]) => name).join(' / ')}`);
} else {
  console.error(`失败项：${failures.join(', ')}`);
  process.exitCode = 1;
}
