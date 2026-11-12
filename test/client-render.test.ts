/**
 * 浏览器半侧的**渲染**测试。
 *
 * `check-client.mjs` 只做静态检查（能解析、无模块语法、i18n 键齐全）。
 * `client-bundle.test.ts` 只验槽位注册。两者都**不会执行组件函数** ——
 * 组件体里写错一个变量名、`props` 少解构一个字段，静态检查和注册测试全绿，
 * 而用户点开面板看到的是白屏 + 控制台一条红字。
 *
 * 这里用一个最小 React 实现（createElement / useState / useEffect）真的把
 * 每个组件跑一遍，断言：
 * 1. 五个分栏都能渲染出内容（不是空树）；
 * 2. 状态文档缺段落时也不崩（未登录 / 积分读不到 / 无模型）；
 * 3. 渲染结果里不出现 `undefined` / `NaN` / `[object Object]` 这些会直接显示给用户的东西。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync('src/client/bundle.js', 'utf8');

/** 一份完整的状态文档（与宿主 status.ts 的形状一致）。 */
function fullDoc(overrides = {}) {
  return {
    version: '0.0.1',
    login: { state: 'signed-in', source: 'oauth', name: 'tester', hasServiceAk: true, canLogin: true },
    points: { state: 'ok', available: 1234, consumed: 56, frozen: 0, nextExpiry: '2026-12-01', updatedAtMs: 1_700_000_000_000, grants: [{ remaining: 100, expiresDate: '2026-12-01' }] },
    projects: [{ urlId: 'p1', name: '项目一', selected: true }],
    activeProject: 'p1',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 128_000, vision: false, enabled: true },
      { id: 'qwen3-vl-plus', name: 'Qwen VL', contextWindow: 262_144, maxTokens: 32_768, vision: true, enabled: false },
    ],
    settings: { pollIntervalMs: 300_000, composerPill: true, sidebarPanel: true, disabledModels: [], checkinEnabled: true, checkinTime: '10:00' },
    accounts: [
      { id: 'cred_a', kind: 'apikey', name: '账号 A', masked: 'meoo_ak_…aaaa', active: true, savedAt: 1, hasServiceAk: true },
      { id: 'cred_b', kind: 'oauth', name: '账号 B', masked: '…bbbb', active: false, savedAt: 2, hasServiceAk: true },
    ],
    activeAccountId: 'cred_a',
    checkin: {
      enabled: true,
      time: '10:00',
      lastRunAtMs: 1_700_000_000_000,
      lastRunDate: '2026-11-12',
      due: false,
      records: [
        { name: '账号 A', kind: 'apikey', status: 'unsupported', message: 'API Key 调用 /api/mc/entitlement/init 会得到 HTTP 403。', atMs: 1_700_000_000_000 },
        { name: '账号 B', kind: 'oauth', status: 'already', amount: 2000, atMs: 1_700_000_000_000 },
      ],
    },
    gateway: 'https://api.meoo.host/meoo-ai/compatible-mode/v1',
    readAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * 最小 React 实现。
 *
 * 只做三件事：建元素树、给 useState 一个可写状态、执行 useEffect。
 * 不跑 diff —— 我们要的是「组件函数能不能跑完」，不是虚拟 DOM 正确性。
 */
function makeReact() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const hookStates = [];
  let hookIndex = 0;
  const effects = [];

  return {
    createElement: h,
    useState(initial) {
      const index = hookIndex;
      hookIndex += 1;
      if (!(index in hookStates)) hookStates[index] = initial;
      const setter = (next) => {
        hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next;
      };
      return [hookStates[index], setter];
    },
    useEffect(fn) {
      effects.push(fn);
    },
    /** 每次渲染前重置 hook 游标（React 的规则：hooks 顺序固定）。 */
    __reset() {
      hookIndex = 0;
    },
    /** 渲染结束后跑一遍收集到的 effect（返回清理函数列表）。 */
    __runEffects() {
      const cleanups = [];
      for (const fn of effects.splice(0)) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      return cleanups;
    },
    __hooks: hookStates,
  };
}

