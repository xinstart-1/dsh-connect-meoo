/**
 * 宿主运行时：把「上游协议」「插件状态」「状态文档」三者缝在一起。
 *
 * 为什么要单独一层：`index.ts` 是装配清单（注册什么、什么时候释放），
 * 而这里的职责是**一个会话级的事实源** —— 登录态、积分、目录各自多久刷新、
 * 刷新失败时保留什么、动作（登录 / 同步 / 改设置）执行后谁先失效。
 * 把它独立出来才能用假 client 单测整条链路，而不必起 Cordis。
 *
 * 两条硬规则：
 * 1. **网络失败不得清空上一次的好数据**。卡片上宁可是三分钟前的读数，
 *    也不要因为一次 502 变成「未登录」。所以每段缓存都带 `at` 时间戳，
 *    失败时只记录 `lastError` 并保留旧值。
 * 2. **不做乐观更新**。写操作（登录、换项目、手填 AK）之后重拉上游，
 *    用真实读数作答。
 *
 * @module dsh-connect-meoo/host/runtime
 */

import { AUTH_FILENAME, AUTH_DIRNAME, GATEWAY_BASE, VERSION } from '../constants.ts';
import {
  EMPTY_AUTH,
  activateToken,
  authFile,
  clearAuth,
  isApiKey,
  isServiceAk,
  listTokens,
  readAuth,
  readLocalLogin,
  removeToken,
  startLogin,
  upsertToken,
  writeAuth,
  type LoginSession,
  type StoredAuth,
} from '../credentials/store.ts';
import {
  MeooError,
  fetchAgentModels,
  fetchGatewayModels,
  fetchIdentity,
  fetchPoints,
  listProjects,
  pickProject,
  resolveServiceAk,
  verifyServiceAk,
  type MeooProject,
  type PointsSummary,
} from '../protocol/client.ts';
import type { MeooModel } from '../protocol/catalog.ts';
import { FALLBACK_CATALOG } from '../protocol/catalog.ts';
import { POLL_INTERVAL_CHOICES, type MeooPluginState } from '../state.ts';
import { buildStatusDocument, type StatusDocument, type StatusAccount, type StatusCheckin, type StatusModel, type StatusPoints } from './status.ts';
import type { MeooAction } from './routes.ts';
import {
  EMPTY_CHECKIN,
  isCheckinDue,
  nextCheckinAt,
  readCheckinState,
  runCheckin,
  shanghaiDate,
  writeCheckinState,
  type CheckinState,
} from './checkin.ts';

/** 一段带时间戳的缓存。 */
interface Segment<T> {
  value: T;
  at: number;
}

/** 运行时的外部依赖。全部以函数形式注入，是为了让每处都读最新配置。 */
export interface RuntimeOptions {
  /** 当前插件状态（UI 开关）。 */
  state: () => Promise<MeooPluginState>;
  /** 合并写入插件状态并返回新值。 */
  saveState: (patch: Partial<MeooPluginState>) => Promise<MeooPluginState>;
  /** 诊断日志。 */
  warn: (message: string) => void;
  /** 手填的项目服务 AK（配置项）；非空即优先于登录态里的 AK。 */
  manualServiceAk: () => string;
  /** 显式指定的项目（配置项）。 */
  explicitProject: () => string;
  /** 网关地址（配置项）。 */
  gatewayBaseUrl: () => string;
  /** 主站地址（官网目录接口用）；省略时用登录态里的 apiBaseUrl。 */
  apiBaseUrl?: () => string;
  /** 是否允许复用本机登录态。 */
  reuseLocalLogin: () => boolean;
  /** 打开浏览器（测试可替换）。 */
  openBrowser?: (url: string) => void;
  /** 时钟（测试可替换）。 */
  now?: () => number;
}

/** 上游失败时的统一措辞：原文照留，便于用户整段贴进问题反馈。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 登录态是否「有 access/refresh 但已过期」。 */
function looksExpired(auth: StoredAuth): boolean {
  const expiresAt = typeof auth.accessExpiresAt === 'number' ? auth.accessExpiresAt : 0;
  const hasToken =
    (typeof auth.accessToken === 'string' && auth.accessToken !== '') ||
    (typeof auth.refreshToken === 'string' && auth.refreshToken !== '');
  return hasToken && expiresAt > 0 && expiresAt <= Date.now() && (auth.refreshToken ?? '') === '';
}

/**
 * 秒悟运行时。
 *
 * 生命周期：`index.ts` 在装配时构造一个，卸载时调用 {@link dispose}。
 * 定时器只在**至少有一个界面在读**的时候转（`retain` / `release`），
 * 因为每次轮询都是一次真实的上游请求，没有界面时没有理由花它。
 */
