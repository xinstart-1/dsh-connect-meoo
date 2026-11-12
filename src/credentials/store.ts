/**
 * 登录态：OAuth(PKCE) + 本机登录态复用 + 手填 AK 的持久化。
 *
 * 三条来源，按用户成本排序（与 `dsh-connect-lingxi` 同一套排序理由）：
 *
 * 1. **手填 AK** —— 用户显式填了就该听他的，但它排最后不是因为它差，而是因为它
 *    需要用户自己去 meoo.com 项目 → 云服务里复制。
 * 2. **复用本机登录态** —— `dsh-meoo-connect` 的 `$DSH_HOME/meoo/state.json` 与
 *    `meoo-proxy` 的 `~/.meoo-proxy/config.json`，**严格只读**，一个字节都不写回。
 * 3. **浏览器授权** —— PKCE public client + 本机 loopback 回调，用户点一次「授权」。
 *    这是唯一能拿到积分账户的路径（手填 AK 读不到 `/account/points`）。
 *
 * 落盘位置刻意与 `dsh-meoo-connect` 相同（`$DSH_HOME/meoo/state.json`）：
 * 两个插件都装的时候共享一份登录态，谁刷新了 token 另一边都能用。
 * 但**只写自己的字段**，不认识的字段原样保留（未来版本降级不丢数据）。
 *
 * @module dsh-connect-meoo/credentials/store
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  API_BASE,
  AUTH_DIRNAME,
  AUTH_FILENAME,
  CALLBACK_PATH,
  CLIENT_ID_PROD,
  CLIENT_ID_TEST,
  LOGIN_TIMEOUT_MS,
  OAUTH_SCOPE,
  REFRESH_EARLY_MS,
  REFRESH_REUSE_MS,
} from '../constants.ts';

/**
 * 一份可切换的令牌。
 *
 * 为什么把每个字段都列全而不是只存 `apiKey`：切换令牌不只是换一行 Bearer ——
 * 项目、项目服务 AK、账号名、积分归属都跟着变。把「跟这个令牌绑定的事实」
 * 一起存，切过去就能立刻发请求，不用再等一轮身份/项目解析。
 *
 * `id` 一旦落盘就不再变（OAuth 续期换了 token 也认同一个 id）；UI 只拿它做
 * 选择，不拿它当凭据。
 */
export interface StoredCredential {
  id: string;
  /** `apikey` 只有控制面 API Key；`oauth` 才有 access/refresh token。 */
  kind: 'apikey' | 'oauth';
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessExpiresAt?: number;
  scope?: string | null;
  openid?: string | null;
  username?: string | null;
  userId?: string | null;
  projectUrlId?: string | null;
  serviceAk?: string | null;
  serviceAkProjectId?: string | null;
  /** 加进列表的时刻（ms）。 */
  savedAt: number;
}

/** 落盘的登录态。 */
export interface StoredAuth {
  /**
   * 多令牌列表。
   *
   * 旧文件没有这个字段：读到旧文件时按「一个令牌」迁移（见 {@link normalizeAuth}），
   * 下次写入才落成新形状。这样降级回旧版本时，顶层 `apiKey` / `accessToken`
   * 仍然指向当前令牌，`dsh-meoo-connect` 也还能读。
   */
  credentials?: StoredCredential[];
  /** 当前生效的令牌 id；没有令牌时为 null。 */
  activeId?: string | null;
  /** 登录用的主站（续期与控制面都打它）。 */
  apiBaseUrl: string;
  /** 网关地址（跟着账号走，方便换测试环境）。 */
  gatewayBaseUrl?: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  /**
   * 控制面 API Key（`meoo_ak_…`）。
   *
   * 它和 OAuth token 是**同一层**的东西：都作控制面 `Authorization: Bearer`，
   * 都能读身份 / 项目 / 积分 / 套餐。区别是 API Key 不需要续期、不会过期，
   * 也不能用来调模型网关（网关只认项目服务 AK）。
   *
   * 有了它，「取项目服务 AK」这件事就不必先走浏览器授权 —— 这是本插件
   * 成本最低的一条路：贴一个 key，其余全自动。
   */
  apiKey?: string | null;
  /** access token 到期的绝对时间（ms）。 */
  accessExpiresAt?: number;
  scope?: string | null;
  openid?: string | null;
  /** 展示名（控制面 `identity.name`）。 */
  username?: string | null;
  userId?: string | null;
  /** 选中的项目。 */
  projectUrlId?: string | null;
  /** 项目服务 AK（网关 Bearer）。 */
  serviceAk?: string | null;
  /** 上面那个 AK 属于哪个项目（换项目必须重取，不能复用）。 */
  serviceAkProjectId?: string | null;
  /** 上次同步时刻。 */
  lastSyncAt?: number;
  /** 上次错误原文（诊断用）。 */
  lastError?: string | null;
}

