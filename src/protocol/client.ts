/**
 * Meoo 控制面与网关客户端。
 *
 * 两条通道，鉴权方式不同，**不能混**：
 *
 * | 通道 | 基址 | 鉴权 |
 * | --- | --- | --- |
 * | 控制面（身份 / 项目 / AK / 积分） | `https://meoo.com/open/v1/cli-compat/…` | `Bearer <access token>` |
 * | 模型网关（目录 / 对话） | `https://api.meoo.host/meoo-ai/compatible-mode/v1` | `Bearer <项目服务 AK>` |
 *
 * 一个必须记住的坑：**Meoo 的业务错误也走 HTTP 200**
 * （`{"success":false,"errCode":…}`）。只看 `res.ok` 会把失败当成功，
 * 于是「同步成功」的提示配着一个空目录。
 *
 * @module dsh-connect-meoo/protocol/client
 */

import {
  API_BASE,
  CLI_HEADERS,
  CONTROL_TIMEOUT_MS,
  GATEWAY_BASE,
  GATEWAY_TIMEOUT_MS,
  IDENTITY_PATH,
  POINTS_PATH,
  PROJECTS_PATH,
  REFRESH_EARLY_MS,
  cloudEnvPath,
  cloudPath,
} from '../constants.ts';
import { tokenRequest, type StoredAuth } from '../credentials/store.ts';
import { AGENT_MODELS_PATH, parseAgentModels, parseGatewayModels, type MeooModel } from './catalog.ts';

/** 控制面/网关调用里能区分出来的错误类别。 */
export class MeooError extends Error {
  /** HTTP 状态码（网络层失败时为 0）。 */
  readonly status: number;
  /** 上游业务码（`errCode`）。 */
  readonly errCode: string | undefined;
  /** 登录态失效：调用方据此提示重新登录。 */
  readonly expired: boolean;

  constructor(message: string, options: { status?: number; errCode?: string; expired?: boolean } = {}) {
    super(message);
    this.name = 'MeooError';
    this.status = options.status ?? 0;
    this.errCode = options.errCode;
    this.expired = options.expired ?? false;
  }
}

/** 上游错误体里挑一句能读的话。 */
function vendorMessage(json: unknown, text: string): string {
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    for (const key of ['detail', 'message', 'msg', 'title']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    const errCode = record.errCode ?? record.code;
    if (typeof errCode === 'string' || typeof errCode === 'number') return `errCode=${String(errCode)}`;
  }
  return text.slice(0, 200);
}

/** 把响应体解析成 JSON（空体 → null）。 */
function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 控制面调用（需要 access token）。
 *
 * 401 时**续期一次再重试**；续期后仍 401 就报 `expired`，不再无限打接口。
 *
 * @param auth - 当前登录态（会被就地更新 token 字段）。
 * @param method - HTTP 方法。
 * @param path - 控制面路径（含 `/open/v1/…` 前缀）。
 * @param body - JSON 请求体。
 * @returns 上游 `data` 字段（没有就返回整个响应体）。
 */
export async function controlRequest(
  auth: StoredAuth,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const apiBaseUrl = (auth.apiBaseUrl === '' ? API_BASE : auth.apiBaseUrl).replace(/\/+$/, '');
  // API Key 优先：它是静态凭证，不需要（也不能）续期。用它时整条 OAuth 续期
  // 逻辑都该跳过 —— 拿 API Key 去换 token 只会得到一个 400。
  const apiKey = typeof auth.apiKey === 'string' ? auth.apiKey.trim() : '';
  const access = apiKey !== '' ? apiKey : await ensureAccessToken(auth);
  const send = async (token: string): Promise<{ res: Response; text: string }> => {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...CLI_HEADERS,
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    return { res, text: await res.text() };
  };

  let { res, text } = await send(access);
  if (res.status === 401 && apiKey === '' && auth.refreshToken !== null && auth.refreshToken !== undefined) {
    const refreshed = await refreshAccessToken(auth);
    ({ res, text } = await send(refreshed));
  }
  const json = parseJson(text);

  // 业务错误也走 200，必须先拦。
  if (typeof json === 'object' && json !== null && (json as Record<string, unknown>).success === false) {
    const record = json as Record<string, unknown>;
    throw new MeooError(`${path} 失败：${vendorMessage(json, text)}`, {
      status: res.status,
      ...(record.errCode === undefined ? {} : { errCode: String(record.errCode) }),
    });
  }
  if (res.status === 401) {
    throw new MeooError(
      apiKey === ''
        ? `${path} 失败 HTTP 401（续期后仍 401，请重新登录）：${vendorMessage(json, text)}`
        : `${path} 失败 HTTP 401（API Key 无效或已撤销，请到 meoo.com 重新生成）：${vendorMessage(json, text)}`,
      {
        status: 401,
        // API Key 失效不是「过期」：没有续期这条路，只能换 key。
        ...(apiKey === '' ? { expired: true } : {}),
      },
    );
  }
  if (!res.ok) {
    throw new MeooError(`${path} 失败 HTTP ${res.status}：${vendorMessage(json, text)}`, {
      status: res.status,
    });
  }
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    return record.data !== undefined ? record.data : json;
  }
  return json;
}

