// Offline snapshots of the real classic bundle; no host, credentials or dependencies.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escapeText = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = value => escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const kebab = name => name.startsWith('--') ? name : name.replace(/[A-Z]/g, c => '-' + c.toLowerCase()).replace(/^ms-/, '-ms-');
const unitless = new Set(['opacity', 'lineHeight', 'fontWeight', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom', 'scale', 'fillOpacity', 'strokeOpacity', 'strokeWidth']);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const booleans = new Set(['checked', 'disabled', 'hidden', 'selected', 'multiple', 'required', 'readOnly', 'autoFocus']);

function renderer() {
  const instances = new Map();
  let current, effects = [], hosts = [], dirty = false;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } };
    },
    useState(initial) {
      if (!current) throw new Error('useState outside component');
      const owner = current, index = owner.cursor++;
      if (!(index in owner.hooks)) owner.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = owner.hooks[index];
      return [slot.value, value => {
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      }];
    },
    useEffect(callback, deps) {
      if (!current) throw new Error('useEffect outside component');
      const owner = current, index = owner.cursor++, previous = owner.hooks[index];
      if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((d, i) => !Object.is(d, previous.deps[i]))) {
        const slot = { deps, cleanup: previous?.cleanup };
        owner.hooks[index] = slot;
        effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
      }
    },
  };
  function render(node, path = 'root') {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map((child, i) => render(child, path + '/' + (child?.props?.key ?? i))).join('');
    if (typeof node !== 'object') return escapeText(node);
    const { type, props } = node;
    if (typeof type === 'function') {
      let instance = instances.get(path);
      if (!instance || instance.type !== type) {
        instance?.hooks.forEach(h => h.cleanup?.());
        instance = { type, hooks: [], cursor: 0 };
        instances.set(path, instance);
      }
      const parent = current;
      current = instance; instance.cursor = 0;
      let child;
      try { child = type(props); } finally { current = parent; }
      return render(child, path + '/result');
    }
    hosts.push(node);
    let attrs = '';
    for (const [key, value] of Object.entries(props)) {
      if (['children', 'key', 'ref', 'dangerouslySetInnerHTML'].includes(key) || /^on[A-Z]/.test(key) || value == null) continue;
      const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
      if (booleans.has(key)) { if (value) attrs += ' ' + name.toLowerCase(); continue; }
      if (key === 'style') {
        const css = Object.entries(value).filter(([, v]) => v != null).map(([k, v]) => `${kebab(k)}:${typeof v === 'number' && v !== 0 && !unitless.has(k) && !k.startsWith('--') ? v + 'px' : v}`).join(';');
        attrs += ` style="${escapeAttr(css)}"`;
      } else if (typeof value !== 'function') attrs += ` ${name}="${escapeAttr(value)}"`;
    }
    if (voidTags.has(type)) return `<${type}${attrs}>`;
    return `<${type}${attrs}>${props.dangerouslySetInnerHTML?.__html ?? render(props.children, path + '/children')}</${type}>`;
  }
  return {
    React,
    async settle(tree) {
      for (let pass = 0; pass < 20; pass++) {
        dirty = false; hosts = [];
        const html = render(tree);
        const pending = effects; effects = [];
        pending.forEach(fn => fn());
        await new Promise(r => setImmediate(r));
        if (!dirty && !effects.length) return html;
      }
      throw new Error('Preview did not settle after 20 renders');
    },
    /** 点一个带 className 的宿主元素（如胶囊按钮），触发它的 onClick。 */
    click(className) {
      const target = hosts.find(n => String(n.props?.className || '').split(/\s+/).includes(className));
      if (!target?.props?.onClick) throw new Error('Missing clickable .' + className);
      target.props.onClick();
    },
    clickTab(index) {
      const tab = hosts.filter(n => n.props.role === 'tab')[index];
      if (!tab?.props.onClick) throw new Error('Missing tab ' + index);
      tab.props.onClick();
    },
    dispose() { instances.forEach(i => i.hooks.forEach(h => h.cleanup?.())); },
  };
}