/** 空登录态。 */
export const EMPTY_AUTH: StoredAuth = Object.freeze({
  apiBaseUrl: API_BASE,
}) as StoredAuth;

/**
 * DSH home。
 * @param env - 环境变量（测试注入）。
 * @returns 绝对路径。
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh');
}

/**
 * 登录态文件路径。
 * @param env - 环境变量（测试注入）。
 * @returns 绝对路径。
 */
export function authFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), AUTH_DIRNAME, AUTH_FILENAME);
}

/**
 * `meoo-proxy` 的配置文件路径。
 * @param env - 环境变量（测试注入）。
 * @returns 绝对路径。
 */
export function proxyConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    typeof env.MEOO_PROXY_HOME === 'string' && env.MEOO_PROXY_HOME.length > 0
      ? env.MEOO_PROXY_HOME
      : join(homedir(), '.meoo-proxy');
  return join(home, 'config.json');
}

/** 读一个 JSON 文件；不存在或坏 JSON 都返回 undefined（永不抛）。 */
async function readJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 归一化一份令牌；一个凭据都没有时返回 undefined。 */
function normalizeCredential(raw: unknown, fallbackId: string): StoredCredential | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const apiKey = stringOrNull(record.apiKey);
  const accessToken = stringOrNull(record.accessToken);
  const refreshToken = stringOrNull(record.refreshToken);
  if (apiKey === null && accessToken === null && refreshToken === null) return undefined;

  // 有 access/refresh 就是 OAuth；只有 apiKey 就是 API Key。显式 kind 优先，
  // 因为一次失败的 OAuth 续期可能只剩 refreshToken（仍然是 OAuth 槽位）。
  const kind: StoredCredential['kind'] =
    record.kind === 'oauth' || record.kind === 'apikey'
      ? record.kind
      : accessToken === null && refreshToken === null
        ? 'apikey'
        : 'oauth';

  return {
    id: stringOrNull(record.id) ?? fallbackId,
    kind,
    apiKey,
    accessToken,
    refreshToken,
    accessExpiresAt: numberOr(record.accessExpiresAt, 0),
    scope: stringOrNull(record.scope),
    openid: stringOrNull(record.openid),
    username: stringOrNull(record.username),
    userId: stringOrNull(record.userId),
    projectUrlId: stringOrNull(record.projectUrlId),
    serviceAk: stringOrNull(record.serviceAk),
    serviceAkProjectId: stringOrNull(record.serviceAkProjectId),
    savedAt: numberOr(record.savedAt, 0),
  };
}

/**
 * 把一份令牌的字段铺到顶层。
 *
 * 顶层字段是**当前令牌的镜像**：运行时的全部逻辑（读积分、解析 AK、发请求）
 * 仍然只认顶层，不需要知道多令牌列表存在。切令牌 = 换一份镜像。
 */
function applyCredential(auth: StoredAuth, credential: StoredCredential): StoredAuth {
  return {
    ...auth,
    apiKey: credential.apiKey ?? null,
    accessToken: credential.accessToken ?? null,
    refreshToken: credential.refreshToken ?? null,
    accessExpiresAt: credential.accessExpiresAt ?? 0,
    scope: credential.scope ?? null,
    openid: credential.openid ?? null,
    username: credential.username ?? null,
    userId: credential.userId ?? null,
    projectUrlId: credential.projectUrlId ?? null,
    serviceAk: credential.serviceAk ?? null,
    serviceAkProjectId: credential.serviceAkProjectId ?? null,
    credentials: auth.credentials,
    activeId: credential.id,
  };
}

