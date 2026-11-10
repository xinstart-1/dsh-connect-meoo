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

/** 落盘的登录态。 */
export interface StoredAuth {
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

/**
 * 归一化任意形状的登录态（兼容 dsh-meoo-connect 的字段名）。
 * @param raw - 读到的对象。
 * @returns 合法登录态。
 */
export function normalizeAuth(raw: unknown): StoredAuth {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_AUTH };
  const record = raw as Record<string, unknown>;
  return {
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
  const merged = { ...previous, ...stripUndefined(auth) };
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  // rename 保留的是临时文件的权限；显式再设一次，Windows 上无害、POSIX 上是保险。
  await chmod(file, 0o600).catch(() => undefined);
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
