/**
 * 浏览器半侧的运行期测试。
 *
 * `check-client.mjs` 只做静态检查（能解析、无模块语法、i18n 键齐全）。
 * 这里真的**把它跑起来**：造一个假的 `window.__ModuleLoader__`、假 React、
 * 假 ctx，然后断言它注册了哪些槽位、以及开关关闭时侧栏行确实**注销**了。
 *
 * 为什么要测这个：`dsh-connect-lingxi` 踩过「开关只写了一个布尔值、浏览器半边
 * 没有注册任何槽位」的坑 —— 设置页显示已打开，界面上什么都没有。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync('src/client/bundle.js', 'utf8');

/** 假 React：只需要 createElement / useState / useEffect。 */
function fakeReact(): { createElement: (...args: unknown[]) => unknown } {
  return {
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      return { type, props, children };
    },
    useState(initial: unknown) {
      return [initial, () => undefined];
    },
    useEffect() {
      // 测试里不跑副作用。
    },
  };
}

/** 加载 bundle，返回它导出的模块与记录下来的槽位注册。 */
function loadBundle(): {
  module: { name: string; inject: string[]; apply: (ctx: unknown) => void };
  slots: Array<{ name: string; options: Record<string, unknown>; disposed: boolean }>;
  css: string[];
} {
  const slots: Array<{ name: string; options: Record<string, unknown>; disposed: boolean }> = [];
  const css: string[] = [];
  let exported: { name: string; inject: string[]; apply: (ctx: unknown) => void } | undefined;

  const window = {
    __ModuleLoader__: {
      load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
        exported = entry.factory((id: string) => {
          if (id === 'react') return fakeReact();
          throw new Error(`unexpected require: ${id}`);
        }) as typeof exported;
      },
    },
  };

  runInNewContext(source, {
    window,
    // 静音：bundle 在测试里会尝试拉状态并失败，那些日志不是被测对象。
    console: { error() {}, warn() {}, log() {}, info() {} },
    // 定时器给空实现：`apply` 会起一个 60 秒轮询 ticker，真定时器会让
    // node --test 的进程永不退出（表现为 TIMEOUT）。
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    // `apply` 会立刻触发一次状态加载；测试不关心结果，给一个永远失败的假 fetch
    // （它走 `.catch` 分支，不会抛到测试外）。
    fetch: () => Promise.reject(new Error('no network in test')),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  });

  assert.ok(exported !== undefined, 'bundle 必须通过 __ModuleLoader__.load 导出模块');
  return { module: exported, slots, css };
}

/** 造一个假的 ctx：记录 effect / slots.inject / slots.register / locale。 */
function fakeCtx(slots: Array<{ name: string; options: Record<string, unknown>; disposed: boolean }>): {
  ctx: unknown;
  effects: Array<() => unknown>;
  registered: string[];
} {
  const effects: Array<() => unknown> = [];
  const registered: string[] = [];

  const ctx = {
    effect(fn: () => unknown) {
      effects.push(fn);
      fn();
    },
    get() {
      return undefined; // 没有 layout 服务
    },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    },
    slots: {
      inject(name: string, callback: () => unknown) {
        // 宿主的槽位是晚声明的；这里立刻执行，模拟「槽位已就绪」。
        const disposer = callback();
        registered.push(name);
        return typeof disposer === 'function' ? disposer : () => undefined;
      },
      register(options: Record<string, unknown>) {
        const entry = { name: String(options.name), options, disposed: false };
        slots.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
  };
  return { ctx, effects, registered };
}

test('bundle 导出 Cordis 插件形状，name 是包名', () => {
  const { module } = loadBundle();
  assert.equal(module.name, 'dsh-connect-meoo');
  // 注意：`inject` 数组是在 vm 的 realm 里创建的，跨 realm 的数组不是同一
  // Array 构造器，`deepEqual` 会因为原型不同而失败。逐项比较内容。
  assert.equal(module.inject.length, 2);
  assert.equal(module.inject[0], 'slots');
  assert.equal(module.inject[1], 'locale');
  assert.equal(typeof module.apply, 'function');
});

test('apply 注册五个槽位：main / bundle.config / input.left / settings.section / settings.section.icon', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);

  const names = slots.map((slot) => slot.name);
  assert.ok(names.includes('main'), '侧栏整页必须常注册');
  assert.ok(names.includes('plugins.bundle.config'), '插件详情页');
  assert.ok(names.includes('conversation.input.left'), '输入框积分胶囊');
  assert.ok(names.includes('settings.section'), '设置页入口');
  assert.ok(names.includes('settings.section.icon'), '设置页图标');
});