/** 从顶层字段造一份令牌（旧单令牌文件迁移用）。 */
function credentialFromAuth(auth: StoredAuth, id: string): StoredCredential | undefined {
  const apiKey = stringOrNull(auth.apiKey);
  const accessToken = stringOrNull(auth.accessToken);
  const refreshToken = stringOrNull(auth.refreshToken);
  if (apiKey === null && accessToken === null && refreshToken === null) return undefined;
  return {
    id,
    kind: apiKey !== null ? 'apikey' : 'oauth',
    apiKey,
    accessToken,
    refreshToken,
    accessExpiresAt: typeof auth.accessExpiresAt === 'number' ? auth.accessExpiresAt : 0,
    scope: auth.scope ?? null,
    openid: auth.openid ?? null,
    username: auth.username ?? null,
    userId: auth.userId ?? null,
    projectUrlId: auth.projectUrlId ?? null,
    serviceAk: auth.serviceAk ?? null,
    serviceAkProjectId: auth.serviceAkProjectId ?? null,
    savedAt: typeof auth.lastSyncAt === 'number' ? auth.lastSyncAt : 0,
  };
}

/**
 * 归一化任意形状的登录态（兼容 dsh-meoo-connect 的字段名与旧单令牌文件）。
 * @param raw - 读到的对象。
 * @returns 合法登录态。
 */
export function normalizeAuth(raw: unknown): StoredAuth {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_AUTH };
  const record = raw as Record<string, unknown>;
  const base: StoredAuth = {
    apiBaseUrl: stringOrNull(record.apiBaseUrl) ?? stringOrNull(record.apiBase) ?? API_BASE,
    ...(stringOrNull(record.gatewayBaseUrl) === null
      ? {}
      : { gatewayBaseUrl: stringOrNull(record.gatewayBaseUrl) as string }),
    accessToken: stringOrNull(record.accessToken),
    refreshToken: stringOrNull(record.refreshToken),
    apiKey: stringOrNull(record.apiKey),
    accessExpiresAt: numberOr(record.accessExpiresAt, 0),
    scope: stringOrNull(record.scope),
    openid: stringOrNull(record.openid),
    username: stringOrNull(record.username),
    userId: stringOrNull(record.userId),
    projectUrlId: stringOrNull(record.projectUrlId),
    serviceAk: stringOrNull(record.serviceAk),
    serviceAkProjectId: stringOrNull(record.serviceAkProjectId),
    lastSyncAt: numberOr(record.lastSyncAt, 0),
    lastError: stringOrNull(record.lastError),
  };

  const list: StoredCredential[] = [];
  for (const entry of Array.isArray(record.credentials) ? record.credentials : []) {
    const credential = normalizeCredential(entry, `cred_${String(list.length + 1)}`);
    if (credential !== undefined && !list.some((item) => item.id === credential.id)) {
      list.push(credential);
    }
  }

  if (list.length > 0) {
    const wanted = stringOrNull(record.activeId);
    const active = list.find((item) => item.id === wanted) ?? list[0]!;
    return applyCredential({ ...base, credentials: list }, active);
  }

  // 旧文件：一个顶层凭证。迁移成「一个令牌」的列表，id 固定为 cred_legacy，
  // 这样在第一次写入之前，界面上看到的选择项不会每次读盘都换一个 id。
  const legacy = credentialFromAuth(base, 'cred_legacy');
  if (legacy !== undefined) return { ...base, credentials: [legacy], activeId: legacy.id };
  return base;
}

/** 读一份令牌列表；旧登录态（没有列表）按一条迁移。 */
export function tokensOf(auth: StoredAuth): StoredCredential[] {
  if (Array.isArray(auth.credentials)) return auth.credentials;
  const legacy = credentialFromAuth(auth, 'cred_legacy');
  return legacy === undefined ? [] : [legacy];
}

/** 随机令牌 id（只用于选择，不作凭据）。 */
export function newCredentialId(): string {
  return `cred_${randomBytes(6).toString('hex')}`;
}

/**
 * 新增或更新一份令牌，并把它设为当前令牌。
 *
 * 去重键按类型不同：API Key 用 key 本身（同一个 key 重复粘贴不该多一项），
 * OAuth 用 openid / userId（续期换了 access token 仍是同一个账号）。
 *
 * @param auth - 当前登录态。
 * @param input - 令牌字段（id 可省略）。
 * @returns 更新后的登录态（当前令牌 = 传入的这份）。
 */
