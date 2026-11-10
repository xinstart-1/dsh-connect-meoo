# Meoo 秒悟 协议取证

> 本文只写**实测过**的事实。每条都带来源，没实测的标「待验证」。
> 日期：2026-11-09。

---

## 一、来源

| 来源 | 性质 | 用途 |
| --- | --- | --- |
| 本机 `curl` 实测 | **一手证据** | 端点存在性、错误码 |
| [`dsh-meoo-connect`](https://github.com/2239058652/dsh-meoo-connect)（MIT） | 第三方实现，代码可读 | OAuth / 控制面 / 网关链路 |
| [`@fish-under-sea/opencode-meoo-auth`](https://github.com/Fish-under-sea/opencode-meoo-auth)（MIT，npm 1.2.1） | 第三方实现，代码可读 | 模型规格表、积分字段、思考档位实测结论 |
| [`@aliyun-meoo/cli`](https://www.npmjs.com/package/@aliyun-meoo/cli)（官方，MIT） | 官方 CLI 产物 | 控制面路径与客户端头 |

后三者是**证据，不是规格**：本插件按官方契约实现，不复制它们的形状。

---

## 二、端点与鉴权

### 2.1 三条通道

| 通道 | 基址 | 鉴权 | 实测 |
| --- | --- | --- | --- |
| OAuth | `https://meoo.com/oauth/authorize`、`/oauth/token` | public client + PKCE | `303`（授权页真实存在） |
| 控制面 | `https://meoo.com/open/v1/cli-compat/…` | `Bearer <access token>` | `401 invalid_token`（缺 Bearer，端点真实） |
| 模型网关 | `https://api.meoo.host/meoo-ai/compatible-mode/v1` | `Bearer <项目服务 AK>` | `401 SERVICE_AK_MISSING`（缺 AK，端点真实） |

**「401 而不是 404」本身就是端点存在的证据** —— 请求已经打到业务层，只是没带凭据。

### 2.2 实测响应原文（2026-11-09，本机）

```
GET https://api.meoo.host/meoo-ai/compatible-mode/v1/models
→ HTTP 401
{"error":{"type":"invalid_request_error","message":"缺少 Authorization 头","code":"SERVICE_AK_MISSING"}}

GET https://meoo.com/open/v1/cli-compat/account/identity
→ HTTP 401
{"type":"about:blank","title":"Unauthorized","status":401,"detail":"缺少 Bearer …","code":"invalid_token","trace_id":"…"}

GET https://meoo.com/open/v1/cli-compat/account/points
→ HTTP 401
{"type":"about:blank","title":"Unauthorized","status":401,"detail":"缺少 Bearer …","code":"invalid_token","trace_id":"…"}
```

### 2.3 客户端标记

控制面要求两个头（官方 CLI 与两个第三方实现一致）：

```
x-meoo-client: cli
x-meoo-cli-version: 0.5.6
```

---

## 三、OAuth（Authorization Code + PKCE）

| 项 | 值 |
| --- | --- |
| scope | `cli.compat` |
| 生产 client_id | `meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh` |
| 测试 client_id | `meoo_app_SFNvmHUFNePxyyfGjCd9hyaE` |
| 回调 | `http://127.0.0.1:<随机端口>/oauth/callback` |
| code_challenge_method | `S256` |

流程：`GET /oauth/authorize?…` → 用户点授权 → 回调带 `code` → `POST /oauth/token`
（`grant_type=authorization_code`）→ `access_token` / `refresh_token` / `expires_in`。

续期：`POST /oauth/token`（`grant_type=refresh_token`）。**refresh token 会轮换**，
每次续期都要原子保存。

**Windows 坑（已在代码里绕开）**：打开授权页**不能**用 `cmd /c start <url>` ——
cmd 会把 URL 里的 `&` 当成命令分隔符，浏览器只拿到 `?client_id=…` 那一段（缺
`response_type`），授权页报 `unsupported_response_type`。要用 `explorer.exe <url>`。

---

## 四、控制面

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/open/v1/cli-compat/account/identity` | GET | 账号名、`user_id`、`project_url_id` |
| `/open/v1/cli-compat/account/points` | GET | 积分账户（`account.availableBalance` 等） |
| `/open/v1/cli-compat/projects?page_size=N` | GET | 项目列表（`url_id` / `name`） |
| `/open/v1/cli-compat/projects` | POST | 新建项目（`{name}`，失败可退回 `{}`） |
| `/open/v1/cli-compat/projects/{urlId}/cloud/environment` | GET | **项目服务 AK**：`meooProjectApiKey`（也可能在 `instance.meooProjectApiKey`） |
| `/open/v1/cli-compat/projects/{urlId}/cloud` | POST | 开通云服务（`{description}`） |

### 4.1 业务错误也走 HTTP 200

```json
{"success": false, "errCode": "…", "message": "…"}
```

**只看 `res.ok` 会把失败当成功** —— 于是「同步成功」的提示配着一个空目录。
本插件的 `controlRequest` 先拦 `success === false`，再看状态码。

### 4.2 积分字段

```json
{
  "account": { "availableBalance": 1234, "totalConsumed": 567, "frozenBalance": 8 },
  "activeGrants": [
    { "grantDetails": [{ "remainingAmount": 100, "expiresDate": "2026-12-01T00:00:00Z" }] }
  ]
}
```

- 批次只在 `remainingAmount > 0` 时算有效。
- 「最近到期日」= 有效批次里最小的 `expiresDate`。
- **控制面只认「控制面凭证」**，而控制面凭证有两种：OAuth access token 与
  **API Key（`meoo_ak_…`）**。两者都能读这个端点（2026-11-09 实测：API Key 返回
  200，读到 `availableBalance: 8990`）。
- **项目服务 AK（`meoo_project_service_v1.…`）读不到积分账户**：它是网关 Bearer，
  控制面不接受它（实测 401）。这是上游的鉴权分层，不是本插件没实现 ——
  所以界面上要写清「手填项目服务 AK 读不到积分」，并引导用户改用 API Key。

  取证（三组对照，缺一不可）：

  | 凭证 | `/account/points` | 网关 `/models` |
  | --- | --- | --- |
  | 假 token | 401 `invalid_token` | — |
  | `meoo_ak_…` | **200** | 401 `SERVICE_AK_FORMAT_INVALID` |
  | `meoo_project_service_v1.…` | 401 | **200** |

---

## 四点五、官网模型目录（展示信息的唯一真源）

网关 `/models` 只回裸 id，**不含**价格档位、说明、上下文、多模态、折扣。
官网模型选择器用的是下面这个接口（2026-11-10 实测）：

```
GET https://meoo.com/api/v1/agent/models
Authorization: Bearer <项目服务 AK>
x-meoo-client: cli
```

响应形状：

```jsonc
{ "success": true, "data": {
    "models": [{
      "key": "deepseekV41Flash1017",     // 官网 UI 标识
      "label": "DeepSeek V4.1 Flash",
      "description": "高质低价，支持图片理解",
      "price": "cheap",                  // cheap | moderate | expensive | veryExpensive
      "context_window": 200000,
      "max_token": 64000,
      "multimodal": true,
      "discountLabel": 5,                // 5 = 5 折
      "discountStartTime": "22:00",
      "discountEndTime": "08:00"
    }, /* … */],
    "modelsValue": {                     // ← 关键：官网 key → 网关真 id
      "deepseekV41Flash1017": "deepseek-v4.1-flash-1017",
      "glm5.2": "glm-5.2"
    }
} }
```

**两个必须记住的点**：

1. **发请求要用 `modelsValue[key]`**，不是 `key`。`deepseekV41Flash1017` 打到网关会 400。
2. **鉴权是项目服务 AK**。API Key 打这里得 403 `API_KEY_ROUTE_FORBIDDEN`
   （实测，与打网关的 401 不同码，能区分「没权限」与「凭证类型错」）。

`auto` 条目是官网的智能路由档，没有固定模型 id，必须跳过。

这个接口只提供**展示信息**，所以拿不到时回退到网关那份裸目录 ——
展示信息缺失不该让模型不可用。

---

## 五、网关

### 5.1 模型目录

```
GET {gateway}/models
Authorization: Bearer <项目服务 AK>
```

响应形状（三种都见过，逐一兜）：`{models:[…]}`、`{data:[…]}`、裸数组；
元素可以是字符串或 `{id, name, context, max_output|max_output_tokens|max_tokens}`。

**上游目录不保证带上下文与输出上限**，所以规格表要自己带（`src/protocol/catalog.ts`）。
表外 id 一律保守值 200K / 64K、纯文本 —— 把 1M 乱许出去会让 DSH 迟迟不压缩，
最后撞上游 400，比保守更糟。

### 5.2 对话

标准 OpenAI Chat Completions：`POST {gateway}/chat/completions`。
pi-ai 的 `openai-completions` API 直通，**不需要本地翻译层**。

#### 两个必须显式覆盖的兼容项（2026-11-10 实测）

pi-ai 会按 `baseUrl` 白名单自动猜「上游是不是标准 OpenAI」。`api.meoo.host`
不在名单里，于是它按「标准 OpenAI」处理 —— 两处猜错，其中第一处会让模型**完全不可用**：

| 猜测项 | 自动值 | 秒悟实际 | 后果 |
| --- | --- | --- | --- |
| `supportsDeveloperRole` | `true` | ❌ 只收 `system`/`assistant`/`user`/`tool`/`function` | **HTTP 400** |
| `maxTokensField` | `max_completion_tokens` | `max_tokens`（LiteLLM 风格） | 输出上限被忽略 |

400 的原文（可复现）：

```
POST /chat/completions  {"role":"developer", …}
→ HTTP 400 {"error":{"message":"developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
                      "code":"invalid_parameter_error"}}
```

把同一条消息的 `role` 换成 `system` 立刻 200。所以 `toPiModel()` 里必须写死：

```ts
compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens', … }
```

**不覆盖的症状是「模型测试失败 / 对话直接报 400」，而不是崩溃**——pi-ai 的默认值
只在带 reasoning 的模型上才发 `developer`，所以看起来像是「某些模型坏了」。

### 5.3 思考档位

`@fish-under-sea/opencode-meoo-auth` 2026-11 实测（qwen3.8-flash）：
`reasoning_effort` 的 `low` / `medium` / `high` 都被接受且真的影响思考长度
（reasoning tokens：low ≈ 13、medium/high ≈ 30）。

**没有 `off` 档**：上游不提供「关闭思考」，硬塞一个 `reasoning_effort: none` 只会 400。
所以本插件的思考档只映射三档，不提供 off。

---

## 六、模型规格表

网关 `/models` 只回裸 id。下表数字取自各家官方文档（2026-11 核对），
与 `@fish-under-sea/opencode-meoo-auth` 的 `MODEL_SPECS` 一致：

| id | 名称 | 上下文 | 输出上限 | 多模态 |
| --- | --- | --- | --- | --- |
| `qwen3.8-flash` | Qwen3.8-Flash | 1M | 131072 | ✅ |
| `qwen3.8-max` | Qwen3.8-Max | 1M | 131072 | ✅ |
| `qwen3.7-max` | Qwen3.7-Max | 1M | 131072 | — |
| `qwen3.7-plus` | Qwen3.7-Plus | 1M | 131072 | ✅ |
| `deepseek-v4.1-flash-1017` | DeepSeek V4.1 Flash | 1M | 384000 | ✅ |
| `deepseek-v4-pro-0813` | DeepSeek V4 Pro | 1M | 384000 | — |
| `deepseek-v4-flash-0731` | DeepSeek V4 Flash | 1M | 384000 | — |
| `glm-5.2-fast-preview` | GLM-5.2-Fast | 1M | 128000 | — |
| `glm-5.2` | GLM-5.2 | 1M | 128000 | — |
| `qwen3-vl-plus` | Qwen VL | 262144 | 32768 | ✅ |

**Kimi K3 / GLM-5.3 / MiniMax M3.1 不在这个网关里**：它们走 Meoo 的 **Agent 产品**
（`/open/v1/projects/<id>/agent/runs`，SSE，非 OpenAI 兼容）。用同一套 provider
接它们是错配 —— 那是另一个插件形态的活。本插件不列它们。

---

## 六之二、签到接口不存在（带对照组的取证）

workbuddy 有每日签到，Meoo 有没有？**没有。** 这不是读第三方实现猜的，
而是直接问上游并带对照组：

| 组 | 路径 | 实测 |
| --- | --- | --- |
| 已知存在（对照） | `account/identity`、`account/points`、`account/entitlement`、`projects` | **全部 401** |
| 必然不存在（对照） | `definitely-not-a-real-route-xyz` | **404** |
| 签到候选（8 条） | `account/checkin`、`account/check-in`、`account/signin`、`account/sign-in`、`account/daily`、`account/daily-checkin`、`checkin`、`points/checkin` | **全部 404** |

**判据**：401 = 路由存在只是缺凭据；404 = 路由不存在。
签到候选的 404 与「必然不存在」的对照组同码，而对照组 401 证明控制面本身是通的。

**为什么必须有对照组**：只看 404 分不清「没有这条路由」与「整个控制面都不通」。
项目记忆里那条「不许说上游限制」，要求的就是这种形态的证据。

复现：`node scripts/probe-endpoints.mjs`（联网，不花钱）。

---

## 七、待验证

| 项 | 状态 | 怎么验 |
| --- | --- | --- |
| 真实账号下的 OAuth 全链路 | 待验证 | 浏览器授权一次，看卡片是否变「已登录 + AK 已就绪」 |
| 网关 SSE 是否带 `reasoning_content` | 待验证 | 发一条带 `reasoning_effort: high` 的请求，看流里有没有该字段 |
| 多项目账号的 AK 归属 | 部分确证 | 上游 `serviceAkProjectId` 字段存在，换项目必须重取；本插件已按此实现 |
| 图片输入在网关上的真实行为 | 待验证 | 用 `qwen3.8-flash` 发一张图，看是否 400 |