/** 续期结果的复用窗口（同一 refresh token 并发续期只打一次上游）。 */
const renewCache = new Map<string, { at: number; next: Partial<StoredAuth> }>();
const renewing = new Map<string, Promise<Partial<StoredAuth>>>();

/**
 * 续期 access token（会就地更新 `auth`）。
 * @param auth - 登录态。
 * @returns 新的 access token。
 */
export async function refreshAccessToken(auth: StoredAuth): Promise<string> {
  const refreshToken = auth.refreshToken;
  if (refreshToken === null || refreshToken === undefined || refreshToken === '') {
    throw new MeooError('没有 refresh token，请先登录秒悟 Meoo', { expired: true });
  }
  const cached = renewCache.get(refreshToken);
  if (cached !== undefined && Date.now() - cached.at < 60_000) {
    applyTokens(auth, cached.next);
    return auth.accessToken ?? '';
  }
  let pending = renewing.get(refreshToken);
  if (pending === undefined) {
    const apiBaseUrl = (auth.apiBaseUrl === '' ? API_BASE : auth.apiBaseUrl).replace(/\/+$/, '');
    pending = (async () => {
      const token = await tokenRequest(apiBaseUrl, {
        grant_type: 'refresh_token',
        client_id: clientIdOf(apiBaseUrl),
        refresh_token: refreshToken,
      });
      if (typeof token.access_token !== 'string' || token.access_token === '') {
        throw new MeooError('续期响应里没有 access_token，请重新登录', { expired: true });
      }
      const next: Partial<StoredAuth> = {
        accessToken: token.access_token,
        ...(typeof token.refresh_token === 'string' && token.refresh_token !== ''
          ? { refreshToken: token.refresh_token }
          : {}),
        accessExpiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
        ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
        ...(typeof token.openid === 'string' ? { openid: token.openid } : {}),
      };
      renewCache.set(refreshToken, { at: Date.now(), next });
      return next;
    })().finally(() => renewing.delete(refreshToken));
    renewing.set(refreshToken, pending);
  }
  const next = await pending;
  applyTokens(auth, next);
  return auth.accessToken ?? '';
}

/** 把续期结果写回登录态。 */
function applyTokens(auth: StoredAuth, next: Partial<StoredAuth>): void {
  if (typeof next.accessToken === 'string') auth.accessToken = next.accessToken;
  if (typeof next.refreshToken === 'string') auth.refreshToken = next.refreshToken;
  if (typeof next.accessExpiresAt === 'number') auth.accessExpiresAt = next.accessExpiresAt;
  if (typeof next.scope === 'string') auth.scope = next.scope;
  if (typeof next.openid === 'string') auth.openid = next.openid;
}

/** 按主站挑客户端 id（与 credentials/store 同源，这里避免循环 import）。 */
function clientIdOf(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).hostname.toLowerCase() === 'meoo.com'
      ? 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh'
      : 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE';
  } catch {
    return 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE';
  }
}

/**
 * 保证 access token 新鲜（提前 60 秒续期）。
 * @param auth - 登录态（会被就地更新）。
 * @returns 可用的 access token。
 */