function mock(signedout, loginExtra) {
  const now = Date.now();
  return {
    login: signedout
      ? { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true, ...(loginExtra ?? {}) }
      : { state: 'signed-in', source: 'oauth', name: 'xingx@example.com', hasServiceAk: true, canLogin: true, ...(loginExtra ?? {}) },
    points: signedout ? { state: 'unavailable' } : { state: 'ok', available: 12345, consumed: 678, frozen: 0, nextExpiry: '2026-12-01', updatedAtMs: now, grants: [{ remaining: 5000, expiresDate: '2026-11-20' }, { remaining: 7345, expiresDate: '2026-12-01' }] },
    projects: signedout ? [] : [{ urlId: 'proj-1', name: '默认项目', selected: true }, { urlId: 'proj-2', name: '测试项目', selected: false }],
    activeProject: signedout ? undefined : 'proj-1',
    // 与官网 `/api/v1/agent/models` 对齐：价格档位、说明、夜间折扣、上下文/输出。
    models: [
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', price: 'cheap', description: '千问最新平衡模型，精准快', discount: { label: 4, start: '22:00', end: '08:00' }, contextWindow: 200000, maxTokens: 64000, vision: true, enabled: true },
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', price: 'veryExpensive', discount: { label: 4, start: '22:00', end: '08:00' }, contextWindow: 200000, maxTokens: 64000, vision: true, enabled: true },
      { id: 'qwen3.7-max', name: 'Qwen3.7-Max', price: 'expensive', contextWindow: 200000, maxTokens: 64000, vision: false, enabled: true },
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', price: 'cheap', contextWindow: 200000, maxTokens: 64000, vision: true, enabled: true },
      { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', price: 'cheap', discount: { label: 5, start: '22:00', end: '08:00' }, contextWindow: 200000, maxTokens: 64000, vision: true, enabled: true },
      { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', price: 'moderate', contextWindow: 200000, maxTokens: 64000, vision: false, enabled: true },
      { id: 'moonshot/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', price: 'veryExpensive', contextWindow: 200000, maxTokens: 16384, vision: true, enabled: true },
      { id: 'bigmodel/glm-5.3-flash', name: 'GLM-5.3-Flash', price: 'cheap', contextWindow: 200000, maxTokens: 64000, vision: true, enabled: false },
    ],
    settings: { pollIntervalMs: 300000, composerPill: true, sidebarPanel: true, disabledModels: ['glm-5.2'] },
    gateway: 'https://api.meoo.host/meoo-ai/compatible-mode/v1', readAtMs: now, version: '0.0.1',
  };
}

async function preview(source, doc, slot, tabIndex, interact) {
  const runtime = renderer(), slots = new Map(), dictionaries = new Map(), cleanups = [], messages = [];
  let exported, css = '';
  const node = tag => ({ dataset: {}, textContent: '', appendChild(child) { if (child.tag === 'style') css += child.textContent; }, tag });
  // Poll timers intentionally stay inert: snapshots advance only through the render loop.
  let timer = 0;
  const sandbox = {
    window: { __ModuleLoader__: { load(def) { exported = def.factory(name => { if (name === 'react') return runtime.React; throw new Error('Unexpected require: ' + name); }); } } },
    document: { createElement: node, head: node('head'), querySelector: () => null, documentElement: node('html') },
    fetch: () => Promise.resolve({ ok: true, json: () => doc }),
    setInterval: () => ++timer, clearInterval() {}, setTimeout: () => ++timer, clearTimeout() {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console: { log() {}, warn: (...args) => messages.push(args.join(' ')), error: (...args) => messages.push(args.join(' ')) },
  };
  runInNewContext(source, sandbox, { filename: 'src/client/bundle.js', timeout: 5000 });
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose); },
    get: () => undefined,
    locale: {
      register(ns, dict) { dictionaries.set(ns, dict); return () => {}; },
      bind(ns) { return (key, values = {}) => {
        const text = dictionaries.get(ns)?.zh[key];
        if (text === undefined) throw new Error('Missing translation: ' + key);
        return text.replace(/\{(\w+)\}/g, (all, name) => values[name] ?? all);
      }; },
    },
    slots: { inject: (_name, cb) => cb(), register(entry, component) { slots.set(entry.name, { entry, component }); return () => {}; } },
  };
  try {
    exported.apply(ctx);
    await new Promise(r => setImmediate(r));
    if (!css) {
      const match = source.match(/var MEOO_CSS\s*=\s*(\[[\s\S]*?\]\.join\([^)]*\))/);
      if (!match) throw new Error('MEOO_CSS not found');
      css = new Function('return ' + match[1])();
    }
    const registered = slots.get(slot);
    if (!registered) throw new Error('Missing slot: ' + slot);
    const tree = runtime.React.createElement(registered.component, registered.entry.inject?.() ?? {});
    let html = await runtime.settle(tree);
    if (tabIndex !== undefined) { runtime.clickTab(tabIndex); html = await runtime.settle(tree); }
    if (interact !== undefined) { interact(runtime, tree); html = await runtime.settle(tree); }
    if (messages.length) throw new Error(messages.join('\n'));
    return { html, css };
  } finally { runtime.dispose(); cleanups.reverse().forEach(fn => fn()); }
}

