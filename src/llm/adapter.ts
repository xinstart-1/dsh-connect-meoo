/**
 * DSH LLM 接入层：把 Meoo 网关包成一个 pi-ai provider。
 *
 * 这一层刻意做得很薄 —— Meoo 网关本身就是 **OpenAI 兼容**的
 * （`https://api.meoo.host/meoo-ai/compatible-mode/v1`），所以：
 *
 * - **不需要本地 shim**。灵犀那边必须起一个回环代理是因为它的协议不是
 *   OpenAI 兼容（正文在 `choices[].text`、没有 `[DONE]`）。Meoo 不需要翻译，
 *   多一层代理只会多一类「流掉了」的故障。
 * - 唯一需要动态处理的是 **apiKey**：它是「项目服务 AK」，会随项目切换、
 *   也会随登录态刷新而变，所以每次请求现场解析（`resolveApiKey`），
 *   而不是启动时算一次。
 *
 * @module dsh-connect-meoo/llm/adapter
 */

import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy, type LlmModelInfo, type LlmProviderInfo } from '@deepseek-ai/dsh-llm';
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PROVIDER, REQUEST_IMAGE_BUDGETS, STREAM_IDLE_TIMEOUT_MS } from '../constants.ts';
import { INERT_AUTH } from '../credentials/inert-auth.ts';
import type { MeooModel } from '../protocol/catalog.ts';

/** 秒悟按积分计费，没有可得的按 token 单价：报 0（不伪造价格）。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 思考档位到 pi 思考档的映射。
 *
 * 网关实测（`@fish-under-sea/opencode-meoo-auth`，2026-11，qwen3.8-flash）：
 * `reasoning_effort` 的 low / medium / high 都被接受且真的影响思考长度。
 * 所以三档直通，`off` 不提供（上游没有「关闭思考」这个档，硬塞一个
 * `reasoning_effort: none` 只会 400）。
 */
const THINKING_LEVELS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
} as const;

/** 把一个目录条目变成 pi-ai 的 chat model。 */
export function toPiModel(info: MeooModel, baseUrl: string): Model<'openai-completions'> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: PROVIDER,
    baseUrl,
    input: info.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: info.reasoning,
    // 秒悟网关只接受 system/assistant/user/tool/function，发 `developer` 会 400：
    // `developer is not one of ['system', 'assistant', 'user', 'tool', 'function']`。
    // pi-ai 的自动探测按 baseUrl 白名单判断，`api.meoo.host` 不在名单里 → 默认 true →
    // 带 reasoning 的模型会把 system 消息发成 developer。必须显式关掉。
    compat: {
      supportsDeveloperRole: false,
      // 网关是 LiteLLM 风格：只认 `max_tokens`，不认 `max_completion_tokens`。
      maxTokensField: 'max_tokens',
      // 缓存优化（实测见 docs/PROTOCOL.md）：网关的自动前缀缓存能命中 99%+，
      // 但它是多节点的 —— 让 pi-ai 带上会话亲和头，同一个会话尽量落到同一节点，
      // 别让「同一段前缀」在两个节点上各冷一遍。网关不认识这些头时会直接忽略。
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: 'openai',
      // 网关接受 `prompt_cache_retention: "24h"`（实测 HTTP 200，重复前缀命中
      // 4352/4441 tokens）；开启长保留让隔一段时间回来的会话仍能命中。
      supportsLongCacheRetention: true,
      ...(info.reasoning ? { supportsReasoningEffort: true } : {}),
    },
    ...(info.reasoning ? { thinkingLevelMap: { ...THINKING_LEVELS } } : {}),
  };
}

/** adapter 与目录/凭据的绑定关系。 */
export interface MeooAdapterOptions {
  /** 当前模型目录；每次重建 profile 时读一次。 */
  catalog: () => readonly MeooModel[];
  /** 当前网关 baseURL（不含 `/v1` 尾缀，adapter 自己拼）。 */
  baseUrl: () => string;
  /**
   * 每次请求现场解析项目服务 AK。
   *
   * 失败时抛错 —— 让 pi-ai 把错误呈现给用户，而不是拿一个空 key 去打上游
   * 换回一个 401（那个 401 会让人以为是登录态问题）。
   */
  apiKey: () => Promise<string>;
}

/** 一次装配的结果。 */
export interface MeooAdapter {
  adapter: PiAiAdapter;
  /** 目录变化后调用；下一次请求会重建 profiles。 */
  invalidate: () => void;
}

/** provider 展示名。 */
const DISPLAY_NAME = 'Meoo 秒悟';

/**
 * 构造 pi-ai provider + PiAiAdapter。
 * @param options - 目录与凭据的读取器。
 * @returns 可直接交给 `ctx.llm.registerAdapter` 的 adapter。
 */
export function createMeooAdapter(options: MeooAdapterOptions): MeooAdapter {
  /** 网关 baseURL 已经含 `/v1`（`…/compatible-mode/v1`），不要再拼。 */
  const modelsBase = (): string => options.baseUrl().replace(/\/+$/, '');

  const buildModels = (): Model<'openai-completions'>[] =>
    options.catalog().map((info) => toPiModel(info, modelsBase()));

  const buildProvider = (): Provider<'openai-completions'> =>
    createProvider({
      id: PROVIDER,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'Meoo 项目服务 AK',
          async resolve({ credential }) {
            const key = credential?.key;
            return key === undefined || key.length === 0
              ? undefined
              : { auth: { apiKey: key }, source: 'Meoo 秒悟' };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    });

  const profileFor = (providerKey: string): ResolvedPiAiProviderProfile => ({
    provider: providerKey,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    // 与 compat.supportsLongCacheRetention 配套：pi-ai 只在 cacheRetention='long'
    // 且 compat 允许时发送 `prompt_cache_key`（会话 id）与 24h 保留。
    cacheRetention: 'long',
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-meoo retryPolicy'),
    configuredMaxTokens: new Map<string, number>(),
    modelErrors: new Map<string, string>(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider:
      providerKey === PROVIDER
        ? provider
        : {
            ...provider,
            id: providerKey,
          },
  });

  let provider = buildProvider();
  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[PROVIDER, profileFor(PROVIDER)]]);

  const config: PiAiAdapterOptions = {
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.apiKey(),
  };

  const adapter = new PiAiAdapter(config);

  return {
    adapter,
    invalidate: () => {
      // pi-ai 的 provider 模型列表是快照；目录或网关地址变了要重建 provider。
      provider = buildProvider();
      profiles = new Map([[PROVIDER, { ...profileFor(PROVIDER), piProvider: provider }]]);
    },
  };
}

/**
 * 把目录条目转成 DSH 的 `LlmModelInfo`（模型发现接口要用）。
 * @param models - 目录。
 * @returns DSH 侧的模型描述。
 */
export function toLlmModelInfos(models: readonly MeooModel[]): LlmModelInfo[] {
  return models.map((model) => ({
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    description: `${Math.round(model.contextWindow / 1000)}K 上下文`,
    inputModalities: model.vision ? (['text', 'image'] as const) : (['text'] as const),
  }));
}

/** provider 的展示信息。 */
export const PROVIDER_INFO: LlmProviderInfo = { id: PROVIDER, name: DISPLAY_NAME };