export async function ensureAccessToken(auth: StoredAuth): Promise<string> {
  const expiresAt = typeof auth.accessExpiresAt === 'number' ? auth.accessExpiresAt : 0;
  const access = auth.accessToken;
  if (typeof access === 'string' && access !== '' && expiresAt - REFRESH_EARLY_MS > Date.now()) {
    return access;
  }
  return refreshAccessToken(auth);
}

// ---------------------------------------------------------------------------
// 账号 / 项目 / AK
// ---------------------------------------------------------------------------

/** 控制面身份。 */
export interface MeooIdentity {
  name?: string;
  userId?: string;
  /** 账号的默认项目。 */
  projectUrlId?: string;
}

/**
 * 读账号身份。
 * @param auth - 登录态。
 * @returns 身份（字段可能缺）。
 */
export async function fetchIdentity(auth: StoredAuth): Promise<MeooIdentity> {
  const data = (await controlRequest(auth, 'GET', IDENTITY_PATH)) as Record<string, unknown> | null;
  const record = data ?? {};
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  return {
    ...(str(record.name) === undefined ? {} : { name: str(record.name) as string }),
    ...(str(record.user_id) === undefined && str(record.userId) === undefined
      ? {}
      : { userId: (str(record.user_id) ?? str(record.userId)) as string }),
    ...(str(record.project_url_id) === undefined && str(record.projectUrlId) === undefined
      ? {}
      : { projectUrlId: (str(record.project_url_id) ?? str(record.projectUrlId)) as string }),
  };
}

/** 一个项目。 */
export interface MeooProject {
  urlId: string;
  name: string;
}

/** 重新导出目录类型，调用方不必知道它定义在 catalog.ts。 */
export type { MeooModel } from './catalog.ts';

/**
 * 列项目。
 * @param auth - 登录态。
 * @returns 项目列表（字段缺失的条目丢弃）。
 */
export async function listProjects(auth: StoredAuth): Promise<MeooProject[]> {
  const data = await controlRequest(auth, 'GET', `${PROJECTS_PATH}?page_size=50`);
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const list = Array.isArray(data)
    ? data
    : Array.isArray(record.list)
      ? record.list
      : Array.isArray(record.items)
        ? record.items
        : Array.isArray(record.projects)
          ? record.projects
          : [];
  const projects: MeooProject[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const urlId = row.url_id ?? row.urlId;
    if (typeof urlId !== 'string' || urlId.trim() === '') continue;
    projects.push({
      urlId: urlId.trim(),
      name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : '未命名',
    });
  }
  return projects;
}

/** 新建项目（新账号常常一个项目都没有，没有项目就没有 AK）。 */
export async function createProject(auth: StoredAuth): Promise<MeooProject | undefined> {
  for (const body of [{ name: 'AI 服务' }, {}]) {
    try {
      const data = (await controlRequest(auth, 'POST', PROJECTS_PATH, body)) as Record<string, unknown> | null;
      const record = data ?? {};
      const urlId = record.url_id ?? record.urlId;
      if (typeof urlId === 'string' && urlId.trim() !== '') {
        return { urlId: urlId.trim(), name: typeof record.name === 'string' ? record.name : 'AI 服务' };
      }
    } catch {
      // 换下一种请求体再试。
    }
  }
  return undefined;
}

/**
 * 选一个项目。
 *
 * 优先级：显式指定 > 记录里的 > 身份默认 > 唯一项目 > 自动新建。
 * **多个项目且没有默认值时不替用户做主** —— 计费归属不同，报错并列出可选项
 * 比「猜一个然后扣错项目的额度」好。
 *
 * @param auth - 登录态。
 * @param explicitUrlId - 用户显式指定的项目。
 * @returns 项目 urlId。
 */
export async function pickProject(auth: StoredAuth, explicitUrlId?: string): Promise<string> {
  const explicit = (explicitUrlId ?? '').trim();
  if (explicit !== '') return explicit;
  const remembered = (auth.projectUrlId ?? '').trim();
  if (remembered !== '') return remembered;

  let identityProject = '';
  try {
    identityProject = (await fetchIdentity(auth)).projectUrlId ?? '';
  } catch {
    // 身份读不到不是致命错误：项目列表还能继续走。
  }
  if (identityProject !== '') return identityProject;

  const projects = await listProjects(auth);
  if (projects.length === 0) {
    const created = await createProject(auth);
    if (created === undefined) {
      throw new MeooError('账号下还没有项目，自动创建也失败了：请在 meoo.com 手动建一个项目后重试');
    }
    return created.urlId;
  }
  if (projects.length === 1) return projects[0]!.urlId;

  const options = projects.map((project) => `${project.urlId}（${project.name}）`).join('、');
  throw new MeooError(
    `账号下有多个项目，请在插件设置里指定一个（或用 /meoo project <urlId>）：${options}`,
  );
}

