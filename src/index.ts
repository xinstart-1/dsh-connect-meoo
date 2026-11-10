/**
 * Cordis 插件入口：装配凭证、运行时、LLM 注册与宿主路由。
 *
 * 装配顺序很重要：**adapter 注册不能等网络** —— 目录先用静态兜底注册上，
 * 登录态可用时再刷新。否则「刚装好还没登录」的用户会看到选择器里一个模型都没有，
 * 而那个空选择器不会自己变好（除非重启）。
 *
 * 这里的职责只有**接线**：谁先谁后、谁在卸载时释放什么。真正的行为在
 * `host/runtime.ts`（状态与动作）、`protocol/`（上游契约）、
 * `credentials/store.ts`（登录态）里，各自可单测。
 *
 * @module dsh-connect-meoo
 */

import { spawn } from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import { Config, type MeooConfig } from './config.ts';
import { PROVIDER, SETTINGS_NS, VERSION } from './constants.ts';
import { readState, writeState, type MeooPluginState } from './state.ts';
import { MeooRuntime } from './host/runtime.ts';
import { registerRoutes } from './host/routes.ts';
import { registerMeooCommand, type CommandsLike } from './host/commands.ts';
import { createMeooAdapter, toLlmModelInfos, type MeooAdapter } from './llm/adapter.ts';
import { FALLBACK_CATALOG, type MeooModel } from './protocol/catalog.ts';

/** 插件名（Cordis 用它做诊断前缀）。 */
export const name = 'dsh-connect-meoo';

/** 依赖的服务：没有 llm 就没有模型路由可注册。 */
export const inject = ['llm'];

/**
 * 用系统默认浏览器打开一个 URL。
 *
 * Windows 上**不能**走 `cmd /c start`：cmd 会把 URL 里的 `&` 当成命令分隔符，
 * 浏览器只拿到 `?client_id=…` 那一段（缺 `response_type`），授权页报
 * `unsupported_response_type`。
 *
 * 用**两条**路径，因为单靠一条会静默失败：本机实测 `explorer.exe` 常常以
 * 退出码 1 结束（虽然有时浏览器仍然弹出来），而 `rundll32 url.dll,FileProtocolHandler`
 * 稳定返回 0。两者都试一次，任一成功即算打开；都失败也只是返回 false ——
 * 授权 URL 会随动作响应回到页面，用户永远有一条手动打开的路。
 *
 * @param url - 要打开的地址。
 * @returns 是否至少有一条启动路径被系统接受。
 */
function openBrowser(url: string): boolean {
  if (process.platform !== 'win32') {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  // 顺序有讲究：rundll32 先试 —— 它不经过 shell，也不受 explorer 的关联设置影响。
  const launchers: Array<[string, string[]]> = [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['explorer.exe', [url]],
  ];
  let opened = false;
  for (const [file, args] of launchers) {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
      opened = true;
    } catch {
      // 换下一条路径。
    }
  }
  return opened;
}

/**
 * 插件应用函数。
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 用户在设置页填的配置。
 */