/**
 * 加载 bundle，返回它的模块。
 *
 * @param {object} options.doc - 状态路由返回的文档（undefined = 请求失败）。
 */
function loadBundle(options = {}) {
  const react = makeReact();
  const registered = [];
  const actionCalls: any[] = [];
  let exported;

  const window = {
    __ModuleLoader__: {
      load(entry) {
        exported = entry.factory((id) => {
          if (id === 'react') return react;
          throw new Error(`unexpected require: ${id}`);
        });
      },
    },
  };

  const fetchStub = (input: any, init?: any) => {
    // 动作请求（POST …/action?action=…）走单独的桩：默认回 { ok: true }，
    // 让「保存成功」这类分支可测；不关心返回值时用 options.actionResult 覆盖。
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (url.includes('/action') && (init?.method ?? '').toUpperCase() === 'POST') {
      actionCalls.push({ url, body: init?.body });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(options.actionResult ?? { ok: true, status: options.doc }),
      });
    }
    if (options.doc === undefined) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(options.doc),
    });
  };

  runInNewContext(source, {
    window,
    console: { error() {}, warn() {}, log() {}, info() {} },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    fetch: fetchStub,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Promise,
  });

  assert.ok(exported !== undefined, 'bundle 必须导出模块');

  // 装一个假 ctx 跑 apply，把注册的组件收集起来。
  const ctx = {
    effect(fn) {
      fn();
    },
    get() {
      return undefined;
    },
    locale: { register: () => () => undefined, bind: () => (key, vars) => (vars === undefined ? key : `${key}${JSON.stringify(vars)}`) },
    slots: {
      inject(_name, callback) {
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => undefined;
      },
      register(entry, component) {
        registered.push({ entry, component });
        return () => undefined;
      },
    },
  };
  exported.apply(ctx);

  return { module: exported, registered, react, actionCalls };
}

/**
 * 递归渲染元素树，返回扁平文本。
 *
 * 用迭代而不是递归：组件树可能有嵌套循环，递归容易爆栈。
 */
function renderText(node, react) {
  const out = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || current === false) continue;
    if (typeof current === 'string' || typeof current === 'number') {
      out.push(String(current));
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push(current[i]);
      continue;
    }
    if (typeof current === 'object' && 'type' in current) {
      const { type, props, children } = current;
      // 函数组件：重置 hook 游标后执行（模拟 React 的每组件独立 hook 槽）。
      if (typeof type === 'function') {
        react.__reset();
        const rendered = type({ ...props, children });
        stack.push(rendered);
        continue;
      }
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return out.join(' ');
}

/**
 * 递归收集元素树里所有 `dangerouslySetInnerHTML` 的 HTML。
 *
 * 图标就是用它塞 SVG 的，光看文本收集不到。
 */
function renderHtml(node, react) {
  const out = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || current === false) continue;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push(current[i]);
      continue;
    }
    if (typeof current !== 'object' || !('type' in current)) continue;
    const { type, props, children } = current;
    if (typeof type === 'function') {
      react.__reset();
      stack.push(type({ ...props, children }));
      continue;
    }
    const html = props?.dangerouslySetInnerHTML?.__html;
    if (typeof html === 'string') out.push(html);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return out.join('');
}

/** 找到某个槽位注册的组件。 */
function componentOf(registered, slotName) {
  const entry = registered.find((item) => item.entry.name === slotName);
  assert.ok(entry !== undefined, `必须注册了 ${slotName} 槽位`);
  return entry.component;
}

/**
 * 加载 bundle 并**等状态真的到达**。
 *
 * 为什么必须 await：`snapshot` 是模块级变量，由 `apply` 里那次异步 `load()` 填充。
 * 同步渲染拿到的是 `undefined`，只会测到「默认态」—— 那 9 项先通过、
 * 4 项失败的假象就是这么来的。
 */