/**
 * 取项目服务 AK；项目没开通云服务时**自动开通一次**再取。
 * @param auth - 登录态。
 * @param projectUrlId - 项目。
 * @returns 项目服务 AK。
 */
export async function resolveServiceAk(auth: StoredAuth, projectUrlId: string): Promise<string> {
  const cached = auth.serviceAk;
  if (
    typeof cached === 'string' &&
    cached !== '' &&
    auth.serviceAkProjectId === projectUrlId
  ) {
    return cached;
  }

  const readAk = (payload: unknown): string => {
    const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const instance = (typeof record.instance === 'object' && record.instance !== null
      ? record.instance
      : {}) as Record<string, unknown>;
    for (const candidate of [record.meooProjectApiKey, instance.meooProjectApiKey]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
    return '';
  };

  let ak = '';
  try {
    ak = readAk(await controlRequest(auth, 'GET', cloudEnvPath(projectUrlId)));
  } catch {
    ak = '';
  }

  let cloudError = '';
  if (ak === '') {
    try {
      await controlRequest(auth, 'POST', cloudPath(projectUrlId), {
        description: 'dsh-connect-meoo: AI 服务',
      });
      ak = readAk(await controlRequest(auth, 'GET', cloudEnvPath(projectUrlId)));
    } catch (error) {
      cloudError = error instanceof Error ? error.message : String(error);
      ak = '';
    }
  }

  if (ak === '') {
    throw new MeooError(
      `项目 ${projectUrlId} 还没开通 Meoo AI 服务：在 meoo.com 打开该项目，在对话框里发一句「帮我开启云服务」` +
        `（或让 AI 加一个需要后端/AI 的功能，平台会自动开通并签发 AK），开通后重试` +
        (cloudError === '' ? '' : `（自动开通失败：${cloudError}）`),
    );
  }
  return ak;
}

// ---------------------------------------------------------------------------
// 积分
// ---------------------------------------------------------------------------

/** 一批积分的明细。 */
export interface PointsGrantDetail {
  /** 这一批还剩多少。 */
  remaining: number;
  /** 这一批的到期日（`YYYY-MM-DD`，上游可能带时间）。 */
  expiresDate: string;
}

/** 积分账户读数。 */
export interface PointsSummary {
  /** 可用余额。 */
  available: number;
  /** 已消耗。 */
  consumed: number;
  /** 冻结中。 */
  frozen: number;
  /** 每一批还没用完的积分。 */
  grants: PointsGrantDetail[];
  /** 最近一批还没用完的积分的到期日（`YYYY-MM-DD`）。 */
  nextExpiry: string | null;
  /** 抓取时刻。 */
  atMs: number;
}

/** 数字兜底（负数/非数当 0）。 */
function nonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * 解析 `/account/points` 的响应。
 * @param payload - 上游 `data`。
 * @param nowMs - 抓取时刻。
 * @returns 积分读数。
 */
export function parsePoints(payload: unknown, nowMs: number = Date.now()): PointsSummary {
  const root = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const account = (typeof root.account === 'object' && root.account !== null
    ? root.account
    : {}) as Record<string, unknown>;

  const grants: PointsGrantDetail[] = [];
  for (const grant of Array.isArray(root.activeGrants) ? root.activeGrants : []) {
    if (typeof grant !== 'object' || grant === null) continue;
    const details = (grant as Record<string, unknown>).grantDetails;
    for (const detail of Array.isArray(details) ? details : []) {
      if (typeof detail !== 'object' || detail === null) continue;
      const row = detail as Record<string, unknown>;
      const remaining = nonNegativeInt(row.remainingAmount);
      const expiresDate = typeof row.expiresDate === 'string' ? row.expiresDate.slice(0, 10) : '';
      if (remaining <= 0 || expiresDate === '') continue;
      grants.push({ remaining, expiresDate });
    }
  }
  grants.sort((a, b) => a.expiresDate.localeCompare(b.expiresDate));

  return {
    available: nonNegativeInt(account.availableBalance),
    consumed: nonNegativeInt(account.totalConsumed),
    frozen: nonNegativeInt(account.frozenBalance),
    grants,
    nextExpiry: grants[0]?.expiresDate ?? null,
    atMs: nowMs,
  };
}

/**
 * 读积分账户（**只读**，不消耗积分）。
 * @param auth - 登录态。
 * @returns 积分读数。
 */
export async function fetchPoints(auth: StoredAuth): Promise<PointsSummary> {
  return parsePoints(await controlRequest(auth, 'GET', POINTS_PATH));
}

// ---------------------------------------------------------------------------
// 网关
// ---------------------------------------------------------------------------

/**
 * 拉网关模型目录。
 * @param ak - 项目服务 AK。
 * @param gatewayBaseUrl - 网关地址（留空用内置）。
 * @returns 目录（可能为空数组）。
 */
export async function fetchGatewayModels(
  ak: string,
  gatewayBaseUrl?: string,
): Promise<MeooModel[]> {
  const base = (gatewayBaseUrl === undefined || gatewayBaseUrl === '' ? GATEWAY_BASE : gatewayBaseUrl).replace(
    /\/+$/,
    '',
  );
  const res = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${ak}`, accept: 'application/json' },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const text = await res.text();
  const json = parseJson(text);
  if (res.status === 401 || res.status === 403) {
    throw new MeooError(`网关拒绝了这个 AK（HTTP ${res.status}）：${vendorMessage(json, text)}`, {
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new MeooError(`模型目录 HTTP ${res.status}：${vendorMessage(json, text)}`, { status: res.status });
  }
  return parseGatewayModels(json);
}

/**
 * 拉官网模型目录（带价格档位 / 说明 / 折扣的那一份）。
 *
 * 为什么不能只用网关 `/models`：它返回的是裸 id 字符串数组，模型选择器里除了
 * 名字什么都没有。官网自己的模型选择器走的是 `/api/v1/agent/models`，
 * 那里才有「便宜 / 适中 / 较贵 / 超贵」四档、一句话说明、夜间折扣与多模态。
 *
 * **鉴权用项目服务 AK**：API Key 打这个路径会 403 `API_KEY_ROUTE_FORBIDDEN`。
 *
 * 失败不抛：目录是「锦上添花」，拿不到就让调用方回退到网关那份裸目录，
 * 绝不能因为展示信息缺失把整个模型选择器弄没。
 *
 * @param serviceAk - 项目服务 AK。
 * @param apiBaseUrl - 主站地址（`https://meoo.com`）。
 * @returns 目录；失败或形状不对时为空数组。
 */
export async function fetchAgentModels(serviceAk: string, apiBaseUrl?: string): Promise<MeooModel[]> {
  const base = (apiBaseUrl === undefined || apiBaseUrl === '' ? API_BASE : apiBaseUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}${AGENT_MODELS_PATH}`, {
      headers: {
        authorization: `Bearer ${serviceAk.trim()}`,
        accept: 'application/json',
        ...CLI_HEADERS,
      },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseAgentModels(parseJson(await res.text()));
  } catch {
    return [];
  }
}

/**
 * 校验一个手填的项目服务 AK（用网关 `/models` 探一次）。
 * @param ak - 候选 AK。
 * @param gatewayBaseUrl - 网关地址。
 * @returns 目录（非空即通过）。
 */
export async function verifyServiceAk(ak: string, gatewayBaseUrl?: string): Promise<MeooModel[]> {
  const trimmed = ak.trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
  if (trimmed === '') throw new MeooError('请填写项目服务 AK');
  if (trimmed.startsWith('meoo_ak_')) {
    throw new MeooError(
      '这是用户 Key（meoo_ak_…），不是项目服务 AK；请填 meoo_project_service_v1. 开头的项目服务 AK',
    );
  }
  const models = await fetchGatewayModels(trimmed, gatewayBaseUrl);
  if (models.length === 0) {
    throw new MeooError('网关返回了空目录：这个 AK 可能属于一个还没开通 AI 服务的项目');
  }
  return models;
}