export async function apply(ctx: Context, rawConfig: MeooConfig): Promise<void> {
  const config = { ...Config({}), ...rawConfig } as MeooConfig;
  const warn = (message: string): void => {
    ctx.logger.warn(`[${name}] ${message}`);
  };

  /** 当前目录：先静态兜底，登录态可用后换成网关目录。 */
  let catalog: MeooModel[] = [...FALLBACK_CATALOG];
  let meoo: MeooAdapter | undefined;
  let disposed = false;

  /** 插件状态（界面开关）。读一次缓存在内存里，写入时同步更新。 */
  let pluginState: MeooPluginState = await readState();

  /**
   * 目录条目是否对用户可见。
   *
   * **过滤在目录出口处做**，而不是渲染时做：模型选择器读的是
   * `registerModelDiscovery` 的返回值，只要它不返回这个模型，界面上就不可能出现。
   */
  const visibleCatalog = (models: readonly MeooModel[]): MeooModel[] =>
    models.filter((model) => !pluginState.disabledModels.includes(model.id));

  /** 写入状态并让运行时跟着走（刷新间隔可能变了）。 */
  const saveState = async (patch: Partial<MeooPluginState>): Promise<MeooPluginState> => {
    pluginState = await writeState(patch);
    runtime.rememberStateSync(pluginState);
    meoo?.invalidate();
    return pluginState;
  };

  // 1. 运行时（先建，后面路由与 adapter 都指向它）。
  const runtime = new MeooRuntime({
    state: async () => pluginState,
    saveState,
    warn,
    manualServiceAk: () => config.serviceAk,
    explicitProject: () => config.projectUrlId,
    gatewayBaseUrl: () => config.gatewayBaseUrl,
    reuseLocalLogin: () => config.reuseLocalLogin,
    openBrowser,
  });
  runtime.rememberStateSync(pluginState);

  /** 从运行时缓存里同步一次目录（登录态可用时目录已经是网关那份）。 */
  const syncCatalog = (): void => {
    const current = runtime.catalog();
    catalog = current.length > 0 ? [...current] : [...FALLBACK_CATALOG];
    meoo?.invalidate();
  };

  // 2. 装配 adapter 并注册。目录是静态兜底也能注册 —— 见文件头注释。
  meoo = createMeooAdapter({
    // adapter 的模型列表也要过一遍禁用名单，否则选择器里会出现用户关掉的模型。
    catalog: () => visibleCatalog(catalog),
    baseUrl: () => runtime.gateway(),
    apiKey: () => runtime.serviceAk(),
  });

  const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], meoo.adapter);
  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Meoo 秒悟',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
      declared: false,
    },
  ]);
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request) => {
    if (request.provider !== undefined && request.provider !== PROVIDER) return [];
    if (!config.enabled) return [];
    // 发现接口要快：这里只读缓存目录，网络刷新由运行时自己的轮询负责。
    // 读不到真实目录时给静态兜底 —— 空列表会让选择器整组消失。
    return toLlmModelInfos(visibleCatalog(catalog));
  });

  // 3. 卡片/胶囊用的两条宿主路由（AK 与 token 不进页面，页面只拿归一好的展示数据）。
  registerRoutes(ctx as unknown as Parameters<typeof registerRoutes>[0], {
    status: () => runtime.status(false),
    action: (action, body) => runtime.run(action, body),
  });

  // 4. `/meoo` 斜杠命令。`commands` 是**软取**的：没有这个服务就退化成「没有命令」，
  //    不能让插件因此挂载失败 —— 命令是附加入口，不是承重结构。
  const releaseCommand = registerMeooCommand(
    (ctx as unknown as { get?: (name: string) => unknown }).get?.('commands') as
      | CommandsLike
      | undefined,
    runtime,
    warn,
  );

  // 5. 生命周期：卸载时释放注册与定时器。
  ctx.effect(() => async () => {
    disposed = true;
    runtime.dispose();
    releaseCommand();
    releaseDirectory();
    releaseAdapter();
    meoo = undefined;
  });

  // 6. 启动后预热：登录态可用时把目录换成真实那份，并让界面有数据可看。
  //    用 setTimeout 把网络请求推到 apply 之外：apply 期间宿主还在装配插件树。
  const warm = (): void => {
    if (disposed) return;
    void runtime
      .status(true)
      .then(() => {
        if (disposed) return;
        syncCatalog();
      })
      .catch((error: unknown) => {
        warn(`预热失败（不影响模型路由）：${error instanceof Error ? error.message : String(error)}`);
      });
  };
  if (config.warmOnStart) {
    const timer = setTimeout(warm, 0);
    timer.unref?.();
  }

  // 7. 配置变化：重新解析登录态与目录。
  const offUpdate = (
    ctx as unknown as {
      on(event: string, listener: () => void): (() => void) | void;
    }
  ).on('loader/volatile-update', () => {
    if (disposed) return;
    runtime.invalidate();
    warm();
  });
  if (typeof offUpdate === 'function') ctx.effect(() => offUpdate);

  ctx.logger.info(
    `[${name}] v${VERSION} 已启动：${String(visibleCatalog(catalog).length)} 个模型（网关 ${runtime.gateway()}）`,
  );
}