async function setup(doc) {
  const bundle = loadBundle({ doc });
  // 冲掉 microtask 队列，让 load() 的 Promise 链跑完。
  await new Promise((resolve) => setImmediate(resolve));
  return bundle;
}

/** 渲染一个组件，返回文本。 */
function render(bundle, component, props) {
  bundle.react.__reset();
  const tree = component(props);
  const text = renderText(tree, bundle.react);
  bundle.react.__runEffects();
  return text;
}

test('插件详情页能渲染出五个分栏的标题', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.ok(text.length > 0, '详情页不能渲染成空树');
  for (const key of ['tabAccount', 'tabModels', 'tabPoints', 'tabSettings', 'tabDiag']) {
    assert.ok(text.includes(key), `详情页必须渲染出 ${key} 标签`);
  }
});

test('未登录时账号栏给 API Key 入口与说明，不崩', async () => {
  const bundle = await setup(
    fullDoc({
      login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true },
      points: { state: 'unavailable' },
      projects: [],
      activeProject: undefined,
    }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.ok(text.includes('apiKeyTitle'), '未登录必须有 API Key 输入区');
  assert.ok(text.includes('apiKeySave'), '必须有「保存并自动解析」按钮');
  assert.ok(text.includes('signedOutHint'), '未登录必须给说明文案');
});

test('积分读不到时渲染说明，不显示 NaN', async () => {
  const bundle = await setup(fullDoc({ points: { state: 'unavailable' } }));
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.equal(text.includes('NaN'), false, '不能把 NaN 显示给用户');
  assert.ok(text.includes('pointsUnavailable'), '要说明「暂时读不到」');
});

test('手填 AK 时积分栏说明「读不到积分账户」而不是显示 0', async () => {
  const bundle = await setup(
    fullDoc({
      login: { state: 'signed-in', source: 'ak', hasServiceAk: true, canLogin: true },
      points: { state: 'unavailable' },
    }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.ok(text.includes('pointsAkOnly'), '手填 AK 必须说明读不到积分');
});

test('空模型目录渲染「还没有读到」而不是空列表', async () => {
  const bundle = await setup(fullDoc({ models: [] }));
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.ok(text.includes('noModels'), '空目录要给说明');
});

test('侧栏整页带返回按钮，详情页不带', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const pageText = render(bundle, Page, {
    t: (key) => key,
    surface: 'page',
    backToConversation: () => undefined,
  });
  assert.ok(pageText.includes('backToChat'), '整页必须有返回对话');

  const detailText = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.equal(detailText.includes('backToChat'), false, '详情页不该有返回对话（那里没有对话可回）');
});

test('积分胶囊在选中 Meoo 模型时显示余额', async () => {
  const bundle = await setup(fullDoc());
  const Pill = componentOf(bundle.registered, 'conversation.input.left');
  const text = render(bundle, Pill, {
    t: (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`),
    useProjection: () => ({ next: { provider: 'meoo' } }),
  });
  assert.ok(text.includes('pill'), '选中本插件时必须显示读数标签');
  // 余额走千分位（1234 → 1,234），这是有意为之：四位数字以上不加分隔符读不出来。
  assert.ok(text.includes('1,234'), '必须显示千分位格式的真实余额');
});

test('积分胶囊在选中别的 provider 时不渲染', async () => {
  const bundle = await setup(fullDoc());
  const Pill = componentOf(bundle.registered, 'conversation.input.left');
  const text = render(bundle, Pill, {
    t: (key) => key,
    useProjection: () => ({ next: { provider: 'workbuddy' } }),
  });
  assert.equal(text.trim(), '', '选中别的 provider 时不该出现秒悟余额');
});

test('积分胶囊在宿主没给投影时照常显示（「不知道」不等于「藏起来」）', async () => {
  const bundle = await setup(fullDoc());
  const Pill = componentOf(bundle.registered, 'conversation.input.left');
  const text = render(bundle, Pill, { t: (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`) });
  assert.ok(text.includes('pill'), '没有投影信息时按显示处理');
});

test('设置页入口渲染同一个页面', async () => {
  const bundle = await setup(fullDoc());
  const Section = componentOf(bundle.registered, 'settings.section');
  const text = render(bundle, Section, { t: (key) => key, surface: 'settings', close: () => undefined });
  assert.ok(text.includes('tabAccount'), '设置页必须渲染出分栏');
});

test('侧栏图标渲染 SVG', async () => {
  const bundle = await setup(fullDoc());
  const Icon = componentOf(bundle.registered, 'settings.section.icon');
  bundle.react.__reset();
  const tree = Icon({ size: 16, active: true });
  // 图标是 `MeooIcon` → 内部一个 span，用 dangerouslySetInnerHTML 塞 SVG。
  const html = renderHtml(tree, bundle.react);
  assert.ok(html.includes('<svg'), '图标必须是 SVG');
  assert.ok(html.includes('viewBox'), 'SVG 必须有 viewBox');
  assert.ok(html.includes('width="16"'), 'SVG 尺寸必须跟随 size');
});

test('侧栏图标跟随 size 与 active 变化（宿主传什么就画多大）', async () => {
  const bundle = await setup(fullDoc());
  const Icon = componentOf(bundle.registered, 'settings.section.icon');

  bundle.react.__reset();
  const small = renderHtml(Icon({ size: 14, active: false }), bundle.react);
  assert.ok(small.includes('width="14"'), 'size=14 必须画 14');

  bundle.react.__reset();
  const large = renderHtml(Icon({ size: 24, active: true }), bundle.react);
  assert.ok(large.includes('width="24"'), 'size=24 必须画 24');

  // active 决定颜色：选中态用主文字色，未选中用三级文字色。
  assert.notEqual(small, large, 'active 必须影响渲染结果');
});

test('侧栏图标在宿主不给 size 时有默认值（不能画出 0 宽）', async () => {
  const bundle = await setup(fullDoc());
  const Icon = componentOf(bundle.registered, 'settings.section.icon');
  bundle.react.__reset();
  const html = renderHtml(Icon({}), bundle.react);
  assert.ok(html.includes('width="16"'), '缺省 size 应为 16');
});

test('设置面板左栏整页：点进去是完整五栏页面（不是空壳）', async () => {
  const bundle = await setup(fullDoc());
  const Section = componentOf(bundle.registered, 'settings.section');
  // 模拟宿主：先取 inject() 给的 props，再渲染组件。
  const entry = bundle.registered.find((item) => item.entry.name === 'settings.section');
  const injected = entry.entry.inject();
  const text = render(bundle, Section, { ...injected, close: () => undefined });
  // 五个分栏都在 = 点进左栏那一行看到的是完整页面。
  for (const key of ['tabAccount', 'tabModels', 'tabPoints', 'tabSettings', 'tabDiag']) {
    assert.ok(text.includes(key), `左栏整页必须含 ${key}`);
  }
  // 设置面板里的页面不该有「返回对话」（那里没有对话可回）。
  assert.equal(text.includes('backToChat'), false, '设置面板里不该有返回按钮');
});

test('状态请求失败时页面仍能渲染（不白屏）', async () => {
  const bundle = await setup(undefined); // fetch 永远 reject
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.ok(text.includes('tabAccount'), '读不到状态也要渲染出骨架，不能白屏');
});

test('渲染结果里不出现 undefined / [object Object]', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key) => key, surface: 'detail' });
  assert.equal(text.includes('undefined'), false, '不能把 undefined 打到界面上');
  assert.equal(text.includes('[object Object]'), false, '不能把对象直接渲染成字符串');
  assert.equal(text.includes('NaN'), false, '不能把 NaN 打到界面上');
});

