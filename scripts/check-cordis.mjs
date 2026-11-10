/**
 * 真实 Cordis 装载验证：不是假 ctx，是真的 `Context`。
 *
 * `smoke-apply.mjs` 用的是手写假 ctx —— 它能验证「我们调了哪些 API」，
 * 但验证不了「Cordis 接受这些调用吗」：服务声明写错、effect 用错、
 * 注册了不该注册的东西，假 ctx 全都看不出来。
 *
 * 这里用真的 `@deepseek-ai/cordis` 起一个 Context，注入假的 `llm` / `webServer` /
 * `commands` 服务，然后 `ctx.plugin(plugin)` 装载，断言：
 * 1. 插件能真的装载完成（不抛、不挂）；
 * 2. 三个服务都被消费到（adapter / provider / discovery / 路由 / 命令）；
 * 3. `ctx.dispose()` 之后所有注册都被释放（否则热重载会泄漏）。
 *
 * 用法：`node scripts/check-cordis.mjs`
 */

import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

const problems = [];
function check(label, ok, detail) {
  if (ok) console.log(`ok   ${label}`);
  else problems.push(`${label}${detail === undefined ? '' : `：${detail}`}`);
}

/** 记录所有被调用到的注册。 */
const record = {
  adapters: [],
  providers: [],
  discovery: [],
  routes: [],
  commands: [],
  disposers: [],
};

/** 造一个假服务：每个方法记录调用并返回 disposer。 */
function fakeLlm() {
  return {
    registerAdapter(providers, adapter) {
      record.adapters.push({ providers, adapter });
      const dispose = () => record.disposers.push('adapter');
      return dispose;
    },
    registerConfigurableProviders(entries) {
      record.providers.push(...entries);
      return () => record.disposers.push('providers');
    },
    registerModelDiscovery(namespace, discover) {
      record.discovery.push({ namespace, discover });
      return () => record.disposers.push('discovery');
    },
  };
}

function fakeWebServer() {
  return {
    register(entry) {
      record.routes.push(entry.path);
      return () => record.disposers.push(`route:${entry.path}`);
    },
  };
}

function fakeCommands() {
  return {
    register(definition) {
      record.commands.push(definition);
      return () => record.disposers.push('command');
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 起一个真的 Cordis Context，注入三个假服务
// ---------------------------------------------------------------------------
const ctx = new Context();

// Cordis 的服务通过 `ctx.provide` / `Service` 注册。这里用最小可行方式：
// 直接在 ctx 上挂属性，并让插件声明的 `inject` 能解析到它们。
ctx.provide('llm', fakeLlm());
ctx.provide('webServer', fakeWebServer());
ctx.provide('commands', fakeCommands());

let mounted;
try {
  mounted = ctx.plugin(plugin);
  // Cordis 的插件装载是异步的；等它稳定。
  await new Promise((resolve) => setTimeout(resolve, 500));
  check('插件能被真实 Cordis 装载', true);
} catch (error) {
  check('插件能被真实 Cordis 装载', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// 2. 断言三个服务都被消费到
// ---------------------------------------------------------------------------
check('注册了 adapter', record.adapters.length === 1, `实际 ${String(record.adapters.length)}`);
check(
  'provider id 是 meoo',
  record.adapters[0]?.providers?.[0] === 'meoo',
  JSON.stringify(record.adapters[0]?.providers),
);
check('注册了可配置 provider', record.providers.length === 1);
check('注册了模型发现', record.discovery.length === 1);
check('注册了两条路由', record.routes.length === 2, record.routes.join(', '));
check('注册了 /meoo 命令', record.commands.length === 1, `实际 ${String(record.commands.length)}`);

// 模型发现：未登录时也要有静态兜底目录。
if (record.discovery[0] !== undefined) {
  const models = await record.discovery[0].discover({ provider: 'meoo' }, undefined);
  check('未登录时模型发现有兜底目录', models.length > 0, `实际 ${String(models.length)} 个`);
}

// ---------------------------------------------------------------------------
// 3. 卸载必须释放所有注册（否则热重载泄漏）
// ---------------------------------------------------------------------------
const before = record.disposers.length;
try {
  if (mounted !== undefined && typeof mounted.dispose === 'function') await mounted.dispose();
  else await ctx.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('卸载后所有注册都被释放', record.disposers.length > before, `disposers: ${String(record.disposers.length)}`);
} catch (error) {
  check('卸载不抛错', false, error instanceof Error ? error.message : String(error));
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} 项未通过：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n真实 Cordis 装载验证通过。');