export function upsertToken(
  auth: StoredAuth,
  input: Omit<StoredCredential, 'savedAt' | 'id'> & { id?: string; savedAt?: number },
): StoredAuth {
  const list = [...tokensOf(auth)];
  const apiKey = stringOrNull(input.apiKey);
  const accessToken = stringOrNull(input.accessToken);
  const refreshToken = stringOrNull(input.refreshToken);
  const openid = stringOrNull(input.openid);
  const userId = stringOrNull(input.userId);
  const index = list.findIndex((item) => {
    if (input.id !== undefined && input.id !== '' && item.id === input.id) return true;
    // 只在同一种令牌内去重：同一个账号的 API Key 与 OAuth token 是**两份能力不同**
    // 的凭据（OAuth 能领每日积分，API Key 不能），不能因为 userId 相同就互相覆盖。
    if (input.kind === 'apikey') {
      return item.kind === 'apikey' && apiKey !== null && stringOrNull(item.apiKey) === apiKey;
    }
    if (item.kind !== 'oauth') return false;
    if (accessToken !== null && stringOrNull(item.accessToken) === accessToken) return true;
    if (refreshToken !== null && stringOrNull(item.refreshToken) === refreshToken) return true;
    return (openid !== null && item.openid === openid) || (userId !== null && item.userId === userId);
  });
  const existing = index >= 0 ? list[index] : undefined;
  const credential: StoredCredential = {
    ...existing,
    ...input,
    id: existing?.id ?? (input.id !== undefined && input.id !== '' ? input.id : newCredentialId()),
    savedAt: existing?.savedAt !== undefined && existing.savedAt > 0 ? existing.savedAt : (input.savedAt ?? Date.now()),
    apiKey,
    accessToken,
    refreshToken,
    accessExpiresAt: typeof input.accessExpiresAt === 'number' ? input.accessExpiresAt : 0,
    scope: stringOrNull(input.scope),
    openid,
    userId,
    projectUrlId: stringOrNull(input.projectUrlId),
    serviceAk: stringOrNull(input.serviceAk),
    serviceAkProjectId: stringOrNull(input.serviceAkProjectId),
    username: stringOrNull(input.username),
  };
  if (index >= 0) list[index] = credential;
  else list.push(credential);
  return applyCredential({ ...auth, credentials: list }, credential);
}

/** 切换到一份已保存的令牌；id 不存在时原样返回。 */
export function activateToken(auth: StoredAuth, id: string): StoredAuth {
  const list = tokensOf(auth);
  const credential = list.find((item) => item.id === id);
  if (credential === undefined) return auth;
  return applyCredential({ ...auth, credentials: list }, credential);
}

/** 清空登录态，但保留主站地址。 */
export function clearAuth(auth: StoredAuth): StoredAuth {
  return {
    apiBaseUrl: auth.apiBaseUrl,
    ...(auth.gatewayBaseUrl === undefined ? {} : { gatewayBaseUrl: auth.gatewayBaseUrl }),
    apiKey: null,
    accessToken: null,
    refreshToken: null,
    accessExpiresAt: 0,
    scope: null,
    openid: null,
    username: null,
    userId: null,
    projectUrlId: null,
    serviceAk: null,
    serviceAkProjectId: null,
    lastSyncAt: 0,
    lastError: null,
    credentials: [],
    activeId: null,
  };
}

/** 删除一份令牌；删的是当前令牌时顺位切到第一份，列表空了就清空登录态。 */
export function removeToken(auth: StoredAuth, id: string): StoredAuth {
  const list = tokensOf(auth).filter((item) => item.id !== id);
  if (list.length === 0) return clearAuth(auth);
  const active = list.find((item) => item.id === auth.activeId) ?? list[0]!;
  return applyCredential({ ...auth, credentials: list }, active);
}

/** 给浏览器看的令牌摘要（**不含**任何完整凭据）。 */
export interface CredentialSummary {
  id: string;
  kind: 'apikey' | 'oauth';
  /** 展示名：账号名优先，否则用一个脱敏标签。 */
  name: string;
  /** 脱敏后的凭据（只留可辨认的前缀与末 4 位）。 */
  masked: string;
  active: boolean;
  savedAt: number;
  hasServiceAk: boolean;
}

/** 脱敏：API Key 保留 `meoo_ak_…` 与末 4 位；OAuth 只留末 4 位。 */
export function maskToken(value: string | null | undefined): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token === '') return '—';
  const tail = token.length > 4 ? token.slice(-4) : '';
  if (token.startsWith('meoo_ak_')) return `meoo_ak_…${tail}`;
  if (token.startsWith('meoo_project_service_v1.')) return `service_ak_…${tail}`;
  return `…${tail}`;
}