// ---------------------------------------------------------------------------
// 交互语义：这些断言盯的是「控件真的表达状态」，不是「文字里出现过某键」。
// ---------------------------------------------------------------------------

/** 收集树里满足条件的宿主元素（函数组件会被展开）。 */
function collect(
  node: any,
  predicate: (node: any) => boolean,
  react: any,
  out: any[] = [],
): any[] {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || current === false) continue;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i -= 1) stack.push(current[i]);
      continue;
    }
    if (typeof current !== 'object' || !('type' in current)) continue;
    const { type, props, children } = current;
    if (typeof type === 'function') {
      react.__reset();
      stack.push(type({ ...props, children }));
      continue;
    }
    if (predicate(current)) out.push(current);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return out;
}

/** 直接挂载一个组件（不经 Page），便于读它自己的 hook 状态。 */
function mount(bundle: any, component: any, props: any): any {
  bundle.react.__reset();
  return component(props);
}

test('模型栏每个模型一个开关，aria-checked 与 enabled 一致', async () => {
  const bundle = await setup(fullDoc());
  const Models = componentOf(bundle.registered, 'plugins.bundle.config');
  // 直接从页面注册里拿不到 ModelsPanel，改为渲染整页再筛 role=switch。
  const Page = Models;
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const switches = collect(tree, (node) => node.type === 'button' && node.props?.role === 'switch', bundle.react);
  // 模型 2 个 + 界面开关 2 个 + 每日签到 1 个 = 5。
  assert.equal(switches.length, 5, '模型 2 个 + 界面 2 个 + 签到 1 个，共 5 个开关');
  const checked = switches.map((node) => node.props['aria-checked']);
  // fullDoc：glm-5.2 停用，qwen3-vl-plus 停用 → 模型开关是 true/false；
  // 设置里 composerPill / sidebarPanel 都是 true。
  assert.ok(checked.includes('true') && checked.includes('false'), '开关必须同时表达开与关');
  for (const node of switches) {
    assert.equal(node.props.className, 'dsm-meoo-switch');
    assert.ok(node.props['aria-label'] !== undefined, '每个开关都要有无障碍名');
  }
});

