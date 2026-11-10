/**
 * 浏览器半侧：插件设置卡片（账号 / 模型 / 积分 / 设置 / 诊断）+ 输入框积分胶囊 + 侧栏整页。
 *
 * 这是一个**经典脚本**，不是 ES 模块：宿主用 `<script>` 加载它，然后调用
 * `window.__ModuleLoader__.load({ id, factory })`，把 factory 交给 `require`
 * （解析到浏览器自己的模块表）。所以这里：
 * - 不 import 任何东西，React 从 `require('react')` 拿（宿主提供，不重复打包）；
 * - 导出的模块形状与 Cordis 插件一致：`{ name, inject, apply }`。
 *
 * 三个界面读同一份数据：
 * 1. `plugins.bundle.config` —— 插件详情页（主入口）；
 * 2. `settings.section` —— 设置面板左侧导航里的一页；
 * 3. `conversation.input.left` —— 输入框左侧的积分胶囊。
 * 它们共用一个 store 与一个 ticker，所以多一个界面不会多一次请求。
 *
 * 数据来源只有宿主的两条路由：`/plugins/dsh-connect-meoo/status` 与 `.../action`。
 * **access token 与项目服务 AK 永远不会到这里**（这就是不直接问上游的原因）。
 *
 * 视觉语言对齐 `dsh-connect-workbuddy`（同一套 DSH 主题变量）：
 * - 一个主题一张 `border-radius:12px` 的卡片，行之间只用 1px 分隔线；
 * - 节标题在卡片外，标题 / 说明 / 右侧动作一行排开；
 * - 状态用色点与胶囊表达，不整行染色；
 * - 设置项的语义是「立即生效的开关」，所以用 switch 而不是 checkbox；
 * - 所有颜色走 `--dsw-alias-*`，取不到时回落到暗色值。
 */