/**
 * 列出令牌摘要。
 * @param auth - 登录态。
 * @returns 摘要（当前令牌 `active=true`）。
 */
export function listTokens(auth: StoredAuth): CredentialSummary[] {
  const list = tokensOf(auth);
  return list.map((item) => {
    const masked = item.kind === 'apikey' ? maskToken(item.apiKey) : maskToken(item.accessToken ?? item.refreshToken);
    return {
      id: item.id,
      kind: item.kind,
      name: item.username !== null && item.username !== undefined && item.username !== '' ? item.username : masked,
      masked,
      active: item.id === (auth.activeId ?? (list.length === 1 ? list[0]!.id : '')),
      savedAt: item.savedAt,
      hasServiceAk: stringOrNull(item.serviceAk) !== null,
    };
  });
}

/**
 * 判断一段凭证是不是控制面 API Key。
 *
 * `meoo_ak_…` 是用户 Key（控制面），`meoo_project_service_v1.…` 是项目服务 AK
 * （网关）。两者长得像但用途完全不同，混填的代价是一个 401 + 一句「格式非法」。
 *
 * @param value - 用户输入的凭证。
 * @returns 是 API Key 为 true。
 */
export function isApiKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith('meoo_ak_');
}

/**
 * 判断一段凭证是不是项目服务 AK。
 * @param value - 用户输入的凭证。
 * @returns 是项目服务 AK 为 true。
 */
export function isServiceAk(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith('meoo_project_service_v1.');
}

/**
 * 读本插件自己的登录态。
 * @param env - 环境变量（测试注入）。
 * @returns 登录态（不存在时为 {@link EMPTY_AUTH} 的副本）。
 */
export async function readAuth(env: NodeJS.ProcessEnv = process.env): Promise<StoredAuth> {
  const raw = await readJsonFile(authFile(env));
  return raw === undefined ? { ...EMPTY_AUTH } : normalizeAuth(raw);
}

/**
 * 写登录态（原子替换，权限 0o600）。
 *
 * **保留文件里不认识的字段**：`dsh-meoo-connect` 与 `meoo-proxy` 可能也读写同一份
 * 或相邻的文件，降级回旧版本时不该因为少了一个字段就丢掉整份登录态。
 *
 * @param auth - 要写的登录态。
 * @param env - 环境变量（测试注入）。
 */
export async function writeAuth(
  auth: StoredAuth,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = authFile(env);
  const previous = (await readJsonFile(file)) ?? {};
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const merged = { ...previous, ...stripUndefined(syncActiveToken(auth)) };
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  // rename 保留的是临时文件的权限；显式再设一次，Windows 上无害、POSIX 上是保险。
  await chmod(file, 0o600).catch(() => undefined);
}

/**
 * 写盘前把顶层镜像同步回当前令牌。
 *
 * 运行时会就地改顶层字段（续期换 token、解析出新的 serviceAk），如果不同步，
 * 切走再切回来就会拿到一份旧 AK。
 */
function syncActiveToken(auth: StoredAuth): StoredAuth {
  if (!Array.isArray(auth.credentials)) return auth;
  if (auth.credentials.length === 0) return { ...auth, activeId: null };
  const activeId = auth.activeId ?? auth.credentials[0]!.id;
  const credentials = auth.credentials.map((item) =>
    item.id === activeId
      ? {
          ...item,
          apiKey: auth.apiKey ?? null,
          accessToken: auth.accessToken ?? null,
          refreshToken: auth.refreshToken ?? null,
          accessExpiresAt: typeof auth.accessExpiresAt === 'number' ? auth.accessExpiresAt : 0,
          scope: auth.scope ?? null,
          openid: auth.openid ?? null,
          username: auth.username ?? null,
          userId: auth.userId ?? null,
          projectUrlId: auth.projectUrlId ?? null,
          serviceAk: auth.serviceAk ?? null,
          serviceAkProjectId: auth.serviceAkProjectId ?? null,
        }
      : item,
  );
  return { ...auth, activeId, credentials };
}

/** 去掉值为 undefined 的键（JSON 里它们本来也会消失，但合并前去掉更直观）。 */
function stripUndefined(auth: StoredAuth): Record<string, unknown> {
  return Object.fromEntries(Object.entries(auth).filter(([, v]) => v !== undefined));
}

