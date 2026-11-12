# dsh-connect-meoo 专属记忆

> **通用规则**（参考项目不能照搬 / 不许说「上游限制」/ 验证与发布纪律）
> 在上级目录的 [`../../AGENTS.md`](../../AGENTS.md)，先读它。
>
> 本文件只写**这个插件独有的技术事实**，不重复通用规则。

---

## 一、这个插件是什么

把 [秒悟 Meoo](https://meoo.com) 的模型接进 DSH。形态对齐 `dsh-connect-workbuddy`
（双面 bundle + 模型 provider + 设置卡片 + 输入框胶囊），但**接的是官方 AI 服务网关**，
不是伪装客户端。

架构：`ctx.llm` 注册 → **pi-ai 直连 Meoo 网关** → OpenAI Chat Completions。

**没有本地 shim。** 这是与 `dsh-connect-lingxi` 最大的结构差异，也是刻意的：
灵犀要 shim 是因为它的协议不是 OpenAI 兼容（正文在 `choices[].text`、没有 `[DONE]`）；
Meoo 网关本身就是兼容的，多一层代理只会多一类「流掉了」的故障。

---

## 二、协议（详见 `docs/PROTOCOL.md`）

| 通道 | 基址 | 鉴权 |
| --- | --- | --- |
| OAuth | `https://meoo.com/oauth/{authorize,token}` | public client + PKCE(S256)，scope `cli.compat` |
| 控制面 | `https://meoo.com/open/v1/cli-compat/…` | `Bearer <access token>` |
| 网关 | `https://api.meoo.host/meoo-ai/compatible-mode/v1` | `Bearer <项目服务 AK>` |

### 三个必须记住的坑

1. **业务错误也走 HTTP 200**（`{"success":false,"errCode":…}`）。只看 `res.ok`
   会把失败当成功 → 「同步成功」的提示配一个空目录。
2. **`cmd /c start <url>` 会毁掉 OAuth 授权页**：cmd 把 URL 里的 `&` 当命令分隔符，
   浏览器只拿到 `?client_id=…`（缺 `response_type`），授权页报
   `unsupported_response_type`。必须用 `explorer.exe <url>`。
3. **两种 key 不是一层的东西**（2026-11-09 实测修正，旧结论有误）：

   | 凭证 | 前缀 | 控制面（身份/项目/积分/套餐） | 模型网关 |
   | --- | --- | --- | --- |
   | API Key | `meoo_ak_…` | ✅ | ❌ `401 SERVICE_AK_FORMAT_INVALID` |
   | 项目服务 AK | `meoo_project_service_v1.…` | ❌ 401 | ✅ |

   旧版记忆写着「`/account/points` 只认 OAuth token」——**错的**。API Key 同样能读
   积分与套餐（实测 200，读到 8990 分 / Free 版）。所以「手填 AK 读不到积分」只对
   **项目服务 AK** 成立，对 API Key 不成立。

   推论：**API Key 是本插件成本最低的登录路径**——贴一个 key 就能读积分、列项目、
   自动换出项目服务 AK，不用点浏览器、不会过期。用户界面把 API Key 放最前，
   项目服务 AK 降为手动兜底。

   验证方式（对照组，缺一不可）：同一端点用假 token 得 401，用 `meoo_ak_` 得 200，
   用 `meoo_project_service_v1.` 打网关得 200 而打控制面得 401。

### 模型展示信息从哪来（2026-11-10 取证）

网关 `/models` 只回**裸 id 字符串数组**（`{"models":["qwen3.8-flash",…]}`），
价格档位、说明、上下文、多模态、折扣**全都没有**。官网自己的模型选择器走的是：

```
GET https://meoo.com/api/v1/agent/models
Authorization: Bearer <项目服务 AK>
```

返回 `{data:{models:[…], modelsValue:{…}}}`：

| 字段 | 含义 |
| --- | --- |
| `key` | 官网 UI 标识（`deepseekV41Flash1017`、`glm5.2`） |
| `modelsValue[key]` | **网关真 id**（`deepseek-v4.1-flash-1017`、`glm-5.2`）—— 必须用这个发请求 |
| `label` / `description` | 显示名与一句话说明 |
| `price` | `cheap` / `moderate` / `expensive` / `veryExpensive` |
| `discountLabel` / `discountStartTime` / `discountEndTime` | 夜间折扣（4 = 4 折，22:00–08:00） |
| `context_window` / `max_token` / `multimodal` | 容量与多模态 |

**鉴权是项目服务 AK，不是 API Key**（API Key 打这里 403 `API_KEY_ROUTE_FORBIDDEN`）。
`auto` 条目是智能路由档，不是可寻址模型，必须跳过。

这份接口只提供**展示信息**，所以拿不到时必须退回网关那份裸目录 ——
展示信息缺失不该让模型不可用。

---

## 三、设计纪律

1. 网络失败**绝不清空上一次的好数据**，只记 `lastError`。
2. **不做乐观更新**：写操作后重拉上游，用真实读数作答。
3. UI 开关存 `$DSH_HOME/dsh-connect-meoo-state.json`，**不进 DSH 设置** ——
   必须能不保存、不刷新就生效。
4. **未登录也要有静态兜底目录**。空列表会让模型选择器整组消失，而它不会自己变好。
   所以 adapter 注册不等网络、`registerModelDiscovery` 读不到真目录时回兜底表。
5. **表外模型 id 一律保守值**（200K / 64K / 纯文本）。把 1M 乱许出去会让 DSH
   迟迟不压缩，最后撞上游 400，比保守更糟。
6. **只读**复用 `dsh-meoo-connect` / `meoo-proxy` 的登录态文件，一个字节都不写回。
   自己的登录态写 `$DSH_HOME/meoo/state.json`（与 dsh-meoo-connect 同路径，可互相复用），
   且**保留文件里不认识的字段**（降级不丢数据）。
7. 凭据绝不进浏览器半边：页面只拿 `/plugins/dsh-connect-meoo/status` 的归一数据，
   所有写操作走动作白名单（`refresh` / `login` / `login-code` / `logout` / `settings` /
   `project` / `apikey` / `ak` / `account-switch` / `account-remove` / `checkin` / `test-model`）。
8. **不给 `off` 思考档**：上游不提供「关闭思考」，硬塞 `reasoning_effort: none` 只会 400。

---

## 四、与 workbuddy 的差异（有意为之）

| workbuddy 有 | 本插件 | 原因 |
| --- | --- | --- |
| 多账号池 + 自动换号 | **有** | `state.json` 的 `credentials[]` + `activeId`；卡片切换/移除，顶层字段镜像当前令牌，旧读法不坏 |
| 每日签到 | **有（每日登录积分）** | 没有独立 check-in 路由（8 条 404，对照组 401/404 同码）；每日登录赠送走网页会话 `POST /api/mc/entitlement/init`，API Key 打它会 **403 API_KEY_ROUTE_FORBIDDEN**。OAuth 主动领取，API Key 只核对。见 `docs/PROTOCOL.md` 六之二 |
| 生图 / 生视频工具 | 没有 | 本插件的网关是文本补全网关；生图能力未取证（标「待验证」，不写「不支持」） |
| 模型倍率徽标 | **有等价物** | 官网模型选择器的「便宜/适中/较贵/超贵」四档点阵 + 夜间折扣胶囊，取自 `/api/v1/agent/models` |
| 伪装客户端指纹 | **不做** | 用的是官方「AI 服务」网关的公开契约，不需要伪装 |
| 回环 shim | 没有 | 网关本身 OpenAI 兼容 |

> **「没有独立签到路由」是怎么证出来的**（不是读第三方实现猜的）：
> `probe-endpoints.mjs` 同时打三组路径 ——
> 4 个已知端点（对照，全 401 = 存在）、8 条签到候选、1 条必然不存在的路径（对照）。
> 结果：签到候选全部 404，与「必然不存在」的对照组同码。
> 只看到 404 还不够，必须同时看到对照组 401，否则分不清「没有这条路由」与
> 「整个控制面都不通」。每日登录赠送另有取证：网页会话 `POST /api/mc/entitlement/init`
> 返回 200 + `dailyLoginGranted`，同一接口用 API Key 是 403。

---

## 五、本仓库的验证入口

```bash
node scripts/gate.mjs     # 十四道门（见下）
node scripts/probe.mjs    # 现场探测：端点可达性 + 本机登录态（不花钱）
```

### 安装形态的坑（会静默毁掉整个插件）

`dsh plugin add` 落地有两种形态，**行为不同**：

| 形态 | 依赖解析 | 结果 |
| --- | --- | --- |
| 符号链接 / junction → 源码目录 | 走源码目录的 `node_modules` | ✅ 能解析 `@deepseek-ai/*` |
| 复制目录 → profile/node_modules | 走 profile 的 `node_modules` | ❌ profile 里没有 `@deepseek-ai/dsh-llm-pi-ai` → `MODULE_NOT_FOUND` → **插件挂载失败** |

复制形态下侧栏**什么都不会出现**，而且没有明显报错——很容易误判成「槽位注册写错了」。
修法：`New-Item -ItemType Junction -Path <profile>/node_modules/<包名> -Target <仓库>`
（`mklink` 在这个环境的 cmd 里不出声地失败，用 PowerShell 原生 cmdlet）。

`check-host.mjs` 的「从 profile 路径能加载」这一项就是卡它的：
装进 profile 后必须能从**那个路径** `import()` 成功，否则 gate 直接失败。

`gate.mjs` 里四道**这个仓库特有**的门（都是被真实缺陷逼出来的）：

| 门 | 为什么存在 |
| --- | --- |
| `check-claims.mjs` | 守「不许写没依据的上游限制」。 |
| `check-doc-contract.mjs` | **文档承诺的功能必须在代码里存在。** 起因：README 写了 `/meoo` 系列命令，代码里一条都没实现 —— 用户照着敲会得到「未知命令」。单测查不出这类缺陷（单测只测已实现的东西）。 |
| `check-cordis.mjs` | **用真的 Cordis `Context` 装载一次。** 手写假 ctx 能验「我们调了哪些 API」，验不出「Cordis 接不接受这些调用」；还断言卸载后所有注册都被释放（热重载泄漏）。 |
| `check-host.mjs` | 宿主真能 `import()` 这个包、`dsh` 声明与 patch row name 都对、`engines.dsh` 存在。这些是「装上去才发现」的故障。 |
| `check-pack.mjs` | 真实 tarball 清单。`files` 白名单漏一个目录 = 本地全绿、装的人拿到没界面的包。本机没有 npm，必须用 `node <pnpm.mjs>` 调。 |
| `preview-ui.mjs` | 浏览器半侧离屏渲染：整页拼起来之后仍非空、CSS 已注入、没有 `undefined`。`--check` 进 gate，不带则生成 HTML + 截图到 `docs/assets`。 |
| `smoke-apply.mjs` | 真跑一次 `apply()` 并验证注册内容。 |

## 六、当前状态（2026-11-09）

- 十四道 gate 全绿：143 个单测 + 离屏 UI 渲染 + 装载冒烟 + 真实 Cordis 装载。
- 五个上游端点实测可达（401 = 端点存在，缺凭据）。
- 已装进 `desktop` profile：**用 junction**（复制形态会 MODULE_NOT_FOUND，见上一节）。
- **API Key 是唯一主路径**（对齐 qoder 的 PAT 模式）：卡片里不放「登录」按钮，
  填 key 即完成。浏览器授权降级到「高级」里的次要按钮，项目服务 AK 再降一级。
- 真网关已端到端跑通（2026-11-09）：`/models` 200、`/chat/completions` 200
  且返回 `reasoning_content`。项目 `cs83fwrk9yz6` 的云服务已由插件路径自动开通。
- **DSH 原生「自定义供应商」配不通 Meoo**：它的模型发现要求 `{"data":[...]}` 或
  `{"models":{...}}` 对象，而 Meoo 返回 `{"models":["id",…]}` 字符串数组 →
  `DISCOVERY_FAILED`。所以手填供应商必须逐个手动添加模型，这正是插件存在的理由之一。
- 待验证（自动化测不到，需要真实账号）：网关是否透传 `tool_calls`、
  SSE 是否带 `reasoning_content`、图片输入的真实行为。见 `docs/PROTOCOL.md` §七。
