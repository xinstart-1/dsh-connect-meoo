/**
 * 状态文档：宿主算好、浏览器直接渲染的那份 JSON。
 *
 * 为什么不让浏览器自己算：积分、目录、登录态都需要 access token / 项目服务 AK，
 * 它们**不能进页面**（凭据不传到页面是底线）。所以宿主把已归一好的展示数据放在
 * `/plugins/dsh-connect-meoo/status`，页面只负责排版。
 *
 * 这份文档的形状是**契约**：浏览器半侧（`src/client/bundle.js`）按字段名读它，
 * 改字段必须同步改那边（`scripts/check-client.mjs` 会卡住漏改的键）。
 *
 * @module dsh-connect-meoo/host/status
 */

/** 积分视图。 */
export interface StatusPoints {
  /** `ok` 有读数；`expired` 登录态失效；`unavailable` 读不到。 */
  state: 'ok' | 'unavailable' | 'expired';
  available?: number;
  consumed?: number;
  frozen?: number;
  /** 最近一批积分的到期日（`YYYY-MM-DD`）。 */
  nextExpiry?: string;
  /** 每批剩余积分（最多 5 条，卡片上只列临期的那几批）。 */
  grants?: Array<{ remaining: number; expiresDate: string }>;
  updatedAtMs?: number;
}

/** 项目视图。 */
export interface StatusProject {
  urlId: string;
  name: string;
  /** 当前是否被选中。 */
  selected: boolean;
}

/** 模型视图。 */
export interface StatusModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  /** 用户是否关掉了它。 */
  enabled: boolean;
  /** 官网价格档位（`cheap` / `moderate` / `expensive` / `veryExpensive`）；拿不到就没有。 */
  price?: 'cheap' | 'moderate' | 'expensive' | 'veryExpensive';
  /** 官网的一句话说明。 */
  description?: string;
  /** 夜间折扣（折数与时间窗）。 */
  discount?: { label: number; start: string; end: string };
}

/** 一份已保存令牌的视图（**不含**完整凭据）。 */
export interface StatusAccount {
  id: string;
  kind: 'apikey' | 'oauth';
  /** 账号名，拿不到时是脱敏标签。 */
  name: string;
  /** 脱敏后的凭据（`meoo_ak_…abcd`）。 */
  masked: string;
  active: boolean;
  savedAt: number;
  hasServiceAk: boolean;
}

/** 一个令牌的签到结果视图。 */
export interface StatusCheckinRecord {
  name: string;
  kind: 'apikey' | 'oauth';
  status: 'granted' | 'already' | 'unsupported' | 'failed';
  /** 今天这一批每日登录积分的剩余额度。 */
  amount?: number;
  /** 失败/不支持时的原文。 */
  message?: string;
  atMs: number;
}

/** 每日签到视图。 */
export interface StatusCheckin {
  enabled: boolean;
  /** `HH:MM`（北京时间）。 */
  time: string;
  lastRunAtMs?: number;
  lastRunDate?: string | null;
  /** 现在是否已经过了今天的点、且今天还没跑过。 */
  due: boolean;
  records: StatusCheckinRecord[];
}

/** 界面开关视图（渲染当前值，改动走动作路由）。 */
export interface StatusSettings {
  pollIntervalMs: number;
  composerPill: boolean;
  sidebarPanel: boolean;
  disabledModels: string[];
  checkinEnabled: boolean;
  checkinTime: string;
}