const dark = {
  'bg-base': '#17181b', 'bg-layer-1': '#17181b', 'bg-layer-2': '#1e1f23', 'bg-layer-3': '#202126',
  'border-l1': 'rgba(127,127,127,.18)', 'border-l2': '#3a3d45', 'border-l3': '#4a4d57',
  'label-primary': '#f9fafb', 'label-secondary': '#c9ccd3', 'label-tertiary': '#999da6', 'label-dimmed': '#6b6f78', 'label-caption': '#8b8f98',
  'brand-primary': '#5686fe', link: '#7aa2ff', 'state-success-primary': '#22c55e', 'state-warn-primary': '#f59e0b', 'state-error-primary': '#ef4444',
  'interactive-bg-hover': 'rgba(255,255,255,.06)', 'switch-thumb': '#fff', 'bg-skeleton': 'rgba(255,255,255,.08)',
  'menu-group-header-fill': 'rgba(255,255,255,.04)', 'toast-bg': '#2a2c32', 'toast-label': '#f2f3f5',
};
const light = { ...dark, 'bg-base': '#ffffff', 'bg-layer-1': '#f7f8fa', 'bg-layer-2': '#ffffff', 'bg-layer-3': '#ffffff',
  'border-l1': 'rgba(15,17,21,.10)', 'border-l2': '#e3e5ea', 'border-l3': '#ccd0d8', 'label-primary': '#0f1115',
  'label-secondary': '#3d424b', 'label-tertiary': '#6b7280', 'brand-primary': '#2563eb', link: '#2563eb',
  'interactive-bg-hover': 'rgba(15,17,21,.05)', 'switch-thumb': '#fff', 'bg-skeleton': 'rgba(15,17,21,.08)',
  'menu-group-header-fill': 'rgba(15,17,21,.04)', 'toast-bg': '#ffffff', 'toast-label': '#0f1115' };
const themes = Object.entries({ dark, light }).map(([name, values]) => `html[data-theme="${name}"]{color-scheme:${name};${Object.entries(values).map(([key, value]) => `--dsw-alias-${key}:${value};`).join('')}}`).join('\n');
const shell = `*{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif}main{max-width:1120px;margin:40px auto;padding:24px} [hidden]{display:none!important}.preview-caption{font-size:14px;color:var(--dsw-alias-label-tertiary);margin-bottom:24px}.composer{width:560px;min-height:180px;padding:20px;border:1px solid #3a3d45;border-radius:18px;background:#1e1f23;color:#f9fafb;display:flex;flex-direction:column;justify-content:space-between;--dsh-composer-dock-inset:#4a4d57}.composer-footer{display:flex;align-items:flex-end;gap:16px;font-size:12px}.composer-hint{color:#999da6;font-size:14px}`;