/**
 * 只读复用本机已有的 Meoo 登录态。
 *
 * 两个来源：本插件的 `$DSH_HOME/meoo/state.json`（也是 `dsh-meoo-connect` 的位置，
 * 优先）与 `meoo-proxy` 的 `~/.meoo-proxy/config.json`。缺的字段互相填。
 *
 * **严格只读**：调用方拿到的是副本，写回只走 {@link writeAuth} 写我们自己的文件。
 *
 * @param env - 环境变量（测试注入）。
 * @returns 合并后的登录态，或 undefined（本机没有任何 Meoo 登录态）。
 */
export async function readLocalLogin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredAuth | undefined> {
  const own = await readJsonFile(authFile(env));
  const proxy = await readJsonFile(proxyConfigFile(env));
  if (own === undefined && proxy === undefined) return undefined;

  const pick = (key: string): unknown => {
    const fromOwn = own?.[key];
    if (fromOwn !== undefined && fromOwn !== null && fromOwn !== '') return fromOwn;
    return proxy?.[key];
  };

  const merged = normalizeAuth({
    apiBaseUrl: pick('apiBaseUrl') ?? pick('apiBase'),
    gatewayBaseUrl: pick('gatewayBaseUrl'),
    accessToken: pick('accessToken'),
    refreshToken: pick('refreshToken'),
    accessExpiresAt: pick('accessExpiresAt') ?? pick('expires'),
    scope: pick('scope'),
    openid: pick('openid'),
    username: pick('username'),
    userId: pick('userId'),
    projectUrlId: pick('projectUrlId'),
    serviceAk: pick('serviceAk'),
    serviceAkProjectId: pick('serviceAkProjectId'),
    lastSyncAt: pick('lastSyncAt'),
    lastError: pick('lastError'),
  });

  if (merged.refreshToken === null && merged.serviceAk === null) return undefined;
  return merged;
}

// ---------------------------------------------------------------------------
// OAuth（Authorization Code + PKCE，public client，走本机 loopback）
// ---------------------------------------------------------------------------

/** 按主站挑客户端 id。 */
export function clientIdFor(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).hostname.toLowerCase() === 'meoo.com' ? CLIENT_ID_PROD : CLIENT_ID_TEST;
  } catch {
    return CLIENT_ID_TEST;
  }
}

/** OAuth token 端点响应（字段名遵循 RFC 6749）。 */
export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  openid?: string;
  error?: string;
  error_description?: string;
}

/**
 * 换票。
 * @param apiBaseUrl - 主站。
 * @param params - 表单参数。
 * @returns token 响应。
 */
export async function tokenRequest(
  apiBaseUrl: string,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: TokenResponse = {};
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    /* 非 JSON 错误体，下面统一报状态码 */
  }
  if (!res.ok) {
    throw new Error(
      `OAuth 换票失败 HTTP ${res.status}: ${json.error ?? text.slice(0, 160)}`,
    );
  }
  return json;
}

/** 一次浏览器授权的句柄。 */
export interface LoginSession {
  /**
   * 把用户送过去的授权页 URL。
   *
   * 它是 Promise 而不是字符串，因为回调端口要等 `listen` 完成才知道端口号；
   * 调用方 `await` 它之后再打开浏览器，顺序才是对的。
   */
  ready: Promise<string>;
  /** 用户点完「授权」后 resolve 成登录态。 */
  done: Promise<StoredAuth>;
  /** 放弃这次登录（关端口）。 */
  cancel: () => void;
  /**
   * 手动提交授权码。
   *
   * 存在的理由：浏览器回调走不通时（本机代理拦了 127.0.0.1、浏览器在别的
   * 环境里、页面被关掉了），整条登录就卡死到超时。用户其实**能看到**地址栏里
   * 那个带 `code=` 的回调地址 —— 把它贴回来就能接着走，不必重来。
   *
   * @param codeOrUrl - 授权码本身，或整个回调 URL（自动取 `code`）。
   * @returns 是否被接受（重复提交 / 空值返回 false）。
   */
  submitCode: (codeOrUrl: string) => boolean;
}

/** 从「授权码或回调 URL」里取出 code。 */
export function extractAuthorizationCode(value: string): string | undefined {
  const text = value.trim();
  if (text === '') return undefined;
  // 裸 code：OAuth 的授权码是 URL-safe 的，不含 ? & / 空格。
  if (!/[?&\s]/.test(text) && !text.includes('/')) return text;
  try {
    const url = new URL(text);
    const code = url.searchParams.get('code');
    return code === null || code === '' ? undefined : code;
  } catch {
    return undefined;
  }
}