export class MeooRuntime {
  private readonly options: RuntimeOptions;
  private readonly now: () => number;
  private auth: StoredAuth | undefined;
  /** 登录态来源（`oauth` / `local` / `ak` / `none`），用于卡片显示。 */
  private source: 'oauth' | 'local' | 'apikey' | 'ak' | 'none' = 'none';
  private points?: Segment<PointsSummary>;
  private models?: Segment<MeooModel[]>;
  private projects?: Segment<MeooProject[]>;
  private activeProject?: Segment<string>;
  private lastError?: string;
  /** 在途登录（避免连点两次拉起两个浏览器窗口）。 */
  private login?: LoginSession;
  private loggingIn = false;
  /**
   * 在途登录的授权页地址与失败原因。
   *
   * 为什么要存起来：用户点了「登录」之后，浏览器可能没弹（本机 `explorer.exe`
   * 实测会以退出码 1 结束）、也可能授权完换票失败。这两种情况以前只写进
   * console，界面上什么都不会变 —— 用户看到的就是「点了没反应」。
   */
  private loginUrl?: string;
  private loginError?: string;
  /**
   * 登录会话代次。
   *
   * 为什么需要：`restart` 会丢掉旧会话再起一个新的，而**旧会话的 promise 链
   * 还没结束** —— 它的 `.finally` 一旦跑起来，会把新会话的 `loggingIn` / `login`
   * 一起清掉，于是新端口没人关（测试里表现为进程挂死）、界面也以为登录结束了。
   * 每个回调都先比对代次，只处理自己那一代。
   */
  private loginGeneration = 0;
  /** 在途刷新（避免与轮询并发跑同一批请求）。 */
  private refreshing?: Promise<StatusDocument>;
  private timer?: NodeJS.Timeout;
  private readers = 0;
  private disposed = false;
  /** 每日签到状态（首次读盘后常驻内存）。 */
  private checkin?: CheckinState;
  private checkinTimer?: NodeJS.Timeout;
  /** 在途签到（手动与定时不并发跑两遍）。 */
  private checkinRunning?: Promise<CheckinState>;
  /** 自动签到失败后的重试时刻；没有它，失败会在 due 判断下变成死循环。 */
  private checkinRetryAt = 0;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * 声明有界面在读：第一个读者到达时开始轮询。
   * @returns 释放函数。
   */
  retain(): () => void {
    this.readers += 1;
    if (this.readers === 1) this.schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers = Math.max(0, this.readers - 1);
      if (this.readers === 0) this.unschedule();
    };
  }

  /** 停止轮询与在途登录。 */
  dispose(): void {
    this.disposed = true;
    this.unschedule();
    this.unscheduleCheckin();
    this.login?.cancel();
    this.login = undefined;
    this.loggingIn = false;
    this.loginUrl = undefined;
    this.loginError = undefined;
  }

  /** 目录/登录态变化后调用：下一次请求会重拉。 */
  invalidate(): void {
    this.models = undefined;
    this.projects = undefined;
    this.points = undefined;
  }

  /**
   * 拉目录：**官网那份优先**，网关那份兜底。
   *
   * 为什么要两份：网关 `/models` 只回裸 id，模型选择器里除了名字什么都没有；
   * 官网 `/api/v1/agent/models` 才带价格档位、说明、夜间折扣、多模态。
   * 但官网接口是「展示层」的东西 —— 它挂了不该让模型不可用，所以失败就退回网关。
   *
   * 两份都失败时抛错（调用方记 lastError，保留上一份好目录）。
   *
   * @param serviceAk - 项目服务 AK。
   * @returns 目录（可能为空）。
   */
  private async fetchCatalog(serviceAk: string): Promise<MeooModel[]> {
    const rich = await fetchAgentModels(serviceAk, this.options.apiBaseUrl?.() ?? this.currentAuth().apiBaseUrl);
    if (rich.length > 0) return rich;
    return fetchGatewayModels(serviceAk, this.gateway());
  }

  /** 当前目录（同步读；没拉过就用静态兜底）。 */
  catalog(): readonly MeooModel[] {
    return this.models?.value ?? FALLBACK_CATALOG;
  }

  /** 当前登录态（同步读；没读过就是空的）。 */
  currentAuth(): StoredAuth {
    return this.auth ?? { ...EMPTY_AUTH };
  }

  /** 当前生效的网关地址。 */
  gateway(): string {
    const configured = this.options.gatewayBaseUrl();
    if (configured !== '') return configured.replace(/\/+$/, '');
    return (this.auth?.gatewayBaseUrl ?? GATEWAY_BASE).replace(/\/+$/, '');
  }

  /**
   * 解析「真正能发请求的那个 AK」。
   *
   * 顺序：手填 AK > 登录态里缓存的 AK（且项目对得上）> 现场解析（可能自动开通云服务）。
   * 手填排第一是因为用户显式填了就该听他的。
   *
   * @param force - 忽略缓存，强制重新解析。
   * @returns 项目服务 AK。
   */
  async serviceAk(force = false): Promise<string> {
    const manual = this.options.manualServiceAk().trim();
    if (manual !== '') return manual;

    const auth = await this.loadAuth();
    if (auth.serviceAk !== null && auth.serviceAk !== undefined && auth.serviceAk !== '' && !force) {
      return auth.serviceAk;
    }
    const projectUrlId = await this.ensureProject(auth);
    const ak = await resolveServiceAk(auth, projectUrlId);
    auth.projectUrlId = projectUrlId;
    auth.serviceAk = ak;
    auth.serviceAkProjectId = projectUrlId;
    await this.persistAuth();
    return ak;
  }

  /**
   * 读登录态（首次从磁盘加载，并尝试复用本机登录态）。
   * @returns 登录态。
   */
  async loadAuth(): Promise<StoredAuth> {
    if (this.auth !== undefined) return this.auth;

    const own = await readAuth();
    const hasApiKey = (own.apiKey ?? '') !== '';
    const hasOwnToken = (own.refreshToken ?? '') !== '' || (own.serviceAk ?? '') !== '';
    if (hasOwnToken || hasApiKey) {
      this.auth = own;
      // 来源判定顺序要和「能力」一致：API Key 是最强的一档（能读积分 + 能换 AK），
      // 其次是 OAuth，最后才是只有一个 AK 的兜底形态。
      this.source = hasApiKey
        ? 'apikey'
        : own.serviceAk !== null && own.serviceAk !== '' && (own.refreshToken ?? '') === ''
          ? 'ak'
          : 'oauth';
      return this.auth;
    }

    // 复用本机登录态：只读，不写回那两个文件。
    if (this.options.reuseLocalLogin()) {
      try {
        const local = await readLocalLogin();
        if (local !== undefined) {
          this.auth = local;
          this.source = local.serviceAk !== null && local.serviceAk !== '' && (local.refreshToken ?? '') === ''
            ? 'ak'
            : 'local';
          // 本机登录态是「别人的文件」，我们只在自己的文件里存一份副本，
          // 后续续期写的是我们这份，不回写对方。
          await this.persistAuth();
          return this.auth;
        }
      } catch (error) {
        this.options.warn(`复用本机登录态失败：${messageOf(error)}`);
      }
    }

    this.auth = { ...EMPTY_AUTH };
    this.source = 'none';
    return this.auth;
  }

  /** 把内存里的登录态落盘。 */
  private async persistAuth(): Promise<void> {
    if (this.auth === undefined) return;
    try {
      await writeAuth(this.auth);
    } catch (error) {
      this.options.warn(`写登录态失败（不影响本次使用）：${messageOf(error)}`);
    }
  }

  /**
   * 确保有选中的项目。
   * @param auth - 登录态（会被就地更新）。
   * @returns 项目 urlId。
   */
  private async ensureProject(auth: StoredAuth): Promise<string> {
    const explicit = this.options.explicitProject().trim();
    const projectUrlId = await pickProject(auth, explicit === '' ? undefined : explicit);
    if (auth.projectUrlId !== projectUrlId) {
      auth.projectUrlId = projectUrlId;
      await this.persistAuth();
    }
    return projectUrlId;
  }

  /** 安排下一次轮询（间隔取插件状态的 pollIntervalMs）。 */
  private schedule(): void {
    this.unschedule();
    if (this.disposed) return;
    const interval = this.currentInterval();
    this.timer = setInterval(() => {
      void this.status(false).catch((error: unknown) => {
        this.options.warn(`轮询失败：${messageOf(error)}`);
      });
    }, interval);
    this.timer.unref?.();
  }

  /** 取消轮询。 */
  private unschedule(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 当前轮询间隔（只认封闭五档）。 */
  private currentInterval(): number {
    const interval = this.stateCache?.pollIntervalMs;
    return typeof interval === 'number' && POLL_INTERVAL_CHOICES.includes(interval)
      ? interval
      : 300_000;
  }

  /** 最近一次读到的插件状态（`rememberStateSync` 写入）。 */
  private stateCache?: MeooPluginState;

  /**
   * 同步记住插件状态（供 {@link currentInterval} 同步读）。
   * @param state - 最新状态。
   */
  rememberStateSync(state: MeooPluginState): void {
    this.stateCache = state;
    // 间隔可能变了：重排定时器。
    if (this.readers > 0) this.schedule();
    // 签到开关/时刻也可能变了：即使没有界面打开，签到也应该照常跑。
    this.scheduleCheckin();
  }

  /** 改插件状态并让定时器跟着走。 */
  private async updateState(patch: Partial<MeooPluginState>): Promise<MeooPluginState> {
    const next = await this.options.saveState(patch);
    this.stateCache = next;
    if (patch.pollIntervalMs !== undefined) this.schedule();
    if (patch.checkinEnabled !== undefined || patch.checkinTime !== undefined) this.scheduleCheckin();
    return next;
  }

  /** 读签到记录（首次读盘后常驻内存）。 */
  private async loadCheckinState(): Promise<CheckinState> {
    if (this.checkin !== undefined) return this.checkin;
    try {
      this.checkin = await readCheckinState();
    } catch (error) {
      this.options.warn(`读签到记录失败：${messageOf(error)}`);
      this.checkin = { ...EMPTY_CHECKIN };
    }
    return this.checkin;
  }

  /** 取消下一次签到定时器。 */
  private unscheduleCheckin(): void {
    if (this.checkinTimer !== undefined) {
      clearTimeout(this.checkinTimer);
      this.checkinTimer = undefined;
    }
  }

  /**
   * 安排下一次签到。
   *
   * 没有界面打开也要转：签到是账号级动作，不是「打开卡片才发生」的界面效果。
   * 定时器 `unref()`，不阻止进程退出。
   */
  private scheduleCheckin(): void {
    this.unscheduleCheckin();
    if (this.disposed) return;
    const state = this.stateCache;
    if (state === undefined || !state.checkinEnabled) return;
    const now = this.now();
    const due = isCheckinDue(this.checkin?.lastRunDate ?? null, state.checkinTime, now);
    const delay = due
      ? Math.max(1_000, this.checkinRetryAt > now ? this.checkinRetryAt - now : 1_000)
      : Math.max(1_000, nextCheckinAt(state.checkinTime, now) - now);
    const timer = setTimeout(() => {
      this.checkinTimer = undefined;
      void this.runCheckinNow(false)
        .catch((error: unknown) => this.options.warn(`每日签到失败：${messageOf(error)}`))
        .finally(() => this.scheduleCheckin());
    }, delay);
    timer.unref?.();
    this.checkinTimer = timer;
  }

  /**
   * 立刻给**所有**已保存令牌跑一遍签到/核对。
   *
   * @param force - 手动触发时忽略「今天已经跑过」；定时任务不忽略。
   * @returns 最新的签到状态。
   */
  async runCheckinNow(force = false): Promise<CheckinState> {
    if (this.checkinRunning !== undefined) return this.checkinRunning;
    const running = this.performCheckin(force).finally(() => {
      this.checkinRunning = undefined;
    });
    this.checkinRunning = running;
    return running;
  }

  /** 签到的实际执行体。 */
  private async performCheckin(force: boolean): Promise<CheckinState> {
    const now = this.now();
    const today = shanghaiDate(now);
    const pluginState = this.stateCache ?? (await this.options.state());
    this.stateCache = pluginState;
    const existing = await this.loadCheckinState();
    if (!force && existing.lastRunDate === today) return existing;
    if (pluginState.checkinEnabled !== true && !force) return existing;

    const auth = await this.loadAuth();
    const records = listTokens(auth);
    if (records.length === 0) {
      const next: CheckinState = { version: 1, lastRunDate: today, lastRunAtMs: now, records: [] };
      this.checkin = next;
      await writeCheckinState(next);
      this.checkinRetryAt = 0;
      return next;
    }

    let result: Awaited<ReturnType<typeof runCheckin>>;
    try {
      result = await runCheckin(auth, now);
    } catch (error) {
      // 失败保留上次成功记录，30 分钟后再试；不要把 lastRunDate 写成今天，
      // 否则「今天跑过」会把失败悄悄变成「已完成」。
      this.checkinRetryAt = now + 30 * 60_000;
      this.options.warn(`每日签到失败：${messageOf(error)}`);
      throw error;
    }
    this.auth = result.auth;
    await this.persistAuth();
    const next: CheckinState = {
      version: 1,
      lastRunDate: today,
      lastRunAtMs: now,
      records: result.records.slice(-20),
    };
    this.checkin = next;
    this.checkinRetryAt = 0;
    await writeCheckinState(next);
    // 积分/权益可能刚变：让卡片下一次读状态时重拉，而不是等 5 分钟轮询。
    this.points = undefined;
    return next;
  }

  /** 签到视图（不含凭据）。 */
  private async checkinView(): Promise<StatusCheckin> {
    const state = this.stateCache;
    const record = await this.loadCheckinState();
    const time = state?.checkinTime ?? '10:00';
    return {
      enabled: state?.checkinEnabled ?? true,
      time,
      ...(record.lastRunAtMs > 0 ? { lastRunAtMs: record.lastRunAtMs } : {}),
      lastRunDate: record.lastRunDate,
      due: (state?.checkinEnabled ?? true) && isCheckinDue(record.lastRunDate, time, this.now()),
      records: record.records.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        status: entry.status,
        ...(entry.amount === undefined ? {} : { amount: entry.amount }),
        ...(entry.message === undefined ? {} : { message: entry.message }),
        atMs: entry.atMs,
      })),
    };
  }

  /** 令牌摘要视图（不含凭据）。 */
  private accountsView(auth: StoredAuth): StatusAccount[] {
    return listTokens(auth).map((token) => ({
      id: token.id,
      kind: token.kind,
      name: token.name,
      masked: token.masked,
      active: token.active,
      savedAt: token.savedAt,
      hasServiceAk: token.hasServiceAk,
    }));
  }

  /** 新令牌落盘后补跑一次签到（不阻塞保存动作）。 */
  private queueCheckin(): void {
    if (this.stateCache?.checkinEnabled === false) return;
    void this.runCheckinNow(true).catch((error: unknown) => {
      this.options.warn(`新令牌签到失败：${messageOf(error)}`);
    });
  }

  /** 手动签到动作：跑全部令牌，然后把状态文档一起还给界面。 */
  private async checkinAction(): Promise<unknown> {
    try {
      const state = await this.runCheckinNow(true);
      return {
        ok: true,
        checkin: await this.checkinView(),
        records: state.records,
        status: await this.status(true),
      };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 切换当前令牌。 */
  private async switchAccount(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (id === '') return { ok: false, error: '缺少令牌 id' };
    const auth = await this.loadAuth();
    const target = listTokens(auth).find((token) => token.id === id);
    if (target === undefined) return { ok: false, error: '这个令牌不在列表里' };
    if (auth.activeId === id) return { ok: true, status: await this.status(false) };

    this.auth = activateToken(auth, id);
    this.source = target.kind === 'apikey' ? 'apikey' : 'oauth';
    this.invalidate();
    this.lastError = undefined;
    this.loginError = undefined;
    await this.persistAuth();
    try {
      const current = this.auth;
      const needsResolve =
        current.serviceAk === null ||
        current.serviceAk === undefined ||
        current.serviceAk === '' ||
        current.serviceAkProjectId !== current.projectUrlId;
      await this.serviceAk(needsResolve);
    } catch (error) {
      // 切令牌本身成功了：AK 解析失败只记录，不要把状态退回上一个账号。
      this.noteError(error);
    }
    return { ok: true, status: await this.status(true) };
  }

  /** 从列表里删掉一个令牌；删的是当前令牌就顺位切换。 */
  private async removeAccount(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (id === '') return { ok: false, error: '缺少令牌 id' };
    const auth = await this.loadAuth();
    if (!listTokens(auth).some((token) => token.id === id)) {
      return { ok: false, error: '这个令牌不在列表里' };
    }
    this.auth = removeToken(auth, id);
    this.invalidate();
    this.lastError = undefined;
    if (listTokens(this.auth).length === 0) {
      this.source = 'none';
      this.loginError = undefined;
      await this.persistAuth();
      return { ok: true, status: await this.status(true) };
    }
    this.source = (this.auth.apiKey ?? '') !== '' ? 'apikey' : 'oauth';
    await this.persistAuth();
    try {
      await this.serviceAk(false);
    } catch (error) {
      this.noteError(error);
    }
    return { ok: true, status: await this.status(true) };
  }

  /**
   * 构建状态文档。
   * @param force - 忽略缓存，强制重拉。
   * @returns 状态文档。
   */
  async status(force: boolean): Promise<StatusDocument> {
    if (this.refreshing !== undefined) {
      // 后台轮询可能在途：非强制读直接复用它（这是缓存语义），
      // 但**强制刷新不能**复用 —— 那等于「点了刷新，拿到的是刷新前的文档」。
      if (!force) return this.refreshing;
      await this.refreshing.catch(() => undefined);
    }
    const running = this.collect(force).finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = running;
    return running;
  }

  /** 真正去读的那一步（失败只记 lastError，不清空旧值）。 */
  private async collect(force: boolean): Promise<StatusDocument> {
    const pluginState = this.stateCache ?? (await this.options.state());
    this.stateCache = pluginState;

    const auth = await this.loadAuth();
    let loginState: StatusDocument['login']['state'] = 'signed-out';
    if ((auth.refreshToken ?? '') !== '' || (auth.accessToken ?? '') !== '' || (auth.apiKey ?? '') !== '') {
      loginState = 'signed-in';
    }
    if (this.options.manualServiceAk().trim() !== '') {
      loginState = 'signed-in';
      this.source = 'ak';
    }
    if (loginState === 'signed-in' && looksExpired(auth)) loginState = 'expired';

    // 有 AK 才谈得上「能发请求」；有登录态但 AK 还没解析出来也算未就绪。
    let hasServiceAk =
      this.options.manualServiceAk().trim() !== '' ||
      (auth.serviceAk !== null && auth.serviceAk !== undefined && auth.serviceAk !== '');

    // 1. 目录 + 项目 + 积分：各自失败互不牵连。
    if (loginState === 'signed-in') {
      try {
        const ak = await this.serviceAk();
        hasServiceAk = true;
        const fresh = force || this.models === undefined || this.now() - (this.models.at ?? 0) > 60_000;
        if (fresh) {
          const models = await this.fetchCatalog(ak);
          if (models.length > 0) this.models = { value: models, at: this.now() };
        }
      } catch (error) {
        this.noteError(error);
        if (error instanceof MeooError && error.expired) loginState = 'expired';
      }

      // 项目列表：读得到才有得选；读不到不是错误（很多账号只有一个项目）。
      if (force || this.projects === undefined) {
        try {
          this.projects = { value: await listProjects(auth), at: this.now() };
        } catch (error) {
          this.noteError(error);
        }
      }

      // 积分：手填 AK 读不到积分账户（这是上游事实，不是本插件没做）。
      if (this.options.manualServiceAk().trim() === '' && (force || this.points === undefined)) {
        try {
          this.points = { value: await fetchPoints(auth), at: this.now() };
        } catch (error) {
          this.noteError(error);
        }
      }
    }

    const models: StatusModel[] = this.catalog().map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      vision: model.vision,
      enabled: !pluginState.disabledModels.includes(model.id),
      ...(model.price === undefined ? {} : { price: model.price }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.discount === undefined ? {} : { discount: model.discount }),
    }));

    const points: StatusPoints =
      this.points === undefined
        ? { state: loginState === 'expired' ? 'expired' : 'unavailable' }
        : {
            state: 'ok',
            available: this.points.value.available,
            consumed: this.points.value.consumed,
            frozen: this.points.value.frozen,
            ...(this.points.value.nextExpiry === null ? {} : { nextExpiry: this.points.value.nextExpiry }),
            grants: this.points.value.grants.slice(0, 5),
            updatedAtMs: this.points.value.atMs,
          };

    const projects = (this.projects?.value ?? []).map((project) => ({
      urlId: project.urlId,
      name: project.name,
      selected: project.urlId === (auth.projectUrlId ?? ''),
    }));

    return buildStatusDocument({
      version: VERSION,
      login: {
        state: loginState,
        source: this.source,
        ...(auth.username === null || auth.username === undefined || auth.username === ''
          ? {}
          : { name: auth.username }),
        hasServiceAk,
        canLogin: true,
        ...(this.loggingIn ? { pending: true } : {}),
        ...(this.loginUrl === undefined ? {} : { authorizeUrl: this.loginUrl }),
        ...(this.loginError === undefined ? {} : { error: this.loginError }),
      },
      points,
      projects,
      ...(auth.projectUrlId === null || auth.projectUrlId === undefined || auth.projectUrlId === ''
        ? {}
        : { activeProject: auth.projectUrlId }),
      models,
      settings: {
        pollIntervalMs: pluginState.pollIntervalMs,
        composerPill: pluginState.composerPill,
        sidebarPanel: pluginState.sidebarPanel,
        disabledModels: pluginState.disabledModels,
        checkinEnabled: pluginState.checkinEnabled,
        checkinTime: pluginState.checkinTime,
      },
      accounts: this.accountsView(auth),
      ...(auth.activeId === null || auth.activeId === undefined ? {} : { activeAccountId: auth.activeId }),
      checkin: await this.checkinView(),
      gateway: this.gateway(),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      nowMs: this.now(),
    });
  }

  /** 记一条上游错误（保留旧数据）。 */
  private noteError(error: unknown): void {
    const message = messageOf(error);
    this.lastError = message;
    if (this.auth !== undefined) this.auth.lastError = message;
    this.options.warn(message);
  }

  /**
   * 执行一个动作（白名单由 `routes.ts` 保证）。
   * @param action - 动作名。
   * @param body - 请求体。
   * @returns 给浏览器的结果。
   */
  async run(action: MeooAction, body: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'refresh':
        return { ok: true, status: await this.status(true) };
      case 'login':
        return this.loginWithBrowser(body.restart === true);
      case 'login-code':
        return this.submitLoginCode(String(body.code ?? ''));
      case 'logout':
        return this.logout();
      case 'settings':
        return this.applySettings(body);
      case 'project':
        return this.switchProject(body);
      case 'apikey':
        return this.setApiKey(body);
      case 'ak':
        return this.setManualAk(body);
      case 'account-switch':
        return this.switchAccount(body);
      case 'account-remove':
        return this.removeAccount(body);
      case 'checkin':
        return this.checkinAction();
      case 'test-model':
        return this.testModel(body);
      default:
        return { ok: false, error: `未知操作: ${String(action)}` };
    }
  }

  /**
   * 手动提交授权码（回调走不通时的兜底）。
   *
   * 为什么必须有：浏览器回调依赖 `http://127.0.0.1:<port>` 这条回环能被
   * 浏览器打到。本机装了代理、或浏览器跑在另一台机器/容器里时，这条回调
   * 根本到不了 —— 那样登录会卡到 10 分钟超时，用户只会觉得「插件坏了」。
   * 用户其实能看到地址栏里那条带 `code=` 的地址，贴回来就能接着走。
   */
  private submitLoginCode(value: string): unknown {
    if (this.login === undefined) {
      return { ok: false, error: '当前没有在等授权的登录，请先点「登录秒悟」' };
    }
    if (value.trim() === '') return { ok: false, error: '授权码是空的' };
    const accepted = this.login.submitCode(value);
    if (!accepted) {
      return { ok: false, error: '授权码无法识别：请粘贴回调地址整行，或只粘贴 code 的值' };
    }
    return { ok: true, message: '已收到授权码，正在换票…' };
  }

  /**
   * 浏览器授权登录。
   *
   * @param restart - 丢弃在途的那次登录、重新起一次。
   *   为什么要它：用户关掉浏览器就再也不会回来点授权，旧会话会一直挂到
   *   10 分钟超时；这期间点「登录」只能拿回同一个 URL，等于把用户锁住。
   */
  private async loginWithBrowser(restart = false): Promise<unknown> {
    if (restart && this.loggingIn) {
      this.loginGeneration += 1;
      this.login?.cancel();
      this.login = undefined;
      this.loggingIn = false;
      this.loginUrl = undefined;
      this.loginError = undefined;
    }
    // 已经有一个在等授权：把那个 URL 还给用户，而不是回一句「已经打开了」就完了 ——
    // 浏览器没弹出来时，用户唯一的出路就是拿到 URL 自己打开。
    if (this.loggingIn) {
      return {
        ok: true,
        alreadyPending: true,
        ...(this.loginUrl === undefined ? {} : { url: this.loginUrl }),
        message: '授权页已经打开过了；没看到就手动打开返回的 url。',
      };
    }
    this.loggingIn = true;
    this.loginError = undefined;
    this.loginGeneration += 1;
    const generation = this.loginGeneration;
    /** 这一代是否还是「当前那一代」。 */
    const isCurrent = (): boolean => this.loginGeneration === generation;
    try {
      const session = startLogin({
        apiBaseUrl: this.currentAuth().apiBaseUrl,
        onToken: async (auth) => {
          const me = await fetchIdentity(auth);
          // 登录成功也写进多令牌列表：浏览器授权与 API Key 可以并存，
          // 谁都不会把对方的令牌冲掉。
          return upsertToken(await this.loadAuth(), {
            kind: 'oauth',
            apiKey: null,
            accessToken: auth.accessToken ?? null,
            refreshToken: auth.refreshToken ?? null,
            accessExpiresAt: auth.accessExpiresAt ?? 0,
            scope: auth.scope ?? null,
            openid: auth.openid ?? null,
            username: me.name ?? null,
            userId: me.userId ?? null,
            projectUrlId: me.projectUrlId ?? null,
            serviceAk: null,
            serviceAkProjectId: null,
          });
        },
      });
      this.login = session;
      const url = await session.ready;
      // 起端口期间用户点了「重新发起」：这一代已经作废，把端口关掉别留着。
      if (!isCurrent()) {
        session.cancel();
        return { ok: true, superseded: true, message: '这次登录已被新的登录取代' };
      }
      this.loginUrl = url;
      const open = this.options.openBrowser;
      let opened = false;
      if (open !== undefined) {
        try {
          // 返回值可能是 `void`（老调用方），只有明确的 `false` 才算「没打开」。
          const result: unknown = open(url);
          opened = result !== false;
        } catch {
          opened = false;
        }
      }
      // 让界面立刻看到「授权页已打开」和那条可手动点开的 URL，不用等轮询。
      void this.status(false).catch(() => undefined);
      // 不阻塞动作响应：用户还在浏览器里点授权，这里先回去。
      void session.done
        .then(async (auth) => {
          if (!isCurrent()) return;
          this.auth = auth;
          this.source = 'oauth';
          this.lastError = undefined;
          await this.persistAuth();
          // 授权后立刻把 AK 与目录解析出来，用户回到 DSH 就能直接选模型。
          await this.serviceAk(true);
          this.invalidate();
          this.queueCheckin();
          await this.status(true);
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          this.noteError(error);
          // 换票失败（如 invalid_grant）必须让用户在卡片上看到原因。
          this.loginError = messageOf(error);
        })
        .finally(() => {
          // 只收自己那一代：被 restart 取代的旧会话不能清掉新会话的状态。
          if (!isCurrent()) return;
          this.login = undefined;
          this.loggingIn = false;
          this.loginUrl = undefined;
        });
      return {
        ok: true,
        url,
        opened,
        // 浏览器没被拉起时不要说「已在浏览器打开」—— 那是一句会被用户当场证伪的话。
        message: opened
          ? '已在浏览器打开授权页；点一次「授权」后会自动同步。没弹出就手动打开下面那条链接。'
          : '没能自动拉起浏览器；请手动打开下面那条链接完成授权。',
      };
    } catch (error) {
      if (isCurrent()) {
        this.loggingIn = false;
        this.loginUrl = undefined;
        this.loginError = messageOf(error);
      }
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 清本地登录态（不动别人的文件，也不动已经注册的模型路由）。 */
  private async logout(): Promise<unknown> {
    this.login?.cancel();
    this.login = undefined;
    this.loggingIn = false;
    this.loginUrl = undefined;
    this.loginError = undefined;
    // 显式把每个 token 字段写成 null，而不是整份换成 EMPTY_AUTH：
    // EMPTY_AUTH 里没有写这些键，读出来是 undefined，与「清空」不是一回事。
    this.auth = clearAuth(this.currentAuth());
    this.source = 'none';
    this.invalidate();
    this.lastError = undefined;
    await this.persistAuth();
    return { ok: true, message: '已移除全部令牌' };
  }

  /** 改界面开关（点一下即生效，不走保存）。 */
  private async applySettings(body: Record<string, unknown>): Promise<unknown> {
    const patch: Partial<MeooPluginState> = {};
    if (typeof body.pollIntervalMs === 'number') patch.pollIntervalMs = body.pollIntervalMs;
    if (typeof body.composerPill === 'boolean') patch.composerPill = body.composerPill;
    if (typeof body.sidebarPanel === 'boolean') patch.sidebarPanel = body.sidebarPanel;
    if (typeof body.checkinEnabled === 'boolean') patch.checkinEnabled = body.checkinEnabled;
    if (typeof body.checkinTime === 'string') patch.checkinTime = body.checkinTime;
    if (Array.isArray(body.disabledModels)) {
      patch.disabledModels = body.disabledModels.filter((id): id is string => typeof id === 'string');
    }
    const next = await this.updateState(patch);
    return { ok: true, settings: {
      pollIntervalMs: next.pollIntervalMs,
      composerPill: next.composerPill,
      sidebarPanel: next.sidebarPanel,
      disabledModels: next.disabledModels,
      checkinEnabled: next.checkinEnabled,
      checkinTime: next.checkinTime,
    } };
  }

  /** 换项目（AK 必须重解析：AK 挂在项目下）。 */
  private async switchProject(body: Record<string, unknown>): Promise<unknown> {
    const urlId = typeof body.projectUrlId === 'string' ? body.projectUrlId.trim() : '';
    if (urlId === '') return { ok: false, error: '缺少 projectUrlId' };
    const auth = await this.loadAuth();
    auth.projectUrlId = urlId;
    // 缓存里那个 AK 属于旧项目，必须清掉。
    auth.serviceAk = null;
    auth.serviceAkProjectId = null;
    await this.persistAuth();
    this.invalidate();
    try {
      await this.serviceAk(true);
      return { ok: true, status: await this.status(true) };
    } catch (error) {
      return { ok: false, error: messageOf(error), status: await this.status(true) };
    }
  }

  /** 手填项目服务 AK（先用网关验一次，验不过不落盘）。 */
  /**
   * 保存控制面 API Key，并立刻换出项目服务 AK。
   *
   * 这是本插件**成本最低的一条登录路径**，比浏览器授权还省事：
   * 贴一个 `meoo_ak_…`，插件自己去读身份、项目、积分，再拿项目服务 AK 打通网关。
   * 用户不需要点浏览器、不需要等回调、更不需要手抄那串 87 字符的 AK。
   *
   * 为什么 API Key 能读积分而手填项目服务 AK 不能：两者是**不同层**的凭证。
   * `/account/points` 只认控制面凭证（OAuth token 或 API Key），
   * 项目服务 AK 只是网关 Bearer，控制面根本不接受它。
   */
  private async setApiKey(body: Record<string, unknown>): Promise<unknown> {
    const raw = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (raw === '') return { ok: false, error: '请填写 API Key' };
    if (isServiceAk(raw)) {
      return {
        ok: false,
        error: '这是项目服务 AK，不是 API Key；请到 meoo.com → 设置 → API 密钥 里复制 meoo_ak_ 开头的那串',
      };
    }
    if (!isApiKey(raw)) {
      return { ok: false, error: 'API Key 应该以 meoo_ak_ 开头，请检查是否复制完整' };
    }

    const previous = await this.loadAuth();
    const probe: StoredAuth = { ...previous, apiKey: raw, accessToken: null, refreshToken: null, accessExpiresAt: 0 };
    try {
      // 1) 先验身份：key 无效在这里就断掉，不写坏状态。
      const me = await fetchIdentity(probe);
      // 2) 再读项目列表：至少一个项目才谈得上解析 AK。
      const projects = await listProjects(probe);
      const explicit = this.options.explicitProject().trim();
      const projectUrlId =
        explicit !== '' && projects.some((project) => project.urlId === explicit)
          ? explicit
          : previous.projectUrlId !== null &&
              previous.projectUrlId !== undefined &&
              previous.projectUrlId !== '' &&
              projects.some((project) => project.urlId === previous.projectUrlId)
            ? previous.projectUrlId
            : projects[0]?.urlId;
      if (projectUrlId === undefined) {
        return { ok: false, error: '这个账号下还没有项目：请先在 meoo.com 建一个项目，再回来点保存' };
      }
      // 3) 解析项目服务 AK（项目没开通云服务时会自动开通一次）。
      const serviceAk = await resolveServiceAk(probe, projectUrlId);

      // 4) 全部成功才落盘，避免半成品登录态。
      //    写进多令牌列表（同一个 key 重复粘贴 = 更新那一项），而不是覆盖整份文件：
      //    用户之前保存的其它令牌必须还在。
      this.auth = upsertToken(previous, {
        kind: 'apikey',
        apiKey: raw,
        accessToken: null,
        refreshToken: null,
        accessExpiresAt: 0,
        username: me.name ?? null,
        userId: me.userId ?? null,
        projectUrlId,
        serviceAk,
        serviceAkProjectId: projectUrlId,
      });
      this.auth.lastSyncAt = this.now();
      this.auth.lastError = null;
      this.source = 'apikey';
      this.loginError = undefined;
      await this.persistAuth();
      this.invalidate();
      const models = await this.fetchCatalog(serviceAk);
      if (models.length > 0) this.models = { value: models, at: this.now() };
      this.projects = { value: projects, at: this.now() };
      this.queueCheckin();
      return { ok: true, project: projectUrlId, models: models.length, status: await this.status(true) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  private async setManualAk(body: Record<string, unknown>): Promise<unknown> {
    const raw = typeof body.serviceAk === 'string' ? body.serviceAk : '';
    try {
      const models = await verifyServiceAk(raw, this.gateway());
      const auth = await this.loadAuth();
      auth.serviceAk = raw.trim();
      auth.serviceAkProjectId = auth.projectUrlId ?? null;
      this.source = 'ak';
      await this.persistAuth();
      this.models = { value: models, at: this.now() };
      return { ok: true, models: models.length, status: await this.status(true) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /**
   * 测一个模型此刻能不能用。
   *
   * **真的会花钱**（一次最小对话请求）：所以只按单个模型手工点，没有批量按钮。
   * 请求体压到最小（`max_tokens: 1`），把成本降到最低。
   */
  private async testModel(body: Record<string, unknown>): Promise<unknown> {
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    if (modelId === '') return { ok: false, error: '缺少 modelId' };
    try {
      const ak = await this.serviceAk();
      const base = this.gateway();
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ak}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (res.ok) return { ok: true, modelId, message: '可用' };
      return { ok: false, modelId, message: `不可用（HTTP ${res.status}）：${text.slice(0, 200)}` };
    } catch (error) {
      return { ok: false, modelId, message: messageOf(error) };
    }
  }
}

/** 状态文件路径（诊断页显示用）。 */
export function authFilePath(): string {
  return authFile();
}

/** 登录态目录（诊断页显示用）。 */
export function authDirPath(): string {
  return `${AUTH_DIRNAME}/${AUTH_FILENAME}`;
}
