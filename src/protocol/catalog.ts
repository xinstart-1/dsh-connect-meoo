/**
 * 模型规格表与网关目录解析。
 *
 * 网关 `GET /models` 只回裸 id（`{"models":[{"id":"glm-5.2"},…]}` 或字符串数组），
 * **不带**上下文窗口与输出上限。所以数字必须自己带 —— 取值来自各家官方文档，
 * 与 `@fish-under-sea/opencode-meoo-auth` 2026-11 核对过的表一致。
 *
 * 不认识的 id 一律给保守值（200K / 64K、纯文本）：把 1M 乱许出去会让 DSH
 * 迟迟不压缩上下文，最后撞上游 400，比保守更糟。
 *
 * @module dsh-connect-meoo/protocol/catalog
 */

/** 一个可用模型。 */
export interface MeooModel {
  /** 网关认的 model id。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 上下文窗口（token）。 */
  contextWindow: number;
  /** 单次输出上限（token）。 */
  maxTokens: number;
  /** 是否支持图片输入（只对官方写明原生多模态的 id 置真）。 */
  vision: boolean;
  /** 是否支持 `reasoning_effort` 档位（网关实测 low/medium/high 均生效）。 */
  reasoning: boolean;
  /**
   * 官网的价格档位（`cheap` / `moderate` / `expensive` / `veryExpensive`）。
   *
   * 这是 meoo.com 模型选择器里「便宜 / 适中 / 较贵 / 超贵」四个点阵标签的
   * **唯一真源**：网关 `/models` 只回裸 id，不带任何价格信息。
   * 拿不到时为 undefined（界面就不显示档位，而不是瞎猜一个）。
   */
  price?: PriceTier;
  /** 官网的一句话说明（模型选择器里的副标题）。 */
  description?: string;
  /**
   * 夜间折扣（如 `{ label: 4, start: '22:00', end: '08:00' }` = 22:00–08:00 打 4 折）。
   *
   * 官网在模型名后面挂一个「夜间折扣」胶囊，这里保持同一份事实。
   */
  discount?: ModelDiscount;
}

/** 官网价格档位。 */
export type PriceTier = 'cheap' | 'moderate' | 'expensive' | 'veryExpensive';

/** 夜间折扣。 */
export interface ModelDiscount {
  /** 折数：4 = 4 折（官网 `discountLabel` 就是这个数）。 */
  label: number;
  /** 本地时间窗起点，`HH:MM`。 */
  start: string;
  /** 本地时间窗终点，`HH:MM`。 */
  end: string;
}

/** 目录里认不出的新模型先按这个给。 */
const UNKNOWN_CONTEXT_WINDOW = 200_000;
const UNKNOWN_MAX_TOKENS = 64_000;

/** 规格表：id → 展示名 / 上下文 / 输出 / 是否多模态。 */
export const MODEL_SPECS: readonly MeooModel[] = Object.freeze([
  // 上下文 / 输出 / 多模态 / 价格档位全部对齐官网 `/api/v1/agent/models`（2026-11-10 实测）。
  // 网关 `/models` 只回裸 id，这些数字只能自己带；在线时会被官网接口覆盖。
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'cheap', description: '千问最新平衡模型，精准快' },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'veryExpensive' },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: 200_000, maxTokens: 64_000, vision: false, reasoning: true, price: 'expensive' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'cheap' },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'cheap' },
  { id: 'deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', contextWindow: 200_000, maxTokens: 64_000, vision: false, reasoning: true, price: 'moderate' },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', contextWindow: 200_000, maxTokens: 64_000, vision: false, reasoning: true, price: 'cheap' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 200_000, maxTokens: 16_384, vision: true, reasoning: true, price: 'veryExpensive' },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'veryExpensive' },
  { id: 'MiniMax/MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'cheap' },
  { id: 'bigmodel/glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 200_000, maxTokens: 64_000, vision: true, reasoning: true, price: 'cheap' },
  { id: 'bigmodel/glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxTokens: 64_000, vision: false, reasoning: true, price: 'expensive' },
  { id: 'glm-5.2-fast-preview', name: 'GLM-5.2-Fast', contextWindow: 200_000, maxTokens: 64_000, vision: false, reasoning: true, price: 'veryExpensive' },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, maxTokens: 64_000, vision: false, reasoning: true, price: 'expensive' },
  { id: 'qwen3-vl-plus', name: 'Qwen VL', contextWindow: 262_144, maxTokens: 32_768, vision: true, reasoning: true },
]);

const SPEC_BY_ID = new Map(MODEL_SPECS.map((spec) => [spec.id, spec]));

/**
 * 取一个 id 的规格；表外 id 给保守值。
 * @param id - 网关 id。
 * @returns 规格（永不为 undefined）。
 */
export function specOf(id: string): MeooModel {
  return (
    SPEC_BY_ID.get(id) ?? {
      id,
      name: id,
      contextWindow: UNKNOWN_CONTEXT_WINDOW,
      maxTokens: UNKNOWN_MAX_TOKENS,
      vision: false,
      reasoning: true,
    }
  );
}