test('模型搜索框过滤列表：输入后只剩匹配项', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');

  const first = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const search = collect(first, (node) => node.type === 'input' && node.props?.type === 'search', bundle.react);
  assert.equal(search.length, 1, '模型栏必须有搜索框');
  assert.equal(search[0].props.value, '', '初始为空');
  search[0].props.onChange({ target: { value: 'glm' } });

  const second = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const text = renderText(second, bundle.react);
  assert.ok(text.includes('glm-5.2'), '匹配项要留下');
  assert.equal(text.includes('qwen3-vl-plus'), false, '不匹配项要过滤掉');
});

test('模型计数用「已启用 N / 共 M」表达，而不是只列名字', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  assert.ok(text.includes('modelsEnabledCount'), '必须有启用计数');
});

test('积分栏把可用积分渲染成独立读数块，并给出批次条', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const stats = collect(tree, (node) => node.props?.className === 'dsm-meoo-stat', bundle.react);
  assert.equal(stats.length, 1, '积分读数块只有一个');
  const bars = collect(tree, (node) => node.props?.className === 'dsm-meoo-bar', bundle.react);
  assert.equal(bars.length, 1, '每个积分批次一条占比条');
});

test('胶囊弹层：默认收起，点开后给出余额/已用/到期', async () => {
  const bundle = await setup(fullDoc());
  const Pill = componentOf(bundle.registered, 'conversation.input.left');
  const props = {
    t: (key: string, vars?: Record<string, unknown>) =>
      vars === undefined ? key : `${key}:${JSON.stringify(vars)}`,
    useProjection: () => ({ next: { provider: 'meoo' } }),
  };
  const closed = mount(bundle, Pill, props);
  assert.equal(
    collect(closed, (node) => node.props?.role === 'dialog', bundle.react).length,
    0,
    '默认不展开',
  );

  const trigger = collect(closed, (node) => node.props?.className === 'dsm-meoo-pill-btn', bundle.react)[0];
  assert.ok(trigger !== undefined, '胶囊必须有按钮');
  assert.equal(trigger.props['aria-expanded'], 'false');
  trigger.props.onClick();

  const opened = mount(bundle, Pill, props);
  const dialog = collect(opened, (node) => node.props?.role === 'dialog', bundle.react);
  assert.equal(dialog.length, 1, '点开后必须出现弹层');
  const text = renderText(opened, bundle.react);
  for (const key of ['pointsAvailable', 'pointsConsumed', 'pillPopTitle']) {
    assert.ok(text.includes(key), `弹层里要有 ${key}`);
  }
  assert.equal(text.includes('NaN'), false);
});