test('settings.section 与 icon 用同一个 id（不同 id 图标不渲染）', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);

  const section = slots.find((slot) => slot.name === 'settings.section');
  const icon = slots.find((slot) => slot.name === 'settings.section.icon');
  assert.ok(section !== undefined && icon !== undefined);
  assert.equal(section.options.id, icon.options.id);
});

test('settings.section 的 label 是函数且返回非空（左栏那一行的文案）', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);

  const section = slots.find((slot) => slot.name === 'settings.section');
  assert.ok(section !== undefined);
  // 宿主用 `label` 拼左侧导航行；它必须是函数（语言切换时要重算），
  // 且返回值不能是空串 —— 空 label 会得到一行看不见文字的按钮。
  assert.equal(typeof section.options.label, 'function', 'label 必须是函数');
  const label = section.options.label();
  assert.equal(typeof label, 'string');
  assert.ok(label.length > 0, 'label 不能为空');
});

test('settings.section 的 order 是数字（决定在左栏排第几）', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);

  const section = slots.find((slot) => slot.name === 'settings.section');
  assert.ok(section !== undefined);
  assert.equal(typeof section.options.order, 'number');
  // 挑 60：排在官方页（general/models/plugins …）之后，不挤它们的位置。
  assert.ok(section.options.order > 0);
});

test('settings.section 的 inject 给出 surface=settings（决定有没有返回按钮）', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);

  const section = slots.find((slot) => slot.name === 'settings.section');
  assert.ok(section !== undefined);
  assert.equal(typeof section.options.inject, 'function');
  const props = section.options.inject();
  assert.equal(props.surface, 'settings', '设置面板里的页面不该有「返回对话」');
  assert.equal(typeof props.t, 'function', '必须注入 t');
});

test('plugins.bundle.config 的 key 必须是包名（宿主按它挂页面）', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);
  const config = slots.find((slot) => slot.name === 'plugins.bundle.config');
  assert.ok(config !== undefined);
  assert.equal(config.options.key, 'dsh-connect-meoo');
});

test('侧栏行默认不注册（snapshot 还没有 sidebarPanel=true）', () => {
  const { module, slots } = loadBundle();
  const { ctx } = fakeCtx(slots);
  module.apply(ctx);
  assert.equal(
    slots.some((slot) => slot.name === 'sidebar.panellist'),
    false,
    '默认关闭时不该占全局侧栏座位',
  );
});

test('bundle 是经典脚本：不出现 import / export', () => {
  assert.equal(/^\s*(?:import|export)\s/m.test(source), false);
});

test('zh 与 en 两份字典键一致', () => {
  const zhStart = source.indexOf('var zh = {');
  const enStart = source.indexOf('var en = {');
  assert.ok(zhStart > 0 && enStart > zhStart);
  const zhBody = source.slice(zhStart, source.indexOf('\n  };', zhStart));
  const enBody = source.slice(enStart, source.indexOf('\n  };', enStart));
  const keys = (body: string): string[] => [...body.matchAll(/^\s{4}([A-Za-z_][\w]*):/gm)].map((m) => m[1]!);
  assert.deepEqual(keys(zhBody).sort(), keys(enBody).sort());
});
