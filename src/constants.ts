/**
 * 秒悟 Meoo 协议常量。
 *
 * 每个值都对应一处实测或上游代码取证，来源见 `docs/PROTOCOL.md`：
 * - OAuth / 控制面：`dsh-meoo-connect`（MIT）与 `@fish-under-sea/opencode-meoo-auth`（MIT）
 *   两个上游实现的同一条链路，2026-11 本机复测端点存在（401 而非 404）。
 * - 网关模型目录：`GET {gateway}/models`，Bearer 项目服务 AK。
 *
 * @module dsh-connect-meoo/constants
 */

/** DSH provider 路由键；同时是 pi-ai collection 的 key。 */
export const PROVIDER = 'meoo';

/** 插件版本号（卡片与日志显示）。与 package.json 的 version 保持一致。 */
export const VERSION = '0.0.5';

/** 设置页命名空间（插件设置卡片的挂载点）。 */
export const SETTINGS_NS = 'meoo';

/** 秒悟主站（OAuth 与控制面都在这个 origin 下）。 */
export const API_BASE = 'https://meoo.com';

/** OpenAI 兼容网关（真正的模型转发）。 */
export const GATEWAY_BASE = 'https://api.meoo.host/meoo-ai/compatible-mode/v1';

/** OAuth 公开客户端 id（生产站点）。 */
export const CLIENT_ID_PROD = 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh';

/** OAuth 公开客户端 id（非 meoo.com 的测试站点）。 */
export const CLIENT_ID_TEST = 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE';

/** 申请的作用域。 */
export const OAUTH_SCOPE = 'cli.compat';

/** 本机回环回调路径。 */
export const CALLBACK_PATH = '/oauth/callback';

/** 控制面要求客户端标记；缺了它控制面按未知客户端处理。 */
export const CLI_HEADERS = Object.freeze({
  'x-meoo-client': 'cli',
  'x-meoo-cli-version': '0.5.6',
});

/** 控制面路径：账号身份。 */
export const IDENTITY_PATH = '/open/v1/cli-compat/account/identity';
/** 控制面路径：积分账户。 */
export const POINTS_PATH = '/open/v1/cli-compat/account/points';
/** 控制面路径：项目列表。 */
export const PROJECTS_PATH = '/open/v1/cli-compat/projects';
/** 控制面路径：项目云服务环境（含项目服务 AK）。 */
export function cloudEnvPath(urlId: string): string {
  return `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud/environment`;
}
/** 控制面路径：开通项目云服务。 */
export function cloudPath(urlId: string): string {
  return `/open/v1/cli-compat/projects/${encodeURIComponent(urlId)}/cloud`;
}

/** access token 提前多久续期（避免卡在过期边界上）。 */
export const REFRESH_EARLY_MS = 60_000;

/** 同一 refresh token 的续期结果复用窗口。 */
export const REFRESH_REUSE_MS = 60_000;

/** 网关目录缓存时长。 */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** 单次控制面请求超时。 */
export const CONTROL_TIMEOUT_MS = 45_000;

/** 单次网关请求超时。 */
export const GATEWAY_TIMEOUT_MS = 25_000;

/** SSE 空闲超时：这么久没有新帧就认为流断了。 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

/** 浏览器授权等待上限。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 图片请求预算，与 dsh-llm-pi-ai 默认值一致。 */
export const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 8,
  imageOffloadCountQuantum: 4,
} as const;

/** 插件自己的状态文件名（放在 `$DSH_HOME` 根下，与其它插件约定一致）。 */
export const STATE_FILENAME = 'dsh-connect-meoo-state.json';

/** 登录态与目录的落盘目录（`$DSH_HOME/meoo/`，与 dsh-meoo-connect 同路径以便互相复用）。 */
export const AUTH_DIRNAME = 'meoo';
/** 登录态文件名。 */
export const AUTH_FILENAME = 'state.json';