test('页头把登录态做成胶囊，未登录与已登录文案不同', async () => {
  const signedIn = await setup(fullDoc());
  const PageIn = componentOf(signedIn.registered, 'plugins.bundle.config');
  const inText = render(signedIn, PageIn, { t: (key: string) => key, surface: 'detail' });
  assert.ok(inText.includes('accountSignedIn'));

  const signedOut = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const PageOut = componentOf(signedOut.registered, 'plugins.bundle.config');
  const outText = render(signedOut, PageOut, { t: (key: string) => key, surface: 'detail' });
  assert.ok(outText.includes('accountSignedOut'));
});

test('登录在途时账号栏显示「等待授权」与可手动打开的链接', async () => {
  const bundle = await setup(
    fullDoc({
      login: {
        state: 'signed-out',
        source: 'none',
        hasServiceAk: false,
        canLogin: true,
        pending: true,
        authorizeUrl: 'https://meoo.com/oauth/authorize?client_id=x',
      },
    }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const text = renderText(tree, bundle.react);
  assert.ok(text.includes('loginPending'), '必须明说在等授权');
  const links = collect(tree, (node) => node.type === 'a' && node.props?.href !== undefined, bundle.react);
  assert.equal(links.length, 1, '必须给一条可手动打开的链接');
  assert.equal(links[0].props.href, 'https://meoo.com/oauth/authorize?client_id=x');
  assert.equal(links[0].props.target, '_blank');
});

test('登录失败原因显示在账号栏，而不是只进 console', async () => {
  const bundle = await setup(
    fullDoc({
      login: {
        state: 'signed-out',
        source: 'none',
        hasServiceAk: false,
        canLogin: true,
        error: 'OAuth 换票失败 HTTP 400: invalid_grant',
      },
    }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  assert.ok(text.includes('loginFailedTitle'), '要有「登录没有完成」的标题');
  assert.ok(text.includes('invalid_grant'), '上游原文必须露出来，否则用户没法反馈');
});

test('账号栏把 API Key 放在最前面，且不再说「手填 AK 读不到积分」这种过时话', async () => {
  const bundle = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });

  // API Key 输入框必须是页面上第一个密码框（主路径）。
  const passwordInputs = collect(
    tree,
    (node) => node.type === 'input' && node.props?.type === 'password',
    bundle.react,
  );
  assert.ok(passwordInputs.length >= 1, '必须有 API Key 输入框');
  // 测试里 t() 返回键名，所以断言键名而不是渲染后的字面值。
  assert.equal(
    passwordInputs[0].props.placeholder,
    'apiKeyPlaceholder',
    '第一个密码框应该是 API Key（占位符指向 apiKeyPlaceholder）',
  );

  const text = renderText(tree, bundle.react);
  assert.ok(text.includes('apiKeyTitle'), '要有 API Key 这一节');
  assert.ok(text.includes('apiKeyHint'), '要有生成 key 的指引');
});

test('项目服务 AK 不再是需要用户关心的状态行', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  // API Key 会自动换出 AK，把「未解析 / 已就绪」摆在账号栏只会让人以为要手动处理。
  assert.equal(text.includes('accountServiceAk'), false, '不该再有「项目服务 AK」状态行');
  assert.equal(text.includes('accountServiceAkMissing'), false, '不该再显示「未解析」');
});

test('API Key 是唯一密码输入框（项目服务 AK 入口已移除）', async () => {
  const bundle = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });

  const passwordInputs = collect(
    tree,
    (node) => node.type === 'input' && node.props?.type === 'password',
    bundle.react,
  );
  assert.equal(passwordInputs.length, 1, '页面上只该有 API Key 一个密码框');
  assert.equal(passwordInputs[0].props.placeholder, 'apiKeyPlaceholder');

  const text = renderText(tree, bundle.react);
  // 手填项目服务 AK、浏览器授权、项目选择都已删掉：填 API Key 就能全自动解析。
  assert.equal(text.includes('advancedTitle'), false, '「高级」整节已移除');
  assert.equal(text.includes('akTitle'), false, '手动指定项目服务 AK 已移除');
  assert.equal(text.includes('oauthTitle'), false, '浏览器授权入口已移除');
  assert.equal(text.includes('projectHint'), false, '项目选择已移除');
});