/** 登录态视图。 */
export interface StatusLogin {
  /** `signed-in` 有可用登录态；`signed-out` 没有；`expired` 有但失效了。 */
  state: 'signed-in' | 'signed-out' | 'expired';
  /**
   * `oauth` 浏览器授权；`local` 复用本机登录态；`apikey` 手填控制面 API Key；
   * `ak` 手填项目服务 AK；`none` 无。
   */
  source: 'oauth' | 'local' | 'apikey' | 'ak' | 'none';
  /** 展示名（账号名，或「项目服务 AK」）。 */
  name?: string;
  /** 是否有项目服务 AK（有它才能真的发请求）。 */
  hasServiceAk: boolean;
  /** 是否支持一键登录（浏览器授权）。 */
  canLogin: boolean;
  /**
   * 是否正在等用户完成浏览器授权。
   *
   * 有它才能让界面说「授权页已打开」，而不是在用户点了没反应时一片沉默 ——
   * 上一版的登录失败只写进 console，用户在卡片上看不到任何东西。
   */
  pending?: boolean;
  /**
   * 本次登录的授权页地址。
   *
   * `explorer.exe` 拉浏览器可能被拦（本机实测它退出码 1 却仍会打开），
   * 所以 URL 必须回到页面，让用户能手动点开 —— 不能只有「自动打开」一条路。
   */
  authorizeUrl?: string;
  /** 最近一次登录失败的原因（原文，便于整段贴进反馈）。 */
  error?: string;
}

/** 完整状态文档。 */
export interface StatusDocument {
  version: string;
  login: StatusLogin;
  points: StatusPoints;
  projects: StatusProject[];
  /** 当前选中的项目。 */
  activeProject?: string;
  models: StatusModel[];
  settings: StatusSettings;
  /** 已保存的全部令牌（多令牌切换用）。 */
  accounts: StatusAccount[];
  /** 当前令牌 id。 */
  activeAccountId?: string;
  /** 每日签到状态。 */
  checkin: StatusCheckin;
  /** 网关地址（诊断里显示）。 */
  gateway: string;
  /** 整份文档里**最旧**一段数据的时刻。 */
  readAtMs: number;
  /** 上游最近一次错误的原文（诊断用，不翻译、不概括）。 */
  lastError?: string;
}

/** 构建文档的输入。 */
export interface StatusInput {
  version: string;
  login: StatusLogin;
  points?: StatusPoints;
  projects?: StatusProject[];
  activeProject?: string;
  models: StatusModel[];
  settings?: StatusSettings;
  accounts?: StatusAccount[];
  activeAccountId?: string;
  checkin?: StatusCheckin;
  gateway: string;
  lastError?: string;
  nowMs?: number;
}

/** 默认界面开关（与 `state.ts` 的 DEFAULT_STATE 一致；这里不 import 以免循环依赖）。 */
const DEFAULT_SETTINGS: StatusSettings = {
  pollIntervalMs: 300_000,
  composerPill: true,
  sidebarPanel: false,
  disabledModels: [],
  checkinEnabled: true,
  checkinTime: '10:00',
};

/**
 * 组装状态文档；缺的段落给安全缺省，永不抛。
 *
 * 这个函数存在的意义是让**缺省**只有一个定义处：页面在三种宿主版本上
 * （老版本没有 status 路由、新版本有、有但读不到）都要能渲染出同一句话。
 *
 * @param input - 已归一的数据。
 * @returns 完整文档。
 */
export function buildStatusDocument(input: StatusInput): StatusDocument {
  const now = input.nowMs ?? Date.now();
  return {
    version: input.version,
    login: input.login,
    points: input.points ?? { state: 'unavailable' },
    projects: input.projects ?? [],
    ...(input.activeProject === undefined ? {} : { activeProject: input.activeProject }),
    models: input.models,
    settings: input.settings ?? { ...DEFAULT_SETTINGS },
    accounts: input.accounts ?? [],
    ...(input.activeAccountId === undefined ? {} : { activeAccountId: input.activeAccountId }),
    checkin: input.checkin ?? {
      enabled: false,
      time: DEFAULT_SETTINGS.checkinTime,
      due: false,
      records: [],
    },
    gateway: input.gateway,
    readAtMs: now,
    ...(input.lastError === undefined || input.lastError === '' ? {} : { lastError: input.lastError }),
  };
}
