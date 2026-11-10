/**
 * 装载冒烟测试：用假的 Cordis ctx 真跑一次 `apply()`。
 *
 * 单测覆盖了各层，但**没有一处证明 `apply()` 真的把这些层接起来了** ——
 * 装配写错一个名字，单测全绿而插件装上什么都不做。这里把真实的 `lib/index.js`
 * 加载进来，用假的 ctx 跑一遍，断言注册调用与路由都发生了。
 *
 * 用法：`node scripts/smoke-apply.mjs`
 */

import assert from 'node:assert/strict';

process.env.DSH_HOME = process.env.DSH_HOME || 'C:/meoo/.smoke-home';

const mod = await import('../lib/index.js');

assert.equal(mod.name, 'dsh-connect-meoo', '导出 name 必须是包名');
assert.ok(Array.isArray(mod.inject) && mod.inject.includes('llm'), 'inject 必须含 llm');
assert.equal(typeof mod.apply, 'function', '必须导出 apply');

/** 记录所有注册调用。 */
const calls = {
  adapters: [],
  providers: [],
  discovery: [],
  routes: [],
  commands: [],
  effects: [],
  logs: [],
};

/** 假的 ctx。 */
const ctx = {
  logger: {
    info: (message) => calls.logs.push(['info', message]),
    warn: (message) => calls.logs.push(['warn', message]),
    debug: () => undefined,
  },
  /** 软取服务：这里让 `commands` 存在，验证命令真的被注册。 */
  get(name) {
    if (name !== 'commands') return undefined;
    return {
      register(definition) {
        calls.commands.push(definition);
        return () => calls.effects.push('releaseCommand');
      },
    };
  },
  llm: {
    registerAdapter(providers, adapter) {
      calls.adapters.push({ providers, adapter });
      return () => calls.effects.push('releaseAdapter');
    },
    registerConfigurableProviders(entries) {
      calls.providers.push(...entries);
      return () => calls.effects.push('releaseDirectory');
    },
    registerModelDiscovery(namespace, discover) {
      calls.discovery.push({ namespace, discover });
      return () => calls.effects.push('releaseDiscovery');
    },
  },
  inject(services, callback) {
    assert.deepEqual([...services], ['webServer']);
    callback({
      effect(fn) {
        calls.effects.push(fn);
        fn();
      },
      webServer: {
        register(entry) {
          calls.routes.push(entry.path);
          return () => calls.effects.push(`unregister:${entry.path}`);
        },
      },
    });
  },
  effect(fn) {
    calls.effects.push(fn);
    // 执行并收集 disposer（不立刻调用：卸载是另一个场景）。
    fn();
  },
  on() {
    return () => undefined;
  },
};

await mod.apply(ctx, {});

// 1. provider 注册。
assert.equal(calls.adapters.length, 1, '必须注册一个 adapter');
assert.equal(calls.adapters[0].providers.length, 1);
assert.equal(calls.adapters[0].providers[0], 'meoo', 'provider id 必须是 meoo');

// 2. 可配置 provider（设置 → 模型 里的那一行）。
assert.equal(calls.providers.length, 1);
assert.equal(calls.providers[0].provider, 'meoo');
assert.equal(calls.providers[0].settingsNs, 'meoo');
assert.equal(calls.providers[0].displayName, 'Meoo 秒悟');

// 3. 模型发现：未登录时也要返回静态兜底目录（空列表会让选择器整组消失）。
assert.equal(calls.discovery.length, 1);
assert.equal(calls.discovery[0].namespace, 'meoo');
const discovered = await calls.discovery[0].discover({ provider: 'meoo' }, undefined);
assert.ok(discovered.length > 0, '未登录时模型发现必须返回静态兜底目录');
assert.ok(discovered.every((model) => model.provider === 'meoo'));
// 别的 provider 问到它，必须回空。
assert.deepEqual(await calls.discovery[0].discover({ provider: 'workbuddy' }, undefined), []);

// 4. 两条宿主路由。
assert.deepEqual(calls.routes.sort(), [
  '/plugins/dsh-connect-meoo/action',
  '/plugins/dsh-connect-meoo/status',
]);

// 5. `/meoo` 命令。
assert.equal(calls.commands.length, 1, '必须注册 /meoo 命令');
assert.equal(calls.commands[0].name, 'meoo');
const statusResult = await calls.commands[0].handler({ rawInput: 'status' });
assert.equal(statusResult.kind, 'success', '/meoo status 必须成功（未登录也要能报状态）');
assert.match(statusResult.text, /Meoo 秒悟/, '状态文本必须带插件名');

// 6. 生命周期：必须有清理 effect。
assert.ok(calls.effects.length > 0, '必须注册清理 effect');

// 7. 日志里报告了启动。
assert.ok(
  calls.logs.some(([level, message]) => level === 'info' && message.includes('已启动')),
  '启动日志必须写出来',
);

console.log('ok   apply() 装配完整');
console.log(`ok   ${String(discovered.length)} 个静态兜底模型可用`);
console.log(`ok   路由：${calls.routes.join(' / ')}`);
console.log(`ok   命令：/${calls.commands[0].name}`);
console.log('ok   生命周期 effect 已注册');