test('未登录时不显示「账号：未知 / 登录方式：无」两行空话', async () => {
  const bundle = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  assert.equal(text.includes('accountSource'), false, '未登录时不该有「登录方式」空行');
});

test('已登录时仍然显示账号名与登录方式', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  assert.ok(text.includes('accountSource'), '已登录要看得到登录方式');
  assert.ok(text.includes('tester'), '已登录要看得到账号名');
});

test('模型行显示官网价格档位与夜间折扣', async () => {
  const bundle = await setup(
    fullDoc({
      models: [
        { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 200000, maxTokens: 64000, vision: true, enabled: true, price: 'cheap', discount: { label: 4, start: '22:00', end: '08:00' }, description: '千问最新平衡模型' },
        { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 200000, maxTokens: 64000, vision: true, enabled: true, price: 'veryExpensive' },
      ],
    }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });

  const prices = collect(tree, (node) => node.props?.className === 'dsm-meoo-price', bundle.react);
  assert.equal(prices.length, 2, '每个带档位的模型一个价格标签');

  // 点阵：cheap 0 个亮点，veryExpensive 3 个 —— 与官网的四档表达一致。
  const litDots = (node: any): number =>
    collect(node, (child) => child.props?.className === 'dsm-meoo-price-dot' && child.props?.['data-on'] === 'true', bundle.react).length;
  assert.equal(litDots(prices[0]), 0, '便宜 = 0 个亮点');
  assert.equal(litDots(prices[1]), 3, '超贵 = 3 个亮点');

  const text = renderText(tree, bundle.react);
  assert.ok(text.includes('priceCheap'), '要显示「便宜」文字，不能只有点');
  assert.ok(text.includes('priceVeryExpensive'), '要显示「超贵」文字');
  assert.ok(text.includes('discountBadge'), '夜间折扣要显示');
  assert.ok(text.includes('千问最新平衡模型'), '官网说明要显示');
});

// ---------------------------------------------------------------------------
// API Key 是唯一主路径（对齐 qoder 的 PAT 模式）：
// 未登录时不该再摆「登录秒悟」主按钮，否则用户以为必须先登录。
// ---------------------------------------------------------------------------

test('未登录时没有「登录秒悟」按钮，浏览器授权入口也一并移除', async () => {
  const bundle = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });

  const text = renderText(tree, bundle.react);
  // API Key 是唯一入口：OAuth 按钮、浏览器授权行、「高级」节全部移除。
  assert.equal(text.includes('loginNow'), false, '不该再有「登录秒悟」按钮');
  assert.equal(text.includes('oauthTitle'), false, '不该再有浏览器授权入口');
  assert.equal(text.includes('advancedTitle'), false, '不该再有「高级」这一节');
  assert.ok(text.includes('apiKeyTitle'), 'API Key 输入区必须在');
});

test('未登录提示指向 API Key，而不是让人去点登录', async () => {
  const bundle = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const text = render(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  assert.ok(text.includes('signedOutHint'), '要有未登录提示');
});

test('已登录时也不出现登录按钮（API Key 是唯一路径）', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const text = renderText(tree, bundle.react);
  assert.equal(text.includes('loginNow'), false, '不该有登录按钮');
});