/**
 * 启动一次浏览器授权。
 *
 * 只在用户点了「登录」时走这条路 —— 它会弹浏览器窗口，不该在后台自动发生。
 * 回调端口用 `127.0.0.1:0`（随机端口）而不是固定端口：固定端口在别的软件占用时
 * 会让登录**永远**失败，而随机端口最坏情况只是这一次失败。
 *
 * @param options - 主站与超时。
 * @returns 授权句柄。
 */
export function startLogin(options: {
  apiBaseUrl?: string;
  timeoutMs?: number;
  /** 拿到 token 后要做的事（解析身份/项目/AK）；失败即登录失败。 */
  onToken: (auth: StoredAuth) => Promise<StoredAuth>;
}): LoginSession {
  const apiBaseUrl = (options.apiBaseUrl ?? API_BASE).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const clientId = clientIdFor(apiBaseUrl);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  let redirectUri = '';
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let server: Server | undefined;
  let resolveAuth: (auth: StoredAuth) => void = () => undefined;
  let rejectAuth: (error: Error) => void = () => undefined;

  const finish = (result: StoredAuth | Error): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    // 端口必须关：每试一次登录残留一个监听，用户多点几次就会撞端口上限。
    server?.close();
    if (result instanceof Error) rejectAuth(result);
    else resolveAuth(result);
  };

  /** 拿授权码换票并收尾。回调与「手动贴回调 URL」共用这一条路。 */
  let exchange: (code: string) => Promise<void> = async () => undefined;
  exchange = async (code: string): Promise<void> => {
    try {
      const token = await tokenRequest(apiBaseUrl, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const auth: StoredAuth = {
        apiBaseUrl,
        accessToken: token.access_token ?? null,
        refreshToken: token.refresh_token ?? null,
        accessExpiresAt: Date.now() + numberOr(token.expires_in, 3600) * 1000,
        scope: token.scope ?? null,
        openid: token.openid ?? null,
      };
      if (auth.accessToken === null) throw new Error('OAuth 响应里没有 access_token');
      finish(await options.onToken(auth));
    } catch (error_: unknown) {
      finish(error_ instanceof Error ? error_ : new Error(String(error_)));
    }
  };

  const done = new Promise<StoredAuth>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (status: number, text: string): void => {
        res.writeHead(status, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'",
        });
        res.end(text);
      };
      if (url.pathname !== CALLBACK_PATH) {
        reply(404, 'Not Found');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        reply(400, 'state 校验失败：这个回调不属于本次登录，请回到 DSH 重新点一次登录。');
        return;
      }
      const error = url.searchParams.get('error');
      if (error !== null) {
        reply(400, '授权被取消，可以关闭这个页面。');
        finish(new Error(`${error}: ${url.searchParams.get('error_description') ?? ''}`));
        return;
      }
      const code = url.searchParams.get('code');
      if (code === null || code === '') {
        reply(400, '回调里缺少授权码，请回到 DSH 重新点一次登录。');
        return;
      }
      // 先回页面再换票：换票可能几百毫秒，让用户看到「成功」而不是转圈。
      reply(200, '秒悟 Meoo 授权成功，可以关闭这个页面回到 DSH。');
      void exchange(code);
    });
    server.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
  // 调用方可能只 await `ready`（端口起不来就放弃），此时 `done` 没人接；
  // 不挂一个空 catch 会在 Node 22 上报 unhandled rejection。
  done.catch(() => undefined);

  /** 端口就绪后拼授权 URL。 */
  const ready = new Promise<string>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const authorize = new URL('/oauth/authorize', apiBaseUrl);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('scope', OAUTH_SCOPE);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      resolve(authorize.toString());
    });
    // 起端口失败时立刻收尾，不要白等 10 分钟。
    server!.once('error', (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  ready.catch(() => undefined);

  // 超时兜底：用户关掉浏览器就走了，不设上限会永远挂着一个监听。
  timer = setTimeout(() => finish(new Error('浏览器授权等待超时（10 分钟），请重试')), timeoutMs);
  timer.unref?.();

  return {
    ready,
    done,
    cancel: () => finish(new Error('登录已取消')),
    submitCode: (codeOrUrl: string): boolean => {
      if (settled) return false;
      const code = extractAuthorizationCode(codeOrUrl);
      if (code === undefined) return false;
      void exchange(code);
      return true;
    },
  };
}