(function bootstrapMeooClient() {
  /** 与 package.json 的 name 一致；宿主用它在 `/plugins/<id>/client.js` 下提供本文件。 */
  var BUNDLE_NAME = 'dsh-connect-meoo';
  /** 本插件注册的 provider id（与宿主侧 constants.ts 的 PROVIDER 一致）。 */
  var PROVIDER_ID = 'meoo';
  var PANEL_ID = 'dsh-connect-meoo';
  var STATUS_PATH = '/plugins/dsh-connect-meoo/status';
  var ACTION_PATH = '/plugins/dsh-connect-meoo/action';
  /** 界面多久问一次宿主。宿主自己的刷新节奏由 pollIntervalMs 决定，这里只是界面轮询。 */
  var UI_POLL_MS = 60000;

  var MEOO_CSS = [
    /* ── 页面骨架 ─────────────────────────────────────────────── */
    '.dsm-meoo-page{--dsm-card:var(--dsw-alias-bg-layer-3,#202126);',
    '--dsm-card-2:var(--dsw-alias-bg-layer-2,#1e1f23);',
    '--dsm-border:var(--dsw-alias-border-l2,#3a3d45);',
    '--dsm-divider:var(--dsw-alias-border-l1,rgba(127,127,127,.18));',
    '--dsm-text:var(--dsw-alias-label-primary,#e6e6e6);',
    '--dsm-sub:var(--dsw-alias-label-secondary,#c9ccd3);',
    '--dsm-muted:var(--dsw-alias-label-tertiary,#999da6);',
    '--dsm-brand:var(--dsw-alias-brand-primary,#5686fe);',
    '--dsm-ok:var(--dsw-alias-state-success-primary,#22c55e);',
    '--dsm-warn:var(--dsw-alias-state-warn-primary,#f59e0b);',
    '--dsm-err:var(--dsw-alias-state-error-primary,#ef4444);',
    '--dsm-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
    'box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;display:flex;flex-direction:column;gap:16px;',
    'color:var(--dsm-text);font-size:13px;line-height:1.55;overflow-wrap:anywhere;text-align:left}',
    '.dsm-meoo-page *,.dsm-meoo-page *::before,.dsm-meoo-page *::after{box-sizing:border-box}',
    '.dsm-meoo-page[data-surface="page"]{padding:24px clamp(16px,3vw,36px) 40px;min-height:100%;overflow:auto}',
    '.dsm-meoo-page[data-surface="detail"],.dsm-meoo-page[data-surface="settings"]{padding:2px 0 14px}',

    /* ── 页头 ─────────────────────────────────────────────────── */
    '.dsm-meoo-hero{display:flex;align-items:flex-start;gap:12px;min-width:0}',
    '.dsm-meoo-logo{flex:none;width:36px;height:36px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;',
    'color:#fff;background:linear-gradient(135deg,var(--dsm-brand),#3f63c9);box-shadow:0 1px 3px rgba(0,0,0,.28)}',
    '.dsm-meoo-hero-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.dsm-meoo-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
    '.dsm-meoo-title{margin:0;font-size:17px;font-weight:600;line-height:24px}',
    '.dsm-meoo-desc{margin:0;font-size:12px;line-height:19px;color:var(--dsm-muted)}',
    '.dsm-meoo-head-actions{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',

    /* ── 分栏 ─────────────────────────────────────────────────── */
    '.dsm-meoo-tabs{position:sticky;top:-1px;z-index:3;display:flex;gap:2px;min-width:0;overflow-x:auto;',
    'border-bottom:1px solid var(--dsm-divider);background:var(--dsw-alias-bg-base,#17181b);scrollbar-width:none}',
    '.dsm-meoo-tabs::-webkit-scrollbar{display:none}',
    '.dsm-meoo-tab{appearance:none;font:inherit;font-size:13px;font-weight:600;line-height:20px;cursor:pointer;flex:none;',
    'border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;padding:7px 11px;white-space:nowrap;',
    'color:var(--dsm-muted);transition:color .15s,border-color .15s}',
    '.dsm-meoo-tab:hover{color:var(--dsm-text)}',
    '.dsm-meoo-tab[aria-selected="true"]{color:var(--dsm-text);border-bottom-color:var(--dsm-brand)}',
    '.dsm-meoo-tab:focus-visible{outline:2px solid var(--dsm-brand);outline-offset:1px}',
    '.dsm-meoo-panel{display:flex;flex-direction:column;gap:16px;min-width:0}',
    '.dsm-meoo-panel[hidden]{display:none}',

    /* ── 节标题（卡片外） ─────────────────────────────────────── */
    '.dsm-meoo-section{display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.dsm-meoo-section-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;min-height:24px}',
    '.dsm-meoo-section-titles{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:1px}',
    '.dsm-meoo-section-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsm-text)}',
    '.dsm-meoo-section-desc{font-size:12px;line-height:18px;color:var(--dsm-muted)}',
    '.dsm-meoo-section-actions{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',

    /* ── 卡片与行 ─────────────────────────────────────────────── */
    '.dsm-meoo-card{min-width:0;border:1px solid var(--dsm-border);border-radius:12px;background:var(--dsm-card);overflow:hidden}',
    '.dsm-meoo-row{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 14px;border-top:1px solid var(--dsm-divider)}',
    '.dsm-meoo-row:first-child{border-top:0}',
    '.dsm-meoo-row[data-interactive="true"]{cursor:pointer;transition:background .16s}',
    '.dsm-meoo-row[data-interactive="true"]:hover{background:var(--dsm-hover)}',
    '.dsm-meoo-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
    '.dsm-meoo-row-name{font-size:13px;line-height:20px;color:var(--dsm-text);display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
    '.dsm-meoo-row-sub{font-size:12px;line-height:18px;color:var(--dsm-muted)}',
    '.dsm-meoo-row-side{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
    '.dsm-meoo-hint{padding:10px 14px;border-top:1px solid var(--dsm-divider);font-size:12px;line-height:18px;color:var(--dsm-muted)}',
    '.dsm-meoo-hint:first-child{border-top:0}',
    '.dsm-meoo-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--dsm-divider)}',
    '.dsm-meoo-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-top:1px solid var(--dsm-divider);font-size:12px;line-height:18px}',
    '.dsm-meoo-banner-info{background:color-mix(in srgb,var(--dsm-warn) 8%,transparent)}',
    '.dsm-meoo-banner-error{color:var(--dsm-err);background:color-mix(in srgb,var(--dsm-err) 8%,transparent)}',
    '.dsm-meoo-banner>.dsm-meoo-dot{margin-top:6px}',
    '.dsm-meoo-banner-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.dsm-meoo-banner-title{font-weight:600}',
    '.dsm-meoo-banner-text{color:var(--dsm-muted);word-break:break-word}',
    '.dsm-meoo-banner-error .dsm-meoo-banner-text{color:inherit;opacity:.85}',
    '.dsm-meoo-banner-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}',
    '.dsm-meoo-inline-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}',
    '.dsm-meoo-link{align-self:flex-start;color:var(--dsm-brand);text-decoration:none;font-weight:600}',
    '.dsm-meoo-link:hover{text-decoration:underline}',
    '.dsm-meoo-empty{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:16px 14px;color:var(--dsm-muted);font-size:12px;line-height:18px}',
    '.dsm-meoo-empty-title{font-size:13px;font-weight:600;color:var(--dsm-sub)}',

    /* ── 按钮 ─────────────────────────────────────────────────── */
    '.dsm-meoo-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;',
    'justify-content:center;gap:6px;padding:4px 11px;border-radius:8px;border:1px solid var(--dsm-border);background:transparent;',
    'color:var(--dsm-text);white-space:nowrap;transition:background .16s,border-color .16s,color .16s}',
    '.dsm-meoo-btn:hover:not(:disabled){background:var(--dsm-hover)}',
    '.dsm-meoo-btn:disabled{opacity:.45;cursor:default}',
    '.dsm-meoo-btn:focus-visible{outline:2px solid var(--dsm-brand);outline-offset:1px}',
    '.dsm-meoo-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsm-brand));',
    'color:var(--dsw-alias-label-primary-inverted,#fff)}',
    '.dsm-meoo-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsm-brand));filter:brightness(1.06)}',
    '.dsm-meoo-btn-quiet{border-color:transparent;color:var(--dsm-muted)}',
    '.dsm-meoo-btn-quiet:hover:not(:disabled){color:var(--dsm-text)}',
    '.dsm-meoo-btn-sm{padding:2px 8px;font-size:11px;line-height:17px;border-radius:7px}',

    /* ── 开关（设置项语义：立即生效） ─────────────────────────── */
    '.dsm-meoo-switch{appearance:none;font:inherit;cursor:pointer;position:relative;flex:none;width:34px;height:20px;padding:0;border:0;',
    'border-radius:999px;background:var(--dsw-alias-border-l2,#3a3d45);transition:background .18s}',
    '.dsm-meoo-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
    'background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .18s}',
    '.dsm-meoo-switch[aria-checked="true"]{background:var(--dsm-brand)}',
    '.dsm-meoo-switch[aria-checked="true"]::after{transform:translateX(14px)}',
    '.dsm-meoo-switch:disabled{opacity:.45;cursor:default}',
    '.dsm-meoo-switch:focus-visible{outline:2px solid var(--dsm-brand);outline-offset:2px}',

    /* ── 分段控件（刷新间隔这类少选项） ───────────────────────── */
    '.dsm-meoo-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;border:1px solid var(--dsm-border);background:var(--dsm-card-2)}',
    '.dsm-meoo-seg-item{appearance:none;font:inherit;font-size:12px;line-height:18px;cursor:pointer;border:0;border-radius:7px;',
    'padding:3px 9px;background:transparent;color:var(--dsm-muted);white-space:nowrap;transition:background .16s,color .16s}',
    '.dsm-meoo-seg-item:hover{color:var(--dsm-text)}',
    '.dsm-meoo-seg-item[aria-pressed="true"]{background:var(--dsm-card);color:var(--dsm-text);box-shadow:0 1px 2px rgba(0,0,0,.18)}',
    '.dsm-meoo-seg-item:focus-visible{outline:2px solid var(--dsm-brand);outline-offset:-1px}',

    /* ── 胶囊 / 色点 / 数字 ───────────────────────────────────── */
    '.dsm-meoo-chip{display:inline-flex;align-items:center;gap:4px;flex:none;border-radius:999px;padding:1px 8px;font-size:11px;',
    'line-height:17px;font-weight:500;border:1px solid var(--dsm-border);color:var(--dsm-sub);background:transparent;white-space:nowrap}',
    '.dsm-meoo-chip-ok{color:var(--dsm-ok);border-color:color-mix(in srgb,var(--dsm-ok) 42%,transparent);',
    'background:color-mix(in srgb,var(--dsm-ok) 12%,transparent)}',
    '.dsm-meoo-chip-warn{color:var(--dsm-warn);border-color:color-mix(in srgb,var(--dsm-warn) 42%,transparent);',
    'background:color-mix(in srgb,var(--dsm-warn) 12%,transparent)}',
    '.dsm-meoo-chip-err{color:var(--dsm-err);border-color:color-mix(in srgb,var(--dsm-err) 42%,transparent);',
    'background:color-mix(in srgb,var(--dsm-err) 12%,transparent)}',
    '.dsm-meoo-chip-brand{color:var(--dsm-brand);border-color:color-mix(in srgb,var(--dsm-brand) 42%,transparent);',
    'background:color-mix(in srgb,var(--dsm-brand) 12%,transparent)}',
    '.dsm-meoo-price{display:inline-flex;align-items:center;gap:6px;flex:none}',
    '.dsm-meoo-price-dots{display:inline-flex;align-items:center;gap:3px}',
    // 未点亮的点也要看得见：只靠「有几个亮点」区分档位，亮点太暗就分不出便宜与适中。
    '.dsm-meoo-price-dot{width:7px;height:7px;border-radius:50%;background:transparent;',
    'box-shadow:inset 0 0 0 1px var(--dsm-border)}',
    '.dsm-meoo-price-dot[data-on="true"]{background:var(--dsm-brand);box-shadow:none}',
    '.dsm-meoo-price-label{font-size:11px;line-height:17px;color:var(--dsm-muted);white-space:nowrap}',
    '.dsm-meoo-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsm-muted)}',
    '.dsm-meoo-dot[data-tone="ok"]{background:var(--dsm-ok)}',
    '.dsm-meoo-dot[data-tone="warn"]{background:var(--dsm-warn)}',
    '.dsm-meoo-dot[data-tone="err"]{background:var(--dsm-err)}',
    '.dsm-meoo-num{font-variant-numeric:tabular-nums}',

    /* ── 积分读数 ─────────────────────────────────────────────── */
    '.dsm-meoo-stat{display:flex;flex-direction:column;gap:4px;padding:14px 14px 12px}',
    '.dsm-meoo-stat-label{font-size:12px;line-height:18px;color:var(--dsm-muted)}',
    '.dsm-meoo-stat-value{display:flex;align-items:baseline;gap:6px;font-size:28px;font-weight:600;line-height:34px;',
    'letter-spacing:-.01em;font-variant-numeric:tabular-nums}',
    '.dsm-meoo-stat-unit{font-size:12px;font-weight:500;color:var(--dsm-muted)}',
    '.dsm-meoo-stat-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsm-muted)}',
    '.dsm-meoo-stat-meta b{font-weight:600;color:var(--dsm-sub);font-variant-numeric:tabular-nums}',
    '.dsm-meoo-grant{padding:10px 14px;border-top:1px solid var(--dsm-divider);display:flex;flex-direction:column;gap:6px}',
    '.dsm-meoo-grant:first-child{border-top:0}',
    '.dsm-meoo-grant-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}',
    '.dsm-meoo-grant-amount{font-weight:600;font-variant-numeric:tabular-nums}',
    '.dsm-meoo-grant-expiry{color:var(--dsm-muted)}',
    '.dsm-meoo-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-skeleton,rgba(127,127,127,.16));overflow:hidden}',
    '.dsm-meoo-bar>i{display:block;height:100%;border-radius:inherit;background:var(--dsm-brand);transition:width .24s}',

    /* ── 表单 ─────────────────────────────────────────────────── */
    '.dsm-meoo-input{flex:1 1 240px;min-width:0;font:inherit;font-size:12px;line-height:18px;padding:6px 10px;border-radius:8px;',
    'border:1px solid var(--dsm-border);background:transparent;color:inherit}',
    '.dsm-meoo-input::placeholder{color:var(--dsm-muted)}',
    '.dsm-meoo-input:focus{outline:none;border-color:var(--dsm-brand);box-shadow:0 0 0 3px rgba(86,134,254,.18)}',
    '.dsm-meoo-search{position:relative;display:flex;align-items:center;flex:1 1 200px;max-width:280px}',
    '.dsm-meoo-search>input{width:100%;padding-left:28px}',
    '.dsm-meoo-search>svg{position:absolute;left:9px;pointer-events:none;color:var(--dsm-muted)}',
    '.dsm-meoo-select{font:inherit;font-size:12px;line-height:18px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsm-border);',
    'background:var(--dsm-card);color:inherit;max-width:100%}',
    '.dsm-meoo-select:focus{outline:none;border-color:var(--dsm-brand);box-shadow:0 0 0 3px rgba(86,134,254,.18)}',

    /* ── 诊断 ─────────────────────────────────────────────────── */
    '.dsm-meoo-kv{margin:0;display:grid;grid-template-columns:minmax(104px,168px) 1fr}',
    '.dsm-meoo-kv>dt{padding:7px 14px;font-size:12px;line-height:18px;color:var(--dsm-muted);border-top:1px solid var(--dsm-divider)}',
    '.dsm-meoo-kv>dd{margin:0;padding:7px 14px;font-size:12px;line-height:18px;border-top:1px solid var(--dsm-divider);',
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;color:var(--dsm-sub)}',
    '.dsm-meoo-pre{margin:0;padding:10px 14px;border-top:1px solid var(--dsm-divider);font-size:11px;line-height:18px;',
    'white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsm-sub);',
    'background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.06))}',
    '.dsm-meoo-error{display:flex;gap:8px;align-items:flex-start;padding:10px 14px;border-top:1px solid var(--dsm-divider);',
    'color:var(--dsm-err);font-size:12px;line-height:18px;background:color-mix(in srgb,var(--dsm-err) 8%,transparent)}',

    /* ── 输入框积分胶囊 ───────────────────────────────────────── */
    '.dsm-meoo-pill{position:relative;display:inline-flex;align-items:center}',
    '.dsm-meoo-pill-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;display:inline-flex;align-items:center;gap:6px;',
    'padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-composer-dock-inset,var(--dsw-alias-border-l2,#3a3d45));',
    'background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;white-space:nowrap;',
    'transition:background .16s,border-color .16s,color .16s}',
    '.dsm-meoo-pill-btn:hover{background:var(--dsm-hover)}',
    '.dsm-meoo-pill-btn[aria-expanded="true"]{border-color:var(--dsm-brand);color:var(--dsm-text)}',
    '.dsm-meoo-pill-btn:focus-visible{outline:2px solid var(--dsm-brand);outline-offset:2px}',
    '.dsm-meoo-pill-num{font-variant-numeric:tabular-nums;font-weight:600}',
    '.dsm-meoo-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;min-width:236px;max-width:min(320px,80vw);',
    'display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);',
    'background:var(--dsw-alias-toast-bg,#2a2c32);color:var(--dsw-alias-toast-label,#f2f3f5);',
    'box-shadow:0 10px 28px rgba(0,0,0,.28);overflow:hidden;font-size:12px;line-height:18px;text-align:left}',
    '.dsm-meoo-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;',
    'border-bottom:1px solid rgba(127,127,127,.22)}',
    '.dsm-meoo-pop-title{font-weight:600}',
    '.dsm-meoo-pop-body{display:flex;flex-direction:column;gap:4px;padding:9px 12px}',
    '.dsm-meoo-pop-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
    '.dsm-meoo-pop-row>span:last-child{font-variant-numeric:tabular-nums;font-weight:600}',
    '.dsm-meoo-pop-foot{display:flex;justify-content:flex-end;padding:8px 12px;border-top:1px solid rgba(127,127,127,.22)}',
    '.dsm-meoo-pop-foot-note{padding:0 12px 9px;font-size:11px;line-height:16px;opacity:.62}',

    /* ── 窄容器：行内换行，不出现横向滚动 ─────────────────────── */
    '@media (max-width:640px){',
    '.dsm-meoo-row{flex-wrap:wrap}',
    '.dsm-meoo-row-side{justify-content:flex-start}',
    '.dsm-meoo-kv{grid-template-columns:1fr}',
    '.dsm-meoo-kv>dd{padding-top:0;border-top:0}',
    '.dsm-meoo-hero{flex-wrap:wrap}',
    '}',
  ].join('\n');

  var zh = {
    tabAccount: '账号',
    tabModels: '模型',
    tabPoints: '积分',
    tabSettings: '设置',
    tabDiag: '诊断',
    backToChat: '返回对话',
    openPanel: '打开秒悟面板',
    metaTitle: 'DSH Connect 秒悟 Meoo',
    metaDescription:
      '把秒悟 Meoo 的模型接入 DSH：填一个 API Key 即可，这里管理账号、积分余额、模型目录与开关。',
    name: 'Meoo 秒悟',
    pill: '秒悟',
    pillPoints: '秒悟 · {points}',
    pillUnknown: '秒悟 · —',
    pillPopTitle: '秒悟积分',
    account: '账号',
    accountState: '登录态',
    accountSignedIn: '已登录',
    accountSignedOut: '未登录',
    accountExpired: '登录态已失效',
    accountName: '账号',
    accountSource: '登录方式',
    sourceOauth: '浏览器授权',
    sourceLocal: '复用本机登录态',
    sourceAk: '手填项目服务 AK',
    sourceApiKey: 'API Key',
    sourceNone: '无',
    loginNow: '登录秒悟',
    loggingIn: '授权中…',
    loginPending: '等待浏览器授权…',
    loginOpenManual: '手动打开授权页',
    loginCodeLabel: '回调地址或授权码',
    loginCodePlaceholder: '粘贴回调地址（含 code=…），或只粘 code 的值',
    loginCodeSubmit: '提交授权码',
    loginCodeSubmitting: '校验中…',
    loginCodeHint: '浏览器显示「无法访问此网站 / 127.0.0.1 拒绝连接」时用这里：把地址栏整行复制过来即可。',
    loginCodeEmpty: '请先粘贴回调地址或授权码',
    loginRetry: '重新发起登录',
    loginRestartHint: '浏览器关掉了？点这里换一个新的授权链接。',
    loginFailedTitle: '登录没有完成',
    loginPendingHint: '授权页已经打开。在浏览器里点一次「授权」即可；没看到页面就点下面的链接。',
    loginErrorHint: '如果一直停在这里，可以复制这条原因去反馈。',
    logout: '退出登录',
    refresh: '刷新',
    refreshing: '刷新中…',
    loginHint:
      '点「浏览器授权」会在浏览器打开授权页；点一次「授权」后，项目与 AI 服务 AK 会自动解析。',
    signedInHint:
      '登录态已就绪，项目与 AI 服务 AK 会自动解析。换账号就重新填一个 API Key。',
    signedOutHint:
      '还没有读到秒悟凭据。在上面填一个 API Key 即可 —— 插件会自动读出账号、项目与积分，不用再登录。',
    expiredHint: '登录态已失效。重新填一次 API Key，或在「高级 → 浏览器授权」里重新授权。',
    apiKeyTitle: 'API Key（推荐）',
    apiKeyLabel: '控制面 API Key（meoo_ak_…）',
    apiKeyPlaceholder: 'meoo_ak_…',
    apiKeySave: '保存并自动解析',
    apiKeySaving: '解析中…',
    apiKeyHint:
      '在 meoo.com → 设置 → API 密钥 里生成一串 meoo_ak_… 粘贴到这里。插件会用它读出账号、项目与积分，并自动换出项目服务 AK —— 不用点浏览器，也不会过期。',
    apiKeyBadType: '这是项目服务 AK，不是 API Key；API Key 以 meoo_ak_ 开头。',
    advancedTitle: '高级',
    oauthTitle: '浏览器授权',
    oauthHint: '没有 API Key 时的备选：在浏览器里点一次「授权」。',
    akTitle: '手动指定项目服务 AK',
    akLabel: '项目服务 AK（meoo_project_service_v1.…）',
    akPlaceholder: 'meoo_project_service_v1.…',
    akSave: '校验并保存',
    akSaving: '校验中…',
    akHint: '默认不需要：上面的 API Key 会自动换出项目服务 AK。只有想手动指定某个项目时才打开。手填的 AK 读不到积分。',
    project: '项目',
    projectNone: '未选中项目',
    projectSwitch: '切换',
    projectHint: 'AK 挂在项目下，换项目会重新解析 AK。',
    points: '积分',
    pointsAvailable: '可用积分',
    pointsConsumed: '已用',
    pointsFrozen: '冻结',
    pointsUnit: '积分',
    pointsExpiry: '{date} 到期',
    pointsNoExpiry: '没有临期积分',
    pointsUnavailable: '积分暂时读不到（上游没给读数）',
    pointsExpired: '登录态失效，积分读不到',
    pointsAkOnly: '手填项目服务 AK 读不到积分账户；改用 API Key 或浏览器授权即可看到余额。',
    pointsGrants: '积分批次',
    pointsGrantsHint: '按到期时间排序，先到期的先用。',
    pointsNoGrants: '没有可用的积分批次',
    pointsUpdated: '更新于 {time}',
    pointsTotal: '合计',
    models: '模型目录',
    modelsHint: '勾选启用/停用；停用的模型会从模型选择器里彻底消失。',
    modelsEnabledCount: '已启用 {enabled} / 共 {total}',
    enableAll: '全部启用',
    disableAll: '全部停用',
    modelsTestHint: '测试会真实请求一次上游，消耗少量积分。',
    noModels: '还没有读到模型目录',
    searchModels: '搜索模型',
    filterAll: '全部',
    searchModelsPlaceholder: '搜索模型名或 id…',
    noMatch: '没有匹配的模型',
    clearSearch: '清除搜索',
    priceCheap: '便宜',
    priceModerate: '适中',
    priceExpensive: '较贵',
    priceVeryExpensive: '超贵',
    discountBadge: '夜间{discount}折',
    modelEnabled: '已启用',
    modelDisabled: '已停用',
    modelContext: '{value}K 上下文',
    modelMaxOutput: '输出 {value}K',
    modelVision: '图片',
    modelTest: '测试',
    modelTesting: '测试中…',
    modelTestOk: '可用',
    settings: '设置',
    sectionInterface: '界面',
    pollInterval: '刷新间隔',
    poll1: '1 分钟',
    poll5: '5 分钟',
    poll10: '10 分钟',
    poll30: '30 分钟',
    poll60: '60 分钟',
    pollHint: '界面每分钟问一次宿主；宿主按这个间隔回上游取积分与目录。',
    composerPill: '在输入框显示积分读数',
    sidebarPanel: '在侧边栏显示秒悟面板',
    settingsHint: '这些开关点一下即生效，不需要保存。',
    diagnostic: '诊断',
    sectionRuntime: '运行状态',
    sectionLastAction: '最近一次操作',
    diagVersion: '插件版本',
    diagGateway: '网关',
    diagLogin: '登录态',
    diagSource: '登录方式',
    diagProject: '当前项目',
    diagModels: '目录模型数',
    diagEnabled: '已启用',
    diagError: '上游最近一次错误',
    diagReadAt: '读数时间',
    diagNone: '无',
    diagAuthFile: '登录态文件',
    copyDiagnostics: '复制诊断信息',
    copied: '已复制',
    copyFailed: '复制失败',
    lastAction: '最近一次操作',
    lastActionEmpty: '还没有操作',
    actionFailed: '操作失败',
    notAvailable: '不可用',
    unknown: '未知',
  };

  var en = {
    tabAccount: 'Account',
    tabModels: 'Models',
    tabPoints: 'Points',
    tabSettings: 'Settings',
    tabDiag: 'Diagnostics',
    backToChat: 'Back to chat',
    openPanel: 'Open Meoo panel',
    metaTitle: 'DSH Connect Meoo',
    metaDescription:
      'Meoo (秒悟) as a DSH model provider: one browser sign-in, then manage sign-in, points, the model catalog and switches here.',
    name: 'Meoo',
    pill: 'Meoo',
    pillPoints: 'Meoo · {points}',
    pillUnknown: 'Meoo · —',
    pillPopTitle: 'Meoo points',
    account: 'Account',
    accountState: 'Status',
    accountSignedIn: 'Signed in',
    accountSignedOut: 'Signed out',
    accountExpired: 'Sign-in expired',
    accountName: 'Account',
    accountSource: 'Sign-in method',
    sourceOauth: 'Browser sign-in',
    sourceLocal: 'Reused local sign-in',
    sourceAk: 'Pasted project AK',
    sourceApiKey: 'API key',
    sourceNone: 'None',
    loginNow: 'Sign in to Meoo',
    loggingIn: 'Authorising…',
    loginPending: 'Waiting for browser…',
    loginOpenManual: 'Open the authorisation page',
    loginCodeLabel: 'Callback URL or code',
    loginCodePlaceholder: 'Paste the callback URL (with code=…) or just the code',
    loginCodeSubmit: 'Submit code',
    loginCodeSubmitting: 'Verifying…',
    loginCodeHint: 'Use this when the browser shows “can’t reach 127.0.0.1”: copy the whole address bar here.',
    loginCodeEmpty: 'Paste the callback URL or the code first',
    loginRetry: 'Start over',
    loginRestartHint: 'Closed the browser? Use this for a fresh authorisation link.',
    loginFailedTitle: 'Sign-in did not complete',
    loginPendingHint: 'The authorisation page is open. Press Authorise once in your browser; if you cannot see it, use the link below.',
    loginErrorHint: 'If it stays here, copy this reason into a bug report.',
    logout: 'Sign out',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    loginHint:
      '“Sign in to Meoo” opens the authorisation page in your browser; press Authorise once and the project plus AI service AK are resolved automatically. You can also paste an AK here or use /meoo key.',
    signedInHint:
      'Signed in. The project and AI service AK are resolved automatically. To switch accounts, paste a different API key.',
    signedOutHint:
      'No Meoo credentials yet. Paste an API key above — the plugin reads your account, project and points automatically. No sign-in needed.',
    expiredHint: 'The sign-in expired. Paste an API key again, or re-authorise under Advanced → Browser sign-in.',
    apiKeyTitle: 'API Key (recommended)',
    apiKeyLabel: 'Control-plane API key (meoo_ak_…)',
    apiKeyPlaceholder: 'meoo_ak_…',
    apiKeySave: 'Save and resolve',
    apiKeySaving: 'Resolving…',
    apiKeyHint:
      'Create a meoo_ak_… key at meoo.com → Settings → API keys and paste it here. The plugin reads your account, projects and points with it and resolves the project service AK automatically — no browser, no expiry.',
    apiKeyBadType: 'That is a project service AK, not an API key; API keys start with meoo_ak_.',
    advancedTitle: 'Advanced',
    oauthTitle: 'Browser sign-in',
    oauthHint: 'Fallback when you have no API key: approve once in your browser.',
    akTitle: 'Set a project service AK by hand',
    akLabel: 'Project service AK (meoo_project_service_v1.…)',
    akPlaceholder: 'meoo_project_service_v1.…',
    akSave: 'Verify and save',
    akSaving: 'Verifying…',
    akHint: 'Normally unnecessary: the API key above resolves the project service AK for you. Turn this on only to pin one project by hand. A pasted AK cannot read points.',
    project: 'Project',
    projectNone: 'No project selected',
    projectSwitch: 'Switch',
    projectHint: 'The AK belongs to a project; switching re-resolves it.',
    points: 'Points',
    pointsAvailable: 'Available',
    pointsConsumed: 'Used',
    pointsFrozen: 'Frozen',
    pointsUnit: 'pts',
    pointsExpiry: 'expires {date}',
    pointsNoExpiry: 'Nothing expiring',
    pointsUnavailable: 'Points are not readable right now (upstream gave no reading)',
    pointsExpired: 'Sign-in expired, points unavailable',
    pointsAkOnly: 'A pasted project AK cannot read the points account; use an API key or browser sign-in to see the balance.',
    pointsGrants: 'Grants',
    pointsGrantsHint: 'Sorted by expiry — the nearest batch is spent first.',
    pointsNoGrants: 'No usable grants',
    pointsUpdated: 'updated {time}',
    pointsTotal: 'Total',
    models: 'Model catalog',
    modelsHint: 'Tick to enable or disable; disabled models disappear from the model picker entirely.',
    modelsEnabledCount: '{enabled} of {total} enabled',
    enableAll: 'Enable all',
    disableAll: 'Disable all',
    modelsTestHint: 'A test makes one real upstream request and spends a few points.',
    noModels: 'No model catalog yet',
    searchModels: 'Search models',
    filterAll: 'All',
    searchModelsPlaceholder: 'Search by name or id…',
    noMatch: 'No matching model',
    clearSearch: 'Clear search',
    priceCheap: 'Cheap',
    priceModerate: 'Moderate',
    priceExpensive: 'Expensive',
    priceVeryExpensive: 'Very expensive',
    discountBadge: '{discount}% off at night',
    modelEnabled: 'Enabled',
    modelDisabled: 'Disabled',
    modelContext: '{value}K context',
    modelMaxOutput: '{value}K output',
    modelVision: 'Images',
    modelTest: 'Test',
    modelTesting: 'Testing…',
    modelTestOk: 'Available',
    settings: 'Settings',
    sectionInterface: 'Interface',
    pollInterval: 'Refresh interval',
    poll1: '1 minute',
    poll5: '5 minutes',
    poll10: '10 minutes',
    poll30: '30 minutes',
    poll60: '60 minutes',
    pollHint: 'The panel asks the host once a minute; the host re-reads points and catalog upstream at this interval.',
    composerPill: 'Show points in the composer',
    sidebarPanel: 'Show a Meoo panel in the sidebar',
    settingsHint: 'These switches apply immediately; there is nothing to save.',
    diagnostic: 'Diagnostics',
    sectionRuntime: 'Runtime',
    sectionLastAction: 'Last action',
    diagVersion: 'Plugin version',
    diagGateway: 'Gateway',
    diagLogin: 'Sign-in',
    diagSource: 'Sign-in method',
    diagProject: 'Active project',
    diagModels: 'Catalog models',
    diagEnabled: 'Enabled',
    diagError: 'Last upstream error',
    diagReadAt: 'Read at',
    diagNone: 'None',
    diagAuthFile: 'Sign-in file',
    copyDiagnostics: 'Copy diagnostics',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    lastAction: 'Last action',
    lastActionEmpty: 'No action yet',
    actionFailed: 'Action failed',
    notAvailable: 'Unavailable',
    unknown: 'Unknown',
  };

  window.__ModuleLoader__.load({
    id: BUNDLE_NAME,
    factory: function (require) {
      var React = require('react');
      var h = React.createElement;

      // ---------------------------------------------------------------------
      // 数据层：一个 store + 一个 ticker，三个界面共用
      // ---------------------------------------------------------------------

      /** 当前状态文档（`undefined` = 还没读到）。 */
      var snapshot;
      var listeners = [];
      var inflight;
      var ticker;
      /** 最近一次动作的结果（诊断栏展示）。 */
      var lastAction;

      function notify() {
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            console.error('[dsh-connect-meoo] listener failed:', error);
          }
        });
      }

      /** 读状态。并发调用共享同一个在途请求。 */
      function load(force) {
        if (inflight !== undefined && !force) return inflight;
        inflight = fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('status HTTP ' + res.status);
            return res.json();
          })
          .then(function (doc) {
            snapshot = doc;
            notify();
            return doc;
          })
          .catch(function (error) {
            // 读不到状态**不清空**上一份：界面上宁可是旧读数，也不要一片空白。
            console.error('[dsh-connect-meoo] 读取状态失败:', error);
            return snapshot;
          })
          .finally(function () {
            inflight = undefined;
          });
        return inflight;
      }

      /** 发一个动作。成功后重拉状态（不做乐观更新）。 */
      function act(action, body) {
        return fetch(ACTION_PATH + '?action=' + encodeURIComponent(action), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        })
          .then(function (res) {
            return res.json();
          })
          .then(function (result) {
            lastAction = result;
            notify();
            return load(true).then(function () {
              return result;
            });
          })
          .catch(function (error) {
            lastAction = { ok: false, error: String(error && error.message ? error.message : error) };
            notify();
            return lastAction;
          });
      }

      function subscribe(listener) {
        listeners.push(listener);
        if (ticker === undefined) {
          ticker = setInterval(function () {
            void load(false);
          }, UI_POLL_MS);
        }
        void load(false);
        return function () {
          listeners = listeners.filter(function (entry) {
            return entry !== listener;
          });
          if (listeners.length === 0 && ticker !== undefined) {
            clearInterval(ticker);
            ticker = undefined;
          }
        };
      }

      /** 数字千分位。 */
      function num(value) {
        if (typeof value !== 'number' || !isFinite(value)) return '—';
        return new Intl.NumberFormat('en-US').format(value);
      }

      /** 时间戳 → `HH:MM`。 */
      function clock(ms) {
        if (typeof ms !== 'number' || ms <= 0) return '—';
        var date = new Date(ms);
        var pad = function (n) {
          return (n < 10 ? '0' : '') + n;
        };
        return pad(date.getHours()) + ':' + pad(date.getMinutes());
      }

      /** 上下文窗口 → `1M` / `200K`（目录里多是整千整百万）。 */
      function contextLabel(value) {
        if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—';
        if (value >= 1000000) {
          var millions = value / 1000000;
          return (millions % 1 === 0 ? String(millions) : millions.toFixed(1)) + 'M';
        }
        return Math.round(value / 1000) + 'K';
      }

      /** 一个 key 的订阅 hook（经典脚本里手写，避免依赖宿主 hooks 名称）。 */
      function useSnapshot() {
        var state = React.useState(0);
        var bump = state[1];
        React.useEffect(function () {
          var unsubscribe = subscribe(function () {
            bump(function (n) {
              return n + 1;
            });
          });
          return unsubscribe;
        }, []);
        return snapshot;
      }

      // ---------------------------------------------------------------------
      // 小组件
      // ---------------------------------------------------------------------

      /** 一行：左侧名称/副标题，右侧一组控件。 */
      function Row(props) {
        var body = h(
          'div',
          { className: 'dsm-meoo-row-main' },
          h('div', { className: 'dsm-meoo-row-name' }, props.name),
          props.sub === undefined || props.sub === null ? null : h('div', { className: 'dsm-meoo-row-sub' }, props.sub),
        );
        var rowProps = { className: 'dsm-meoo-row' };
        if (props.onClick !== undefined) {
          rowProps['data-interactive'] = 'true';
          rowProps.onClick = props.onClick;
          rowProps.role = 'button';
          rowProps.tabIndex = 0;
        }
        if (props.key !== undefined) rowProps.key = props.key;
        var children = [body];
        if (props.children !== undefined) {
          children.push(h('div', { className: 'dsm-meoo-row-side' }, props.children));
        }
        return h.apply(null, ['div', rowProps].concat(children));
      }

      /** 节：标题 + 说明 + 右侧动作，下面一张卡片。 */
      function Section(props) {
        return h(
          'section',
          { className: 'dsm-meoo-section' },
          h(
            'div',
            { className: 'dsm-meoo-section-head' },
            h(
              'div',
              { className: 'dsm-meoo-section-titles' },
              h('span', { className: 'dsm-meoo-section-title' }, props.title),
              props.desc === undefined || props.desc === null
                ? null
                : h('span', { className: 'dsm-meoo-section-desc' }, props.desc),
            ),
            props.actions === undefined || props.actions === null
              ? null
              : h('div', { className: 'dsm-meoo-section-actions' }, props.actions),
          ),
          h('div', { className: 'dsm-meoo-card' }, props.children),
        );
      }

      /** 简单卡片（不需要节标题时用，例如页头下方的状态卡）。 */
      function Card(props) {
        return h('div', { className: 'dsm-meoo-card' }, props.children);
      }

      /** 胶囊标签。`tone`：ok / warn / err / brand。 */
      function Chip(props) {
        var tone = props.tone === undefined ? '' : ' dsm-meoo-chip-' + props.tone;
        return h('span', { className: 'dsm-meoo-chip' + tone }, props.children);
      }

      /** 状态色点。 */
      function Dot(props) {
        return h('span', { className: 'dsm-meoo-dot', 'data-tone': props.tone === undefined ? 'idle' : props.tone });
      }

      /** 开关：`aria-checked` 是唯一真源，视觉全在 CSS 里。 */
      function Switch(props) {
        return h('button', {
          type: 'button',
          role: 'switch',
          className: 'dsm-meoo-switch',
          'aria-checked': props.checked === true ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled === true,
          onClick: function () {
            if (props.disabled === true) return;
            if (typeof props.onChange === 'function') props.onChange(props.checked !== true);
          },
        });
      }

      /** 分段控件。`options` = `[{ value, label }]`。 */
      function Segmented(props) {
        return h(
          'div',
          { className: 'dsm-meoo-seg', role: 'group', 'aria-label': props.label },
          props.options.map(function (option) {
            return h(
              'button',
              {
                key: String(option.value),
                type: 'button',
                className: 'dsm-meoo-seg-item',
                'aria-pressed': String(option.value) === String(props.value) ? 'true' : 'false',
                onClick: function () {
                  if (typeof props.onChange === 'function') props.onChange(option.value);
                },
              },
              option.label,
            );
          }),
        );
      }

      /**
       * 价格档位：三个点 + 文字，与官网模型选择器同一套表达。
       *
       * 官网用 `cheap / moderate / expensive / veryExpensive` 四档，点阵分别是
       * 0 实心 / 1 实心 / 2 实心 / 3 实心。这里保持一致，用户在两处看到的是同一个说法。
       */
      function PriceTag(props) {
        var t = props.t;
        var tier = props.price;
        if (tier === undefined) return null;
        var filled = tier === 'cheap' ? 0 : tier === 'moderate' ? 1 : tier === 'expensive' ? 2 : 3;
        var label =
          tier === 'cheap'
            ? t('priceCheap')
            : tier === 'moderate'
              ? t('priceModerate')
              : tier === 'expensive'
                ? t('priceExpensive')
                : t('priceVeryExpensive');
        var dots = [];
        for (var index = 0; index < 3; index += 1) {
          dots.push(
            h('span', {
              key: String(index),
              className: 'dsm-meoo-price-dot',
              'data-on': index < filled ? 'true' : 'false',
            }),
          );
        }
        return h(
          'span',
          { className: 'dsm-meoo-price', title: label, 'aria-label': label },
          h('span', { className: 'dsm-meoo-price-dots' }, dots),
          h('span', { className: 'dsm-meoo-price-label' }, label),
        );
      }

      /** 空态：标题 + 说明，别给一个空白卡片。 */
      function Empty(props) {
        return h(
          'div',
          { className: 'dsm-meoo-empty' },
          h('span', { className: 'dsm-meoo-empty-title' }, props.title),
          props.children === undefined ? null : h('span', null, props.children),
        );
      }

      /** 插件 logo（内联 SVG：经典脚本里没有打包资源管线）。 */
      function MeooIcon(props) {
        var size = typeof props.size === 'number' ? props.size : 16;
        return h('span', {
          style: {
            display: 'inline-flex',
            width: String(size) + 'px',
            height: String(size) + 'px',
            alignItems: 'center',
            justifyContent: 'center',
          },
          dangerouslySetInnerHTML: {
            __html:
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' +
              String(size) +
              '" height="' +
              String(size) +
              '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              // 秒表的圆环 + 指针：呼应「秒」；圆环缺口让它不像系统自带的时钟图标。
              '<path d="M20.5 12a8.5 8.5 0 1 1-4.2-7.34"/>' +
              '<path d="M12 8v4.5l3 1.8"/>' +
              '<path d="M17 3.5l2.5 2.5"/>' +
              '</svg>',
          },
        });
      }

      // ---------------------------------------------------------------------
      // 各分栏
      // ---------------------------------------------------------------------

      /** 登录态 → 色点 tone。 */
      function loginTone(state) {
        if (state === 'signed-in') return 'ok';
        if (state === 'expired') return 'warn';
        return 'idle';
      }

      /** 登录态 → 文案。 */
      function loginLabel(t, state) {
        if (state === 'signed-in') return t('accountSignedIn');
        if (state === 'expired') return t('accountExpired');
        return t('accountSignedOut');
      }

      /** 账号栏：登录态 + 登录/退出 + 手填 AK + 项目选择。 */
      function AccountPanel(props) {
        var t = props.t;
        var doc = useSnapshot();
        var akState = React.useState('');
        var ak = akState[0];
        var setAk = akState[1];
        var busyState = React.useState('');
        var busy = busyState[0];
        var setBusy = busyState[1];
        var apiKeyState = React.useState('');
        var apiKeyInput = apiKeyState[0];
        var setApiKeyInput = apiKeyState[1];
        var showAkState = React.useState(false);
        var showAk = showAkState[0];
        var setShowAk = showAkState[1];
        var codeState = React.useState('');
        var loginCode = codeState[0];
        var setLoginCode = codeState[1];
        var codeMsgState = React.useState('');
        var codeMsg = codeMsgState[0];
        var setCodeMsg = codeMsgState[1];

        var login = doc === undefined ? undefined : doc.login;
        var state = login === undefined ? 'signed-out' : login.state;
        var source = login === undefined ? 'none' : login.source;

        function sourceLabel() {
          if (source === 'oauth') return t('sourceOauth');
          if (source === 'local') return t('sourceLocal');
          if (source === 'apikey') return t('sourceApiKey');
          if (source === 'ak') return t('sourceAk');
          return t('sourceNone');
        }

        function doLogin(restart) {
          setBusy('login');
          void act('login', restart === true ? { restart: true } : undefined).then(function (result) {
            setBusy('');
            // 失败原因必须留在界面上：上一版只 console.error，用户看到的是「点了没反应」。
            if (result !== undefined && result.ok === false) {
              console.error('[dsh-connect-meoo] 登录失败:', result.error);
            }
          });
        }

        function saveApiKey() {
          if (apiKeyInput.trim() === '') return;
          setBusy('apikey');
          setCodeMsg('');
          void act('apikey', { apiKey: apiKeyInput.trim() }).then(function (result) {
            setBusy('');
            if (result !== undefined && result.ok === true) {
              setApiKeyInput('');
            } else {
              setCodeMsg(result !== undefined && result.error !== undefined ? String(result.error) : t('actionFailed'));
            }
          });
        }

        function submitLoginCode() {
          if (loginCode.trim() === '') {
            setCodeMsg(t('loginCodeEmpty'));
            return;
          }
          setBusy('code');
          setCodeMsg('');
          void act('login-code', { code: loginCode.trim() }).then(function (result) {
            setBusy('');
            if (result !== undefined && result.ok === true) {
              setLoginCode('');
              setCodeMsg(String(result.message || t('loginCodeSubmitting')));
            } else {
              setCodeMsg(result !== undefined && result.error !== undefined ? String(result.error) : t('actionFailed'));
            }
          });
        }

        function doLogout() {
          setBusy('logout');
          void act('logout').then(function () {
            setBusy('');
          });
        }

        function saveAk() {
          if (ak.trim() === '') return;
          setBusy('ak');
          void act('ak', { serviceAk: ak }).then(function (result) {
            setBusy('');
            if (result !== undefined && result.ok === true) setAk('');
          });
        }

        var hint = state === 'signed-in' ? t('signedInHint') : state === 'expired' ? t('expiredHint') : t('signedOutHint');

        var pending = login !== undefined && login.pending === true;
        var authorizeUrl = login === undefined || login.authorizeUrl === undefined ? undefined : String(login.authorizeUrl);
        var loginError = login === undefined || login.error === undefined ? undefined : String(login.error);

        return h(
          'div',
          { className: 'dsm-meoo-panel' },
          h(
            Section,
            {
              title: t('apiKeyTitle'),
              desc: t('apiKeyHint'),
            },
            h(
              'div',
              { className: 'dsm-meoo-actions', style: { borderTop: 0 } },
              h('input', {
                type: 'password',
                className: 'dsm-meoo-input',
                value: apiKeyInput,
                placeholder: t('apiKeyPlaceholder'),
                'aria-label': t('apiKeyLabel'),
                onChange: function (event) {
                  setApiKeyInput(event.target.value);
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-meoo-btn dsm-meoo-btn-primary',
                  disabled: busy !== '' || apiKeyInput.trim() === '',
                  onClick: saveApiKey,
                },
                busy === 'apikey' ? t('apiKeySaving') : t('apiKeySave'),
              ),
            ),
          ),
          h(
            Section,
            {
              title: t('account'),
              // 不摆「登录秒悟」主按钮：API Key 才是主路径，两个并列的入口会让人
              // 以为必须点登录。浏览器授权降级到「高级」里的次要链接（见下方 oauthRow）。
              actions: null,
            },
            h(
              Row,
              {
                name: h(
                  'span',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                  h(Dot, { tone: loginTone(state) }),
                  t('accountState'),
                ),
              },
              state === 'signed-in'
                ? null
                : h(Chip, { tone: loginTone(state) === 'warn' ? 'warn' : undefined }, loginLabel(t, state)),
            ),
            // 未登录时不摆「账号：未知 / 登录方式：无」——两行空话，用户什么也得不到。
            state === 'signed-out'
              ? null
              : h(Row, {
                  name: t('accountName'),
                  sub: login !== undefined && login.name !== undefined ? String(login.name) : t('unknown'),
                }),
            state === 'signed-out' ? null : h(Row, { name: t('accountSource'), sub: sourceLabel() }),
            pending
              ? h(
                  'div',
                  { className: 'dsm-meoo-banner dsm-meoo-banner-info' },
                  h(Dot, { tone: 'warn' }),
                  h(
                    'div',
                    { className: 'dsm-meoo-banner-body' },
                    h('div', { className: 'dsm-meoo-banner-title' }, t('loginPending')),
                    h('div', { className: 'dsm-meoo-banner-text' }, t('loginPendingHint')),
                    authorizeUrl === undefined
                      ? null
                      : h(
                          'a',
                          {
                            className: 'dsm-meoo-link',
                            href: authorizeUrl,
                            target: '_blank',
                            rel: 'noreferrer noopener',
                          },
                          t('loginOpenManual'),
                        ),
                    h('div', { className: 'dsm-meoo-banner-text' }, t('loginCodeHint')),
                    h(
                      'div',
                      { className: 'dsm-meoo-inline-form' },
                      h('input', {
                        type: 'text',
                        className: 'dsm-meoo-input',
                        value: loginCode,
                        placeholder: t('loginCodePlaceholder'),
                        'aria-label': t('loginCodeLabel'),
                        onChange: function (event) {
                          setLoginCode(event.target.value);
                        },
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                          disabled: busy !== '',
                          onClick: submitLoginCode,
                        },
                        busy === 'code' ? t('loginCodeSubmitting') : t('loginCodeSubmit'),
                      ),
                    ),
                    codeMsg === '' ? null : h('div', { className: 'dsm-meoo-banner-text' }, codeMsg),
                    h(
                      'div',
                      { className: 'dsm-meoo-inline-form' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                          disabled: busy !== '',
                          onClick: function () {
                            doLogin(true);
                          },
                        },
                        t('loginRetry'),
                      ),
                      h('span', { className: 'dsm-meoo-banner-text' }, t('loginRestartHint')),
                    ),
                  ),
                )
              : null,
            loginError === undefined
              ? null
              : h(
                  'div',
                  { className: 'dsm-meoo-banner dsm-meoo-banner-error' },
                  h(Dot, { tone: 'err' }),
                  h(
                    'div',
                    { className: 'dsm-meoo-banner-body' },
                    h('div', { className: 'dsm-meoo-banner-title' }, t('loginFailedTitle')),
                    h('div', { className: 'dsm-meoo-banner-text dsm-meoo-banner-mono' }, loginError),
                    h('div', { className: 'dsm-meoo-banner-text' }, t('loginErrorHint')),
                  ),
                ),
            h('p', { className: 'dsm-meoo-hint' }, hint),
            state === 'signed-in' || state === 'expired'
              ? h(
                  'div',
                  { className: 'dsm-meoo-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dsm-meoo-btn', disabled: busy !== '', onClick: doLogout },
                    t('logout'),
                  ),
                )
              : null,
          ),
          // 项目服务 AK 是内部细节：API Key 会自动换出它，用户不需要看见、更不需要手填。
          // 只有想手动指定某个项目的 AK 时才展开这一节。
          h(
            Section,
            { title: t('advancedTitle') },
            h(
              Row,
              { name: t('akTitle'), sub: t('akHint') },
              h(Switch, {
                checked: showAk === true,
                label: t('akTitle'),
                onChange: function (next) {
                  setShowAk(next === true);
                },
              }),
            ),
            showAk === true
              ? h(
                  'div',
                  { className: 'dsm-meoo-actions' },
                  h('input', {
                    type: 'password',
                    className: 'dsm-meoo-input',
                    value: ak,
                    placeholder: t('akPlaceholder'),
                    'aria-label': t('akLabel'),
                    onChange: function (event) {
                      setAk(event.target.value);
                    },
                  }),
                  h(
                    'button',
                    { type: 'button', className: 'dsm-meoo-btn', disabled: busy !== '' || ak.trim() === '', onClick: saveAk },
                    busy === 'ak' ? t('akSaving') : t('akSave'),
                  ),
                )
              : null,
            // 浏览器授权：没有 API Key 时的备选。默认折叠，避免和 API Key 抢主路径。
            h(
              Row,
              { name: t('oauthTitle'), sub: t('oauthHint') },
              // 已登录时这一行只是说明，不再给按钮（否则像是没登录成功）。
              state === 'signed-in'
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                      disabled: busy !== '',
                      onClick: function () {
                        doLogin(false);
                      },
                    },
                    busy === 'login' || pending ? t('loggingIn') : t('loginNow'),
                  ),
            ),
          ),
          h(ProjectPanel, { t: t, doc: doc }),
        );
      }

      /** 项目选择（多项目账号必用）。 */
      function ProjectPanel(props) {
        var t = props.t;
        var doc = props.doc;
        var projects = doc === undefined || doc.projects === undefined ? [] : doc.projects;
        var active = doc === undefined || doc.activeProject === undefined ? undefined : String(doc.activeProject);

        if (projects.length <= 1) {
          var single = projects.length === 1 ? projects[0] : undefined;
          return h(
            Section,
            { title: t('project'), desc: t('projectHint') },
            h(Row, {
              name: t('project'),
              sub: single === undefined ? t('projectNone') : String(single.name) + ' (' + String(single.urlId) + ')',
            }),
          );
        }
        return h(
          Section,
          { title: t('project'), desc: t('projectHint') },
          h(
            Row,
            { name: t('project'), sub: t('projectSwitch') },
            h(
              'select',
              {
                className: 'dsm-meoo-select',
                value: active === undefined ? '' : active,
                'aria-label': t('project'),
                onChange: function (event) {
                  void act('project', { projectUrlId: event.target.value });
                },
              },
              projects.map(function (project) {
                return h('option', { key: project.urlId, value: project.urlId }, project.name + ' (' + project.urlId + ')');
              }),
            ),
          ),
        );
      }

      /** 积分栏：余额 + 批次 + 到期。 */
      function PointsPanel(props) {
        var t = props.t;
        var doc = useSnapshot();
        var points = doc === undefined ? undefined : doc.points;
        var state = points === undefined ? 'unavailable' : points.state;
        var akOnly = doc !== undefined && doc.login !== undefined && doc.login.source === 'ak' && doc.login.hasServiceAk === true;
        var grants = state === 'ok' && points.grants !== undefined ? points.grants : [];
        var total = 0;
        grants.forEach(function (grant) {
          total += typeof grant.remaining === 'number' ? grant.remaining : 0;
        });

        var reason =
          state === 'expired' ? t('pointsExpired') : akOnly ? t('pointsAkOnly') : t('pointsUnavailable');

        return h(
          'div',
          { className: 'dsm-meoo-panel' },
          h(
            Section,
            {
              title: t('points'),
              actions:
                state === 'ok' && typeof points.updatedAtMs === 'number'
                  ? h(Chip, null, t('pointsUpdated', { time: clock(points.updatedAtMs) }))
                  : h(Chip, { tone: state === 'expired' ? 'warn' : undefined }, t('pointsAvailable')),
            },
            state === 'ok'
              ? h(
                  'div',
                  { className: 'dsm-meoo-stat' },
                  h('span', { className: 'dsm-meoo-stat-label' }, t('pointsAvailable')),
                  h(
                    'span',
                    { className: 'dsm-meoo-stat-value' },
                    num(points.available),
                    h('span', { className: 'dsm-meoo-stat-unit' }, t('pointsUnit')),
                  ),
                  h(
                    'span',
                    { className: 'dsm-meoo-stat-meta' },
                    h('span', null, t('pointsConsumed') + ' ', h('b', null, num(points.consumed))),
                    typeof points.frozen === 'number' && points.frozen > 0
                      ? h('span', null, t('pointsFrozen') + ' ', h('b', null, num(points.frozen)))
                      : null,
                    h(
                      'span',
                      null,
                      points.nextExpiry === undefined
                        ? t('pointsNoExpiry')
                        : t('pointsExpiry', { date: String(points.nextExpiry) }),
                    ),
                  ),
                )
              : h(
                  'div',
                  { className: 'dsm-meoo-empty' },
                  h('span', { className: 'dsm-meoo-empty-title' }, t('pointsUnavailable')),
                  h('span', null, reason),
                ),
          ),
          state === 'ok'
            ? h(
                Section,
                {
                  title: t('pointsGrants'),
                  desc: grants.length > 0 ? t('pointsGrantsHint') : undefined,
                  actions: grants.length > 0 ? h(Chip, null, t('pointsTotal') + ' ' + num(total)) : null,
                },
                grants.length === 0
                  ? h(Empty, { title: t('pointsNoGrants') })
                  : grants.map(function (grant, index) {
                      var amount = typeof grant.remaining === 'number' ? grant.remaining : 0;
                      var ratio = total > 0 ? Math.max(2, Math.round((amount / total) * 100)) : 0;
                      return h(
                        'div',
                        { className: 'dsm-meoo-grant', key: String(index) },
                        h(
                          'div',
                          { className: 'dsm-meoo-grant-head' },
                          h('span', { className: 'dsm-meoo-grant-amount' }, num(amount)),
                          h('span', { className: 'dsm-meoo-grant-expiry' }, t('pointsExpiry', { date: String(grant.expiresDate) })),
                        ),
                        h('div', { className: 'dsm-meoo-bar' }, h('i', { style: { width: String(ratio) + '%' } })),
                      );
                    }),
              )
            : null,
        );
      }

      /** 模型栏：搜索 + 筛选 + 勾选启用 + 单模型测试。 */
      function ModelsPanel(props) {
        var t = props.t;
        var doc = useSnapshot();
        var busyState = React.useState('');
        var busy = busyState[0];
        var setBusy = busyState[1];
        var resultState = React.useState({});
        var results = resultState[0];
        var setResults = resultState[1];
        var queryState = React.useState('');
        var query = queryState[0];
        var setQuery = queryState[1];
        var filterState = React.useState('all');
        var filter = filterState[0];
        var setFilter = filterState[1];

        var models = doc === undefined || doc.models === undefined ? [] : doc.models;
        var disabled = doc === undefined || doc.settings === undefined ? [] : doc.settings.disabledModels;
        var enabledCount = models.filter(function (model) {
          return model.enabled === true;
        }).length;

        var needle = query.trim().toLowerCase();
        var visible = models.filter(function (model) {
          if (filter === 'enabled' && model.enabled !== true) return false;
          if (filter === 'disabled' && model.enabled === true) return false;
          if (needle === '') return true;
          return (
            String(model.name).toLowerCase().indexOf(needle) >= 0 ||
            String(model.id).toLowerCase().indexOf(needle) >= 0
          );
        });

        function toggle(model) {
          var next = model.enabled
            ? disabled.concat([model.id])
            : disabled.filter(function (id) {
                return id !== model.id;
              });
          void act('settings', { disabledModels: next });
        }

        function setAll(enabled) {
          void act('settings', {
            disabledModels: enabled
              ? []
              : models.map(function (model) {
                  return model.id;
                }),
          });
        }

        function test(model) {
          setBusy(model.id);
          void act('test-model', { modelId: model.id }).then(function (result) {
            setBusy('');
            setResults(function (previous) {
              var next = Object.assign({}, previous);
              next[model.id] = result;
              return next;
            });
          });
        }

        var filters = [
          { value: 'all', label: t('filterAll') + ' ' + models.length },
          { value: 'enabled', label: t('modelEnabled') + ' ' + enabledCount },
          { value: 'disabled', label: t('modelDisabled') + ' ' + (models.length - enabledCount) },
        ];

        return h(
          'div',
          { className: 'dsm-meoo-panel' },
          h(
            Section,
            {
              title: t('models'),
              desc: models.length === 0 ? t('noModels') : t('modelsEnabledCount', { enabled: enabledCount, total: models.length }),
              actions:
                models.length === 0
                  ? null
                  : [
                      h(
                        'button',
                        {
                          key: 'enable-all',
                          type: 'button',
                          className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                          disabled: enabledCount === models.length,
                          onClick: function () {
                            setAll(true);
                          },
                        },
                        t('enableAll'),
                      ),
                      h(
                        'button',
                        {
                          key: 'disable-all',
                          type: 'button',
                          className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                          disabled: enabledCount === 0,
                          onClick: function () {
                            setAll(false);
                          },
                        },
                        t('disableAll'),
                      ),
                    ],
            },
            models.length === 0
              ? h(Empty, { title: t('noModels') }, t('modelsHint'))
              : [
                  h(
                    'div',
                    { className: 'dsm-meoo-actions', key: 'toolbar' },
                    h(
                      'label',
                      { className: 'dsm-meoo-search' },
                      h('svg', {
                        width: 13,
                        height: 13,
                        viewBox: '0 0 24 24',
                        fill: 'none',
                        stroke: 'currentColor',
                        'stroke-width': 2.2,
                        'stroke-linecap': 'round',
                        'aria-hidden': 'true',
                      }, h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'M20 20l-3.5-3.5' })),
                      h('input', {
                        type: 'search',
                        className: 'dsm-meoo-input',
                        value: query,
                        placeholder: t('searchModelsPlaceholder'),
                        'aria-label': t('searchModels'),
                        onChange: function (event) {
                          setQuery(event.target.value);
                        },
                      }),
                    ),
                    h(Segmented, {
                      label: t('models'),
                      value: filter,
                      options: filters,
                      onChange: function (next) {
                        setFilter(String(next));
                      },
                    }),
                  ),
                  visible.length === 0
                    ? h(Empty, { title: t('noMatch') }, query)
                    : visible.map(function (model) {
                        var outcome = results[model.id];
                        return h(
                          Row,
                          {
                            key: model.id,
                            name: [
                              h('span', { key: 'n' }, model.name),
                              h(PriceTag, { key: 'p', t: t, price: model.price }),
                              model.discount === undefined
                                ? null
                                : h(
                                    Chip,
                                    { key: 'd', tone: 'brand' },
                                    t('discountBadge', { discount: model.discount.label }),
                                  ),
                              model.vision === true ? h(Chip, { key: 'v' }, t('modelVision')) : null,
                              model.enabled === true ? null : h(Chip, { key: 'off' }, t('modelDisabled')),
                            ],
                            sub: [
                              model.description === undefined ? null : model.description,
                              contextLabel(model.contextWindow) +
                                ' · ' +
                                t('modelMaxOutput', { value: Math.round(model.maxTokens / 1000) }),
                              model.id,
                            ]
                              .filter(function (part) {
                                return part !== null;
                              })
                              .join(' · '),
                          },
                          outcome === undefined
                            ? null
                            : h(
                                'span',
                                { className: outcome.ok === true ? 'dsm-meoo-chip dsm-meoo-chip-ok' : 'dsm-meoo-chip dsm-meoo-chip-err' },
                                outcome.ok === true ? t('modelTestOk') : String(outcome.message || t('actionFailed')),
                              ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                              disabled: busy !== '',
                              title: t('modelsTestHint'),
                              onClick: function () {
                                test(model);
                              },
                            },
                            busy === model.id ? t('modelTesting') : t('modelTest'),
                          ),
                          h(Switch, {
                            checked: model.enabled === true,
                            label: model.name,
                            onChange: function () {
                              toggle(model);
                            },
                          }),
                        );
                      }),
                  h('p', { className: 'dsm-meoo-hint', key: 'hint' }, t('modelsHint') + ' ' + t('modelsTestHint')),
                ],
          ),
        );
      }

      /** 设置栏：刷新间隔 + 两个界面开关。 */
      function SettingsPanel(props) {
        var t = props.t;
        var doc = useSnapshot();
        var settings = doc === undefined || doc.settings === undefined ? {} : doc.settings;
        var interval = typeof settings.pollIntervalMs === 'number' ? settings.pollIntervalMs : 300000;

        var choices = [
          { value: 60000, label: t('poll1') },
          { value: 300000, label: t('poll5') },
          { value: 600000, label: t('poll10') },
          { value: 1800000, label: t('poll30') },
          { value: 3600000, label: t('poll60') },
        ];

        return h(
          'div',
          { className: 'dsm-meoo-panel' },
          h(
            Section,
            { title: t('settings'), desc: t('settingsHint') },
            h(
              Row,
              { name: t('pollInterval'), sub: t('pollHint') },
              h(Segmented, {
                label: t('pollInterval'),
                value: interval,
                options: choices,
                onChange: function (next) {
                  void act('settings', { pollIntervalMs: Number(next) });
                },
              }),
            ),
          ),
          h(
            Section,
            { title: t('sectionInterface') },
            h(
              Row,
              { name: t('composerPill') },
              h(Switch, {
                checked: settings.composerPill === true,
                label: t('composerPill'),
                onChange: function (next) {
                  void act('settings', { composerPill: next });
                },
              }),
            ),
            h(
              Row,
              { name: t('sidebarPanel') },
              h(Switch, {
                checked: settings.sidebarPanel === true,
                label: t('sidebarPanel'),
                onChange: function (next) {
                  void act('settings', { sidebarPanel: next });
                },
              }),
            ),
          ),
        );
      }

      /** 诊断栏：只读事实表，专门用来整段贴进问题反馈。 */
      function DiagnosticsPanel(props) {
        var t = props.t;
        var doc = useSnapshot();
        var copiedState = React.useState('');
        var copied = copiedState[0];
        var setCopied = copiedState[1];

        var facts = [];
        if (doc !== undefined) {
          facts.push([t('diagVersion'), String(doc.version)]);
          facts.push([t('diagGateway'), String(doc.gateway)]);
          facts.push([t('diagLogin'), doc.login === undefined ? '?' : String(doc.login.state)]);
          facts.push([t('diagSource'), doc.login === undefined ? '?' : String(doc.login.source)]);
          facts.push([t('diagProject'), doc.activeProject === undefined ? '-' : String(doc.activeProject)]);
          facts.push([t('diagModels'), String(doc.models === undefined ? 0 : doc.models.length)]);
          facts.push([
            t('diagEnabled'),
            String(
              doc.models === undefined
                ? 0
                : doc.models.filter(function (model) {
                    return model.enabled === true;
                  }).length,
            ),
          ]);
          facts.push([t('diagReadAt'), clock(doc.readAtMs)]);
        }
        var errorText = doc === undefined || doc.lastError === undefined ? undefined : String(doc.lastError);

        function copy() {
          var lines = facts.map(function (pair) {
            return pair[0] + ': ' + pair[1];
          });
          if (errorText !== undefined) lines.push(t('diagError') + ': ' + errorText);
          try {
            void navigator.clipboard.writeText(lines.join('\n')).then(function () {
              setCopied('ok');
              setTimeout(function () {
                setCopied('');
              }, 1500);
            });
          } catch (error) {
            setCopied('fail');
            console.error('[dsh-connect-meoo] 复制失败:', error);
          }
        }

        return h(
          'div',
          { className: 'dsm-meoo-panel' },
          h(
            Section,
            {
              title: t('diagnostic'),
              // 刷新按钮只在页头放一个：两个「刷新」并排会让人以为作用不同。
              actions: h(
                'button',
                { type: 'button', className: 'dsm-meoo-btn dsm-meoo-btn-sm', disabled: doc === undefined, onClick: copy },
                copied === 'ok' ? t('copied') : copied === 'fail' ? t('copyFailed') : t('copyDiagnostics'),
              ),
            },
            doc === undefined
              ? h(Empty, { title: t('notAvailable') })
              : h(
                  'dl',
                  { className: 'dsm-meoo-kv' },
                  facts.reduce(function (acc, pair) {
                    acc.push(h('dt', { key: 'k-' + pair[0] }, pair[0]));
                    acc.push(h('dd', { key: 'v-' + pair[0] }, pair[1]));
                    return acc;
                  }, []),
                ),
            errorText === undefined
              ? null
              : h('div', { className: 'dsm-meoo-error' }, h(Dot, { tone: 'err' }), h('span', null, errorText)),
          ),
          h(
            Section,
            { title: t('sectionLastAction') },
            lastAction === undefined
              ? h(Empty, { title: t('lastActionEmpty') })
              : h('pre', { className: 'dsm-meoo-pre', style: { borderTop: 0 } }, JSON.stringify(lastAction, null, 2)),
          ),
        );
      }

      // ---------------------------------------------------------------------
      // 主页面：五个分栏 + 页头
      // ---------------------------------------------------------------------

      function PluginPage(props) {
        var t = props.t;
        var doc = useSnapshot();
        var tabState = React.useState('account');
        var tab = tabState[0];
        var setTab = tabState[1];

        var tabs = [
          { id: 'account', label: t('tabAccount') },
          { id: 'models', label: t('tabModels') },
          { id: 'points', label: t('tabPoints') },
          { id: 'settings', label: t('tabSettings') },
          { id: 'diag', label: t('tabDiag') },
        ];

        var login = doc === undefined ? undefined : doc.login;
        var loginState = login === undefined ? 'signed-out' : login.state;

        return h(
          'div',
          { className: 'dsm-meoo-page', 'data-surface': props.surface === undefined ? 'detail' : String(props.surface) },
          h(
            'div',
            { className: 'dsm-meoo-hero' },
            h('span', { className: 'dsm-meoo-logo' }, h(MeooIcon, { size: 20 })),
            h(
              'div',
              { className: 'dsm-meoo-hero-main' },
              h(
                'div',
                { className: 'dsm-meoo-title-row' },
                h('h1', { className: 'dsm-meoo-title' }, t('metaTitle')),
                h(Chip, { tone: loginTone(loginState) === 'ok' ? 'ok' : loginTone(loginState) === 'warn' ? 'warn' : undefined },
                  loginLabel(t, loginState)),
                doc === undefined ? null : h(Chip, null, 'v' + String(doc.version)),
              ),
              h('p', { className: 'dsm-meoo-desc' }, t('metaDescription')),
            ),
            h(
              'div',
              { className: 'dsm-meoo-head-actions' },
              doc === undefined || typeof doc.readAtMs !== 'number'
                ? null
                : h(Chip, null, t('pointsUpdated', { time: clock(doc.readAtMs) })),
              h(RefreshButton, { t: t }),
              typeof props.backToConversation === 'function'
                ? h(
                    'button',
                    { type: 'button', className: 'dsm-meoo-btn', onClick: props.backToConversation },
                    t('backToChat'),
                  )
                : null,
            ),
          ),
          h(
            'div',
            { className: 'dsm-meoo-tabs', role: 'tablist' },
            tabs.map(function (entry) {
              return h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === entry.id ? 'true' : 'false',
                  className: 'dsm-meoo-tab',
                  onClick: function () {
                    setTab(entry.id);
                  },
                },
                entry.label,
              );
            }),
          ),
          // 非活动栏留在页面里、用 hidden 隐藏：切栏不会重新拉取，也不会丢草稿。
          h('div', { className: 'dsm-meoo-panel', hidden: tab !== 'account', role: 'tabpanel' }, h(AccountPanel, { t: t })),
          h('div', { className: 'dsm-meoo-panel', hidden: tab !== 'models', role: 'tabpanel' }, h(ModelsPanel, { t: t })),
          h('div', { className: 'dsm-meoo-panel', hidden: tab !== 'points', role: 'tabpanel' }, h(PointsPanel, { t: t })),
          h('div', { className: 'dsm-meoo-panel', hidden: tab !== 'settings', role: 'tabpanel' }, h(SettingsPanel, { t: t })),
          h('div', { className: 'dsm-meoo-panel', hidden: tab !== 'diag', role: 'tabpanel' }, h(DiagnosticsPanel, { t: t })),
        );
      }

      /** 页头刷新按钮：自己维护「正在刷新」状态，避免整页重渲染时闪烁。 */
      function RefreshButton(props) {
        var t = props.t;
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        return h(
          'button',
          {
            type: 'button',
            className: 'dsm-meoo-btn dsm-meoo-btn-sm',
            disabled: busy,
            onClick: function () {
              setBusy(true);
              void load(true).then(function () {
                setBusy(false);
              });
            },
          },
          busy ? t('refreshing') : t('refresh'),
        );
      }

      /** 侧栏导航行的图标。 */
      function PanelIcon(props) {
        return h(MeooIcon, { size: typeof props.size === 'number' ? props.size : 16, active: props.active });
      }

      // ---------------------------------------------------------------------
      // 输入框积分胶囊
      // ---------------------------------------------------------------------

      function CreditPill(props) {
        var t = props.t;
        var doc = useSnapshot();
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];

        var points = doc === undefined ? undefined : doc.points;
        var available =
          points === undefined || points.state !== 'ok' || typeof points.available !== 'number'
            ? undefined
            : points.available;
        var label = available === undefined ? t('pillUnknown') : t('pillPoints', { points: num(available) });
        var grants = points !== undefined && points.state === 'ok' && points.grants !== undefined ? points.grants : [];

        return h(
          'div',
          { className: 'dsm-meoo-pill', 'data-meoo-pill': true },
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-meoo-pill-btn',
              title: t('pillPopTitle'),
              'aria-expanded': open === true ? 'true' : 'false',
              onClick: function () {
                setOpen(!open);
              },
            },
            h(Dot, { tone: available === undefined ? 'idle' : 'ok' }),
            available === undefined ? label : h('span', null, t('pill') + ' · ', h('span', { className: 'dsm-meoo-pill-num' }, num(available))),
          ),
          open
            ? h(
                'div',
                { className: 'dsm-meoo-pop', role: 'dialog', 'aria-label': t('pillPopTitle') },
                h(
                  'div',
                  { className: 'dsm-meoo-pop-head' },
                  h('span', { className: 'dsm-meoo-pop-title' }, t('pillPopTitle')),
                  h(Chip, { tone: available === undefined ? 'warn' : 'ok' }, available === undefined ? t('pointsUnavailable') : t('accountSignedIn')),
                ),
                h(
                  'div',
                  { className: 'dsm-meoo-pop-body' },
                  h(
                    'div',
                    { className: 'dsm-meoo-pop-row' },
                    h('span', null, t('pointsAvailable')),
                    h('span', null, num(available)),
                  ),
                  points !== undefined && points.state === 'ok'
                    ? h(
                        'div',
                        { className: 'dsm-meoo-pop-row' },
                        h('span', null, t('pointsConsumed')),
                        h('span', null, num(points.consumed)),
                      )
                    : null,
                  points !== undefined && points.state === 'ok' && typeof points.frozen === 'number' && points.frozen > 0
                    ? h(
                        'div',
                        { className: 'dsm-meoo-pop-row' },
                        h('span', null, t('pointsFrozen')),
                        h('span', null, num(points.frozen)),
                      )
                    : null,
                  points !== undefined && points.nextExpiry !== undefined
                    ? h(
                        'div',
                        { className: 'dsm-meoo-pop-row' },
                        h('span', null, t('pointsGrants')),
                        h('span', null, t('pointsExpiry', { date: String(points.nextExpiry) })),
                      )
                    : null,
                  points !== undefined && typeof points.updatedAtMs === 'number'
                    ? h('div', { className: 'dsm-meoo-pop-foot-note' }, t('pointsUpdated', { time: clock(points.updatedAtMs) }))
                    : null,
                ),
                typeof props.openPanel === 'function'
                  ? h(
                      'div',
                      { className: 'dsm-meoo-pop-foot' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsm-meoo-btn dsm-meoo-btn-sm',
                          onClick: function () {
                            props.openPanel();
                            setOpen(false);
                          },
                        },
                        t('openPanel'),
                      ),
                    )
                  : null,
              )
            : null,
        );
      }

      /**
       * 胶囊的门控：只在**本插件的 provider** 被选中时显示。
       *
       * 余额属于「下一次请求真的会用的那个 provider」；选了别人的模型还显示
       * 秒悟的积分，是一句看起来像事实的错误陈述。宿主没给投影时照常显示 ——
       * 「我不知道」不该等于「藏起来」。
       */
      function CreditPillGate(props) {
        var projection =
          typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined;
        var next =
          projection === undefined || projection === null
            ? undefined
            : projection.next === undefined || projection.next === null
              ? projection.lastUsed
              : projection.next;
        var provider = next === undefined ? undefined : next.provider;
        if (provider !== undefined && provider !== PROVIDER_ID) return null;
        return h(CreditPill, props);
      }

      // ---------------------------------------------------------------------
      // 插件模块
      // ---------------------------------------------------------------------

      /** 插件模块。`inject` 声明依赖的服务，`apply` 在服务就绪时注册槽位。 */
      function apply(ctx) {
        var namespace = 'dsh-connect-meoo';
        if (typeof document !== 'undefined') {
          var cssId = 'dsh-connect-meoo/client.css';
          var existing = document.querySelector('style[data-plugin-css="' + cssId + '"]');
          if (existing !== null) existing.textContent = MEOO_CSS;
          else {
            var styleTag = document.createElement('style');
            styleTag.dataset.pluginCss = cssId;
            styleTag.textContent = MEOO_CSS;
            document.head.appendChild(styleTag);
          }
        }

        function getLayout() {
          try {
            var layout = ctx.get('layout');
            return layout && typeof layout.selectPanel === 'function' ? layout : undefined;
          } catch (error) {
            return undefined;
          }
        }

        /** 侧栏整页（`main`）的 props。 */
        function panelPageProps() {
          return {
            t: t,
            surface: 'page',
            backToConversation:
              getLayout() === undefined
                ? undefined
                : function () {
                    var layout = getLayout();
                    if (layout !== undefined) layout.selectPanel(null);
                  },
          };
        }

        ctx.effect(function () {
          return ctx.locale.register(namespace, { zh: zh, en: en });
        }, 'dsh-connect-meoo: locale');
        var t = ctx.locale.bind(namespace);

        /**
         * 注册一个槽位，失败只记日志。
         *
         * 为什么要内层 try/catch：`ctx.slots.inject(name, cb)` 的回调是**晚执行**的
         * （等宿主声明那个槽位），异常会被 `queueMicrotask` 重新抛到渲染器外，
         * 外层的 try 抓不到 —— 结果是整个插件详情页空白，而控制台里只有一条
         * 和本插件无关的堆栈。所以每个注入回调自己兜住。
         */
        function injectSlot(name, register) {
          try {
            return ctx.slots.inject(name, function () {
              try {
                return register();
              } catch (error) {
                console.error('[dsh-connect-meoo] 槽位注册失败（' + name + '，不影响模型路由）：', error);
                return undefined;
              }
            });
          } catch (error) {
            console.error('[dsh-connect-meoo] 槽位注入失败（' + name + '，不影响模型路由）：', error);
            return undefined;
          }
        }

        // 主页面常注册：关闭导航行后，胶囊仍能打开页面，当前页也不会因开关被销毁。
        injectSlot('main', function () {
          return ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: namespace, inject: panelPageProps },
            PluginPage,
          );
        });

        var panelDisposers = [];
        /** 上一次同步时开关的值：只在「开关真的变了」时注销并重新注册侧栏行。 */
        var panelRowWanted = undefined;

        function disposePanelRow() {
          panelDisposers.forEach(function (dispose) {
            try {
              dispose();
            } catch (error) {
              console.error('[dsh-connect-meoo] sidebar row disposal failed:', error);
            }
          });
          panelDisposers = [];
        }

        function syncPanelRow() {
          if (snapshot === undefined) return;
          var wanted = snapshot.settings !== undefined && snapshot.settings.sidebarPanel === true;
          if (wanted === panelRowWanted) return;
          panelRowWanted = wanted;
          disposePanelRow();
          if (!wanted) return;
          var dispose = injectSlot('sidebar.panellist', function () {
            return ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 60,
                label: function () {
                  return t('name');
                },
                locale: namespace,
              },
              PanelIcon,
            );
          });
          if (typeof dispose === 'function') panelDisposers.push(dispose);
        }

        ctx.effect(function () {
          void load(false);
          var unsubscribe = subscribe(syncPanelRow);
          syncPanelRow();
          return function () {
            unsubscribe();
            disposePanelRow();
            panelRowWanted = undefined;
          };
        }, 'dsh-connect-meoo: sidebar panel');

        // 插件详情页：`key` 必须是包名（宿主按它把页面挂到 bundle 详情上）。
        injectSlot('plugins.bundle.config', function () {
          return ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE_NAME,
              locale: namespace,
              inject: function () {
                return { t: t, surface: 'detail' };
              },
            },
            PluginPage,
          );
        });

        // 输入框左侧的读数：坐在模型选择器旁边，与「这个 provider 在用」同一个位置。
        injectSlot('conversation.input.left', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: BUNDLE_NAME + '-points',
              order: 4,
              locale: namespace,
              inject: function () {
                return {
                  t: t,
                  openPanel:
                    getLayout() === undefined
                      ? undefined
                      : function () {
                          var layout = getLayout();
                          if (layout !== undefined) layout.selectPanel(PANEL_ID);
                        },
                };
              },
            },
            CreditPillGate,
          );
        });

        /**
         * 设置页侧栏入口（左侧导航 + 右侧整页）。
         *
         * `id` 同时驱动两件事：侧栏过滤（`only: active`）与图标匹配
         * （`settings.section.icon` 的 id 必须等于 section 的 id，不匹配就不渲染）。
         */
        var SETTINGS_SECTION_ID = 'dsh-connect-meoo';
        injectSlot('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: SETTINGS_SECTION_ID,
              order: 60,
              label: function () {
                return t('name');
              },
              locale: namespace,
              inject: function () {
                return { t: t, surface: 'settings' };
              },
            },
            function (props) {
              void props.close;
              return h(PluginPage, props);
            },
          );
        });

        injectSlot('settings.section.icon', function () {
          return ctx.slots.register(
            { name: 'settings.section.icon', id: SETTINGS_SECTION_ID, locale: namespace },
            PanelIcon,
          );
        });
      }

      return {
        name: BUNDLE_NAME,
        inject: ['slots', 'locale'],
        apply: apply,
      };
    },
  });
})();