/** 上游 `/models` 的包络（三种形状都见过，逐一兜）。 */
export interface RawModelsPayload {
  models?: unknown;
  data?: unknown;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 解析网关目录。
 *
 * 三种形状都要认：`{models:[…]}`、`{data:[…]}`、裸数组；数组元素可以是字符串，
 * 也可以是 `{id, name, context, max_output|max_output_tokens|max_tokens}`。
 * 缺 id 或 id 非字符串的条目直接丢弃（留着只会在选择器里出现一个点了就 400 的行）。
 *
 * @param payload - 上游 JSON（任意形状）。
 * @returns 去重后的目录，保持上游顺序。
 */
export function parseGatewayModels(payload: unknown): MeooModel[] {
  const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as RawModelsPayload;
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope.models)
      ? envelope.models
      : Array.isArray(envelope.data)
        ? envelope.data
        : [];
  const seen = new Set<string>();
  const models: MeooModel[] = [];
  for (const entry of list) {
    const rawId =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? (entry as { id?: unknown }).id
          : undefined;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const spec = specOf(id);
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    models.push({
      id,
      name: typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : spec.name,
      contextWindow: positiveInt(record.context, spec.contextWindow),
      maxTokens: positiveInt(
        record.max_output ?? record.max_output_tokens ?? record.max_tokens,
        spec.maxTokens,
      ),
      // 上游若明说支持图片，尊重它；否则按规格表（表外 = 纯文本）。
      vision: record.image === true ? true : spec.vision,
      reasoning: true,
    });
  }
  return models;
}

/**
 * 官网模型目录接口。
 *
 * 为什么不用网关的 `/models`：它只回裸 id 字符串数组，**没有任何展示信息**
 * （价格档位、说明、上下文、多模态全都缺）。官网自己用的是这个接口，
 * 它返回 `price` / `label` / `description` / `context_window` / `multimodal`
 * 以及 `modelsValue`（官网 key → 网关 id 的映射）。
 *
 * 鉴权用**项目服务 AK**（不是 API Key：API Key 打这里会 403 API_KEY_ROUTE_FORBIDDEN）。
 */
export const AGENT_MODELS_PATH = '/api/v1/agent/models';

const PRICE_TIERS: readonly PriceTier[] = ['cheap', 'moderate', 'expensive', 'veryExpensive'];

function priceTierOf(value: unknown): PriceTier | undefined {
  return typeof value === 'string' && (PRICE_TIERS as readonly string[]).includes(value)
    ? (value as PriceTier)
    : undefined;
}

/**
 * 解析官网模型目录。
 *
 * 关键点是 `modelsValue`：官网用 `key`（如 `deepseekV41Flash1017`）做 UI 标识，
 * 而网关认的是 `value`（`deepseek-v4.1-flash-1017`）。**必须用后者当 id**，
 * 否则发出去的请求会 404 / 400。`auto` 这类没有固定模型的条目直接跳过。
 *
 * @param payload - 官网接口返回的 JSON。
 * @returns 目录（按官网顺序）；形状不对时返回空数组（调用方回退到网关目录）。
 */
export function parseAgentModels(payload: unknown): MeooModel[] {
  const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(data.models) ? data.models : [];
  const valueMap =
    typeof data.modelsValue === 'object' && data.modelsValue !== null
      ? (data.modelsValue as Record<string, unknown>)
      : {};
  const models: MeooModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    // `auto` 是官网的智能路由档，不是一个可寻址的模型 id。
    if (key === '' || key === 'auto') continue;
    const mapped = valueMap[key];
    const id = (typeof mapped === 'string' && mapped.trim() !== '' ? mapped : key).trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const spec = specOf(id);
    const label = typeof record.label === 'string' && record.label.trim() !== '' ? record.label.trim() : spec.name;
    const discountLabel = typeof record.discountLabel === 'number' ? record.discountLabel : Number(record.discountLabel);
    const start = typeof record.discountStartTime === 'string' ? record.discountStartTime : '';
    const end = typeof record.discountEndTime === 'string' ? record.discountEndTime : '';
    models.push({
      id,
      name: label,
      contextWindow: positiveInt(record.context_window, spec.contextWindow),
      maxTokens: positiveInt(record.max_token, spec.maxTokens),
      vision: record.multimodal === true ? true : record.multimodal === false ? false : spec.vision,
      reasoning: true,
      ...(priceTierOf(record.price) === undefined ? {} : { price: priceTierOf(record.price) as PriceTier }),
      ...(typeof record.description === 'string' && record.description.trim() !== ''
        ? { description: record.description.trim() }
        : {}),
      ...(Number.isFinite(discountLabel) && discountLabel > 0 && start !== '' && end !== ''
        ? { discount: { label: discountLabel, start, end } }
        : {}),
    });
  }
  return models;
}

/** 网关目录拿不到时的兜底目录（规格表全量）。 */
export const FALLBACK_CATALOG: readonly MeooModel[] = MODEL_SPECS;

/** 默认模型 id（目录为空且用户没指定时用）。 */
export const DEFAULT_MODEL_ID = 'qwen3.8-flash';

/**
 * 把任意 id 归一成目录里真正存在的那个。
 * @param raw - 用户/DSH 传来的 id。
 * @param catalog - 当前目录。
 * @returns 可用 id。
 */
export function normalizeModelId(raw: unknown, catalog: readonly MeooModel[]): string {
  const id = typeof raw === 'string' ? raw.trim().replace(/^meoo\//, '') : '';
  if (id !== '' && catalog.some((model) => model.id === id)) return id;
  return catalog[0]?.id ?? DEFAULT_MODEL_ID;
}
