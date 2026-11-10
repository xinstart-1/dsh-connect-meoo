/**
 * 插件配置。用户在设置页 / `cordis.patch.yml` 里填的东西都在这里。
 * @module dsh-connect-meoo/config
 */

import z from '@deepseek-ai/schemastery';

/** 配置 schema 与默认值。 */
export const Config = z.object({
  /** 是否启用 Meoo 路由（关掉即从模型选择器里撤掉）。 */
  enabled: z
    .boolean()
    .description('在 DSH 模型选择器里启用秒悟 Meoo。')
    .default(true),

  /** 主站地址；只有换测试环境时才需要改。 */
  apiBaseUrl: z
    .string()
    .description('秒悟主站（OAuth 与控制面）。默认 https://meoo.com，只有测试环境需要改。')
    .default(''),

  /** 网关地址；留空用内置值。 */
  gatewayBaseUrl: z
    .string()
    .description('OpenAI 兼容网关。留空用内置 https://api.meoo.host/meoo-ai/compatible-mode/v1。')
    .default(''),

  /**
   * 手填的项目服务 AK（`meoo_project_service_v1.…`）。
   *
   * **兜底**，不是主路径：正常走浏览器授权后自动解析。填了它就只用它。
   */
  serviceAk: z
    .string()
    .description('可选：手填项目服务 AK（meoo_project_service_v1.…）。留空则用浏览器授权自动解析的那个。')
    .default(''),

  /** 复用本机已有的 Meoo 登录态（dsh-meoo-connect / meoo-proxy），严格只读。 */
  reuseLocalLogin: z
    .boolean()
    .description('只读复用本机已有的 Meoo 登录态（$DSH_HOME/meoo/state.json 或 ~/.meoo-proxy/config.json）。')
    .default(true),

  /** 指定项目 urlId；留空用账号默认项目（多项目时会报错让你选）。 */
  projectUrlId: z
    .string()
    .description('指定项目 urlId；留空用账号的默认项目。多项目且没设默认时会提示你选一个。')
    .default(''),

  /** 默认思考档位（模型未声明时兜底）。 */
  defaultReasoningEffort: z
    .string()
    .description('默认思考档位：off / low / medium / high。留空沿用上游默认。')
    .default(''),

  /** 启动时预热一次目录与积分（登录态有效时会多两次只读请求）。 */
  warmOnStart: z
    .boolean()
    .description('插件启动时预拉一次模型目录与积分，让卡片与选择器更快显示真实数据。')
    .default(true),
});

/** 解析后的配置类型。 */
export interface MeooConfig {
  enabled: boolean;
  apiBaseUrl: string;
  gatewayBaseUrl: string;
  serviceAk: string;
  reuseLocalLogin: boolean;
  projectUrlId: string;
  defaultReasoningEffort: string;
  warmOnStart: boolean;
}

/** 缺省值：直接跑 schema 得到。 */
export const DEFAULT_CONFIG: MeooConfig = Config({}) as MeooConfig;
