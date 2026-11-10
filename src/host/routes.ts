/**
 * 宿主 HTTP 路由：`/plugins/dsh-connect-meoo/status` 与 `/action`。
 *
 * 为什么需要这两条路由而不是让页面直接问上游：access token 与项目服务 AK
 * **不能进页面**。页面能拿到的只有已经归一好的展示数据，以及一个受白名单
 * 约束的动作入口。
 *
 * 安全边界（三重）：
 * 1. 只接受**回环** Host 头 —— 这个服务器可能绑在 0.0.0.0 上（用户自己配的），
 *    此时同一网段的机器也能发请求；Host 头是唯一能便宜判断「这是本机」的信号。
 * 2. 动作走**白名单**：页面只能做下面 7 件事，不能借这条路由去打上游任意接口。
 * 3. 请求体上限 64 KiB，坏 JSON 当空对象 —— 这条路由只收小的开关 payload。
 *
 * @module dsh-connect-meoo/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 状态路由（浏览器半侧硬编码，改这里必须同步改 `src/client/bundle.js`）。 */
export const STATUS_PATH = '/plugins/dsh-connect-meoo/status';
/** 动作路由（同上）。 */
export const ACTION_PATH = '/plugins/dsh-connect-meoo/action';

/** 浏览器能触发的动作白名单。 */
export type MeooAction =
  | 'refresh' // 重拉目录/积分/项目，写回缓存
  | 'login' // 拉起浏览器让用户授权一次
  | 'login-code' // 手动提交授权码（浏览器回调打不通时的兜底）
  | 'logout' // 清本插件保存的登录态
  | 'settings' // 改插件状态（body 为 Partial<MeooPluginState> 的子集）
  | 'project' // 换项目（body 为 { projectUrlId }）
  | 'apikey' // 手填控制面 API Key（body 为 { apiKey }），自动换出项目服务 AK
  | 'ak' // 手填项目服务 AK（body 为 { serviceAk }）
  | 'test-model'; // 测单个模型此刻可用性（body 为 { modelId }，会真实花钱）

/** 动作白名单（路由层校验用，与类型同源）。 */
const ACTIONS: readonly MeooAction[] = [
  'refresh',
  'login',
  'login-code',
  'logout',
  'settings',
  'project',
  'apikey',
  'ak',
  'test-model',
];

/** 请求体上限：这条路由只收开关，不该有更大的东西。 */
const MAX_BODY_BYTES = 64 * 1024;

/** webServer 注册项的最小形状。 */
export interface WebServerEntry {
  kind: 'exact';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** webServer 服务的最小形状（只用到 register）。 */
export interface WebServerLike {
  register(entry: WebServerEntry): () => void;
}

/** `ctx.inject` 的最小形状。 */
export interface RoutesHost {
  inject(
    services: readonly string[],
    callback: (webCtx: {
      effect: (fn: () => () => void) => void;
      webServer: WebServerLike;
    }) => void,
  ): void;
}

/** 路由依赖：业务逻辑全部由调用方注入，便于单测。 */
export interface RouteDeps {
  /** 构建最新状态文档（可以发网络，调用方负责缓存）。 */
  status: () => Promise<unknown>;
  /** 执行动作；返回给浏览器的结果。 */
  action: (action: MeooAction, body: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 判断 Host 头是不是本机。
 *
 * `127.0.0.0/8` 的任意地址、`localhost`、`[::1]` / `::1` 都算；
 * 其余一律不算（宁可误拒，不可误放）。
 *
 * @param host - `Host` 头原值（可能带端口）。
 * @returns 本机为 true。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '') return false;
  // 裸 IPv6 先判：`::1` 里也有 `:1`，先剥端口会把它剥成 `:`。
  if (trimmed === '::1') return true;
  const name = trimmed.replace(/:\d+$/, '');
  if (name === 'localhost' || name === '[::1]' || name === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (ipv4 === null) return false;
  // 127.0.0.0/8：整个回环网段，不只有 127.0.0.1。
  return Number(ipv4[1]) === 127;
}

/** 写一个 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读请求体，超上限就截断（不 413：这条路由的 body 只是开关，截断足够安全）。 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      chunks.push(buffer.subarray(0, Math.max(0, buffer.length - (size - MAX_BODY_BYTES))));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 body：坏 JSON 当空对象。 */
function parseBody(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 注册两条路由。
 *
 * 用 `ctx.inject(['webServer'], ...)` 而不是硬依赖：没有 webserver 的组合里
 * （例如纯 CLI）插件照样该能把模型接进 llm，只是没有卡片。`inject` 的回调
 * 在服务出现时才跑，服务被替换时 Cordis 会重放它。
 *
 * @param ctx - 提供 `inject` 的宿主。
 * @param deps - 状态与动作的实现。
 */
export function registerRoutes(ctx: RoutesHost, deps: RouteDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: async (req, res) => {
          if (!isLoopbackHost(req.headers.host)) {
            sendJson(res, 403, { error: 'loopback only' });
            return;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'GET only' });
            return;
          }
          try {
            sendJson(res, 200, await deps.status());
          } catch (error) {
            // 只回消息，不回堆栈：这条响应可能被整段贴进 issue。
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: ACTION_PATH,
        handler: async (req, res) => {
          if (!isLoopbackHost(req.headers.host)) {
            sendJson(res, 403, { error: 'loopback only' });
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' });
            return;
          }
          let action = '';
          let body: Record<string, unknown> = {};
          try {
            action = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('action') ?? '';
            body = parseBody(await readBody(req));
          } catch {
            // 读不出来就当空动作，下面统一报「未知操作」。
          }
          if (!ACTIONS.includes(action as MeooAction)) {
            sendJson(res, 200, { ok: false, error: `未知操作: ${action}` });
            return;
          }
          try {
            sendJson(res, 200, await deps.action(action as MeooAction, body));
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    );
  });
}