// ---------------------------------------------------------------------------
// API Key 保存必须有**可见**结果。
// 起因：失败分支把错误写进只在「登录在途」才渲染的 codeMsg，
// 未登录时点「保存并自动解析」界面毫无变化 —— 用户看到的就是「没生效」。
// ---------------------------------------------------------------------------

test('API Key 保存成功后渲染出解析结果（账号 / 积分 / 模型数）', async () => {
  const bundle = await setup(
    fullDoc({ login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true } }),
  );
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const first = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });

  const input = collect(
    first,
    (node) => node.type === 'input' && node.props?.type === 'password',
    bundle.react,
  )[0];
  input.props.onChange({ target: { value: 'meoo_ak_test' } });

  const second = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const button = collect(
    second,
    (node) => node.type === 'button' && node.props?.onClick !== undefined,
    bundle.react,
  ).find((node) => node.props.className.includes('dsm-meoo-btn-primary'));
  assert.ok(button !== undefined, '必须有主按钮');
  button.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));

  // fetch 桩固定返回 fullDoc（已登录 + 1234 分 + 2 模型），所以要看到成功文案。
  const third = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const text = renderText(third, bundle.react);
  assert.ok(text.includes('apiKeyOk'), '成功后必须渲染出解析结果，不能只清空输入框');
  assert.equal(text.includes('apiKeySave'), true, '按钮仍在（可继续换 key）');
});


test('手动刷新按钮走 refresh 动作，而不是只重读缓存 /status', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const buttons = collect(tree, (node) => node.type === 'button', bundle.react);
  const refresh = buttons.find((node) => (node.children ?? []).join('') === 'refresh');
  assert.ok(refresh !== undefined, '必须渲染出刷新按钮');
  refresh.props.onClick();
  assert.ok(
    bundle.actionCalls.some((call) => String(call.url).includes('action=refresh')),
    '刷新按钮必须 POST action=refresh（只 GET /status 会拿到宿主的缓存文档）',
  );
});

test('令牌列表渲染当前/非当前令牌，切换按钮发出 account-switch', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const text = renderText(tree, bundle.react);
  assert.ok(text.includes('tokensTitle'), '必须渲染令牌列表标题');
  assert.ok(text.includes('账号 A') && text.includes('账号 B'), '两个令牌都要出现');
  assert.ok(text.includes('tokenActive'), '当前令牌要有标记');
  const buttons = collect(tree, (node) => node.type === 'button', bundle.react);
  const use = buttons.find((node) => (node.children ?? []).join('') === 'tokenUse');
  assert.ok(use !== undefined, '非当前令牌要有切换按钮');
  use.props.onClick();
  const call = bundle.actionCalls.find((item) => String(item.url).includes('action=account-switch'));
  assert.ok(call !== undefined, '切换按钮必须 POST account-switch');
  assert.deepEqual(JSON.parse(String(call.body)), { id: 'cred_b' });
});

test('签到卡片显示逐令牌结果与立即签到按钮', async () => {
  const bundle = await setup(fullDoc());
  const Page = componentOf(bundle.registered, 'plugins.bundle.config');
  const tree = mount(bundle, Page, { t: (key: string) => key, surface: 'detail' });
  const text = renderText(tree, bundle.react);
  assert.ok(text.includes('checkinTitle'), '必须渲染签到卡片');
  assert.ok(text.includes('checkinUnsupported'), 'API Key 的如实结果要显示');
  assert.ok(text.includes('checkinAlready'), '已领取结果要显示');
  const buttons = collect(tree, (node) => node.type === 'button', bundle.react);
  // 假 React 的 hook 槽在多次渲染间复用，busy 可能残留为 true；两种文案都算签到按钮。
  const now = buttons.find((node) => ['checkinNow', 'checkinRunning'].includes((node.children ?? []).join('')));
  assert.ok(now !== undefined, '必须有立即签到按钮');
  now.props.onClick();
  assert.ok(bundle.actionCalls.some((item) => String(item.url).includes('action=checkin')));
});