async function main() {
  const args = process.argv.slice(2);
  let theme = 'dark', noShot = false, check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-shot') noShot = true;
    else if (args[i] === '--check') { noShot = true; check = true; }
    else if (args[i] === '--theme' && ['dark', 'light'].includes(args[i + 1])) theme = args[++i];
    else throw new Error('Usage: preview-ui.mjs [--no-shot] [--check] [--theme dark|light]');
  }
  const source = readFileSync(resolve(root, 'src/client/bundle.js'), 'utf8');
  const assets = resolve(root, 'docs/assets'), output = resolve(assets, 'preview');
  mkdirSync(output, { recursive: true });
  const pages = ['account', 'models', 'points', 'settings', 'diag'].map((name, index) => ({ name, file: 'ui-detail-' + name, slot: 'plugins.bundle.config', tab: index }));
  pages.push({ name: 'settings-page', file: 'ui-settings-page', slot: 'settings.section' }, { name: 'pill', file: 'ui-pill', slot: 'conversation.input.left' });
  // 弹层展开态单独出一张：收起态的截图证明不了「点开能看到什么」。
  pages.push({ name: 'pill-open', file: 'ui-pill-open', slot: 'conversation.input.left', interact: runtime => runtime.click('dsm-meoo-pill-btn') });
  // 登录的两种中间态：等授权、授权失败。它们是最需要肉眼确认「用户看得到」的两屏。
  pages.push({
    name: 'login-pending', file: 'ui-login-pending', slot: 'plugins.bundle.config', tab: 0, signedoutOnly: true,
    login: { pending: true, authorizeUrl: 'https://meoo.com/oauth/authorize?client_id=meoo_app_demo&redirect_uri=http%3A%2F%2F127.0.0.1%3A49669%2Foauth%2Fcallback&response_type=code&scope=cli.compat&state=demo&code_challenge=demo&code_challenge_method=S256' },
  });
  pages.push({
    name: 'login-error', file: 'ui-login-error', slot: 'plugins.bundle.config', tab: 0, signedoutOnly: true,
    login: { error: 'OAuth 换票失败 HTTP 400: invalid_grant' },
  });
  let shots = 0, failures = 0;
  const rendered = [];
  for (const signedout of [false, true]) for (const page of pages) {
    const suffix = (theme === 'light' ? '-light' : '') + (signedout ? '-signedout' : '');
    if (page.signedoutOnly && !signedout) continue;
    const { html, css } = await preview(source, mock(signedout, page.login), page.slot, page.tab, page.interact);
    if (!html.trim()) throw new Error('Empty render: ' + page.name);
    const title = `秒悟 Meoo · ${page.name} · ${signedout ? '未登录' : '已登录'} · ${theme}`;
    const body = page.name === 'pill' || page.name === 'pill-open' ? `<h1>对话输入框 · 积分胶囊</h1><p class="preview-caption">当前模型：qwen3.8-flash。余额读数显示在输入框底部，与模型选择器对齐。</p><div class="composer"><div class="composer-hint">向秒悟提问，输入消息…</div><div class="composer-footer"><span>qwen3.8-flash</span>${html}</div></div><p class="preview-caption">${signedout ? '未登录状态：积分暂不可用，授权后可读取账户余额。' : '已登录状态：可用积分 12,345；本预览使用模拟数据，不发送任何请求。'}</p>` : html;
    if (check) { rendered.push({ page: page.name, signedout, html, css }); continue; }
    const file = resolve(output, page.file + suffix + '.html');
    writeFileSync(file, `<!doctype html>\n<html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escapeText(title)}</title><style>${themes}\n${css}\n${shell}</style></head><body><main><div class="preview-caption">${escapeText(title)} · 离线 UI 预览</div>${body}</main></body></html>\n`);
    console.log('HTML ' + file);
    if (noShot) continue;
    const png = resolve(assets, 'dsh-connect-meoo-' + page.name + suffix + '.png');
    const started = Date.now();
    const result = spawnSync(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking', '--no-first-run',
      '--screenshot=' + png, '--window-size=1280,' + (page.name === 'pill' ? 900 : 1600), pathToFileURL(file).href,
    ], { windowsHide: true, timeout: 45000, encoding: 'utf8' });
    let valid = false;
    try { const stat = statSync(png); valid = stat.size > 20 * 1024 && stat.mtimeMs >= started - 2000; } catch {}
    if (result.error || result.status !== 0 || !valid) {
      failures++;
      console.warn(`截图失败 ${png}: ${result.error?.message || result.stderr?.trim() || 'Edge 未生成有效 PNG'}；可通过 EDGE_PATH 指定浏览器。`);
    } else { shots++; console.log('PNG  ' + png); }
  }
  if (check) {
    // 自检模式：只证明「组件能被离屏渲染出非空 HTML，且 CSS 真的被注入」。
    const problems = [];
    for (const item of rendered) {
      if (!item.html.trim()) problems.push(`${item.page} 渲染为空`);
      if (!item.css.includes('.dsm-meoo-page')) problems.push(`${item.page} 没有注入 MEOO_CSS`);
      if (item.html.includes('undefined') || item.html.includes('[object Object]')) problems.push(`${item.page} 渲染出 undefined / [object Object]`);
      if (item.page === 'pill-open' && !item.html.includes('dsm-meoo-pop')) problems.push('pill-open 没有展开弹层');
    }
    if (problems.length > 0) { console.error('离屏渲染自检失败：\n  - ' + problems.join('\n  - ')); process.exitCode = 1; return; }
    console.log(`离屏渲染自检通过：${rendered.length} 个页面非空、CSS 已注入、无 undefined。`);
    return;
  }
  console.log(`已生成 HTML，可直接用浏览器打开。截图成功 ${shots}，失败 ${failures}。`);
}

main().catch(error => { console.error('HTML 生成失败：' + error.stack); process.exitCode = 1; });
