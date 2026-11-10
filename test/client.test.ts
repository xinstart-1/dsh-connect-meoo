/**
 * 上游客户端与积分解析的测试。
 *
 * 网络全部用假 `fetch` 替换：这里测的是**契约与失败语义**，不是真网关。
 * 重点钉住：
 * 1. **业务错误也走 HTTP 200**（`{success:false}`）必须被拦下来；
 * 2. 401 续期一次再重试，续期后仍 401 报 `expired`；
 * 3. 积分批次排序与「最近到期日」。
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  MeooError,
  controlRequest,
  fetchGatewayModels,
  parsePoints,
  verifyServiceAk,
} from '../src/protocol/client.ts';
import type { StoredAuth } from '../src/credentials/store.ts';

/** 原始 fetch 的备份，测完恢复。 */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 装一个按脚本作答的假 fetch。 */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown },
): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

/** 一个未过期的登录态。 */
function auth(refreshToken = 'refresh-1'): StoredAuth {
  return {
    apiBaseUrl: 'https://meoo.com',
    accessToken: 'access-1',
    refreshToken,
    accessExpiresAt: Date.now() + 3_600_000,
    scope: null,
    openid: null,
    username: null,
    userId: null,
    projectUrlId: null,
    serviceAk: null,
    serviceAkProjectId: null,
    lastSyncAt: 0,
    lastError: null,
  };
}

test('controlRequest 拦下「HTTP 200 + success:false」的业务错误', async () => {
  stubFetch(() => ({ status: 200, body: { success: false, errCode: 'E123', message: '项目不存在' } }));
  await assert.rejects(
    () => controlRequest(auth(), 'GET', '/open/v1/cli-compat/projects'),
    (error: unknown) => {
      assert.ok(error instanceof MeooError);
      assert.equal(error.errCode, 'E123');
      assert.match(error.message, /项目不存在/);
      return true;
    },
  );
});

test('controlRequest 返回 data 字段', async () => {
  stubFetch(() => ({ status: 200, body: { success: true, data: { name: 'someone' } } }));
  const data = await controlRequest(auth(), 'GET', '/open/v1/cli-compat/account/identity');
  assert.deepEqual(data, { name: 'someone' });
});

test('controlRequest 在 401 时续期一次并重试', async () => {
  let seen = 0;
  const stub = stubFetch((url) => {
    seen += 1;
    if (url.endsWith('/oauth/token')) {
      return { status: 200, body: { access_token: 'access-2', expires_in: 3600 } };
    }
    // 第一次用旧 token → 401；第二次用新 token → 成功。
    if (seen <= 1) return { status: 401, body: { detail: 'invalid_token' } };
    return { status: 200, body: { success: true, data: { ok: true } } };
  });

  const stored = auth('refresh-retry');
  const data = await controlRequest(stored, 'GET', '/open/v1/cli-compat/account/identity');
  assert.deepEqual(data, { ok: true });
  assert.equal(stored.accessToken, 'access-2', '续期后 token 必须就地更新');
  assert.ok(stub.calls.some((call) => call.url.endsWith('/oauth/token')));
});

test('controlRequest 续期后仍 401 时抛 expired，且不再无限重试', async () => {
  let tokenCalls = 0;
  stubFetch((url) => {
    if (url.endsWith('/oauth/token')) {
      tokenCalls += 1;
      return { status: 200, body: { access_token: 'access-x', expires_in: 3600 } };
    }
    return { status: 401, body: { detail: 'still invalid' } };
  });
  await assert.rejects(
    // 每次用一个全新的 refresh token：续期缓存按 refresh token 复用，
    // 用同一个会让第二个测试直接命中上一个的缓存、根本不打上游。
    () => controlRequest(auth('refresh-still-bad'), 'GET', '/open/v1/cli-compat/account/identity'),
    (error: unknown) => {
      assert.ok(error instanceof MeooError);
      assert.equal(error.expired, true);
      return true;
    },
  );
  assert.equal(tokenCalls, 1, '只续期一次');
});

test('fetchGatewayModels 解析目录并用 Bearer AK', async () => {
  const stub = stubFetch(() => ({
    status: 200,
    body: { models: [{ id: 'glm-5.2' }, { id: 'qwen3.8-flash' }] },
  }));
  const models = await fetchGatewayModels('meoo_project_service_v1.test');
  assert.equal(models.length, 2);
  const headers = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, 'Bearer meoo_project_service_v1.test');
});

test('fetchGatewayModels 在 401 时报「网关拒绝了这个 AK」', async () => {
  stubFetch(() => ({ status: 401, body: { error: { message: 'SERVICE_AK_MISSING' } } }));
  await assert.rejects(() => fetchGatewayModels('bad-ak'), (error: unknown) => {
    assert.ok(error instanceof MeooError);
    assert.equal(error.status, 401);
    assert.match(error.message, /拒绝/);
    return true;
  });
});

test('verifyServiceAk 拒绝用户 Key（meoo_ak_ 前缀）', async () => {
  // 不发请求就该被拦：用户 Key 与项目服务 AK 是两种东西。
  stubFetch(() => ({ status: 200, body: { models: [] } }));
  await assert.rejects(() => verifyServiceAk('meoo_ak_xxx'), (error: unknown) => {
    assert.ok(error instanceof MeooError);
    assert.match(error.message, /meoo_project_service_v1/);
    return true;
  });
});

test('verifyServiceAk 在空目录时报错（没开通 AI 服务）', async () => {
  stubFetch(() => ({ status: 200, body: { models: [] } }));
  await assert.rejects(() => verifyServiceAk('meoo_project_service_v1.test'), (error: unknown) => {
    assert.ok(error instanceof MeooError);
    assert.match(error.message, /空目录/);
    return true;
  });
});

test('parsePoints 解析余额、已用、冻结与批次', () => {
  const summary = parsePoints(
    {
      account: { availableBalance: 1234, totalConsumed: 567, frozenBalance: 8 },
      activeGrants: [
        { grantDetails: [{ remainingAmount: 100, expiresDate: '2026-12-01T00:00:00Z' }] },
        { grantDetails: [{ remainingAmount: 300, expiresDate: '2026-11-20' }] },
        // 已用完的批次不该出现。
        { grantDetails: [{ remainingAmount: 0, expiresDate: '2026-11-15' }] },
      ],
    },
    1_000,
  );
  assert.equal(summary.available, 1234);
  assert.equal(summary.consumed, 567);
  assert.equal(summary.frozen, 8);
  assert.equal(summary.grants.length, 2);
  // 排序：最近的到期日在最前。
  assert.equal(summary.nextExpiry, '2026-11-20');
  assert.equal(summary.grants[0]?.remaining, 300);
  assert.equal(summary.atMs, 1_000);
});

test('parsePoints 对空/坏响应给全零而不是抛', () => {
  for (const payload of [null, undefined, {}, { account: null }, 'nope']) {
    const summary = parsePoints(payload, 0);
    assert.equal(summary.available, 0);
    assert.equal(summary.consumed, 0);
    assert.equal(summary.frozen, 0);
    assert.deepEqual(summary.grants, []);
    assert.equal(summary.nextExpiry, null);
  }
});

// ---------------------------------------------------------------------------
// 手动贴回调地址：浏览器回调打不通时的兜底（代理 / 远程浏览器场景）。
// ---------------------------------------------------------------------------

test('extractAuthorizationCode 能吃下整条回调地址与裸 code', async () => {
  const { extractAuthorizationCode } = await import('../src/credentials/store.ts');
  assert.equal(
    extractAuthorizationCode('http://127.0.0.1:49669/oauth/callback?state=abc&code=xyz-123'),
    'xyz-123',
  );
  assert.equal(extractAuthorizationCode('  xyz-123  '), 'xyz-123');
  assert.equal(extractAuthorizationCode('http://127.0.0.1:1/oauth/callback?state=abc'), undefined, '没有 code 就是无效');
  assert.equal(extractAuthorizationCode('   '), undefined);
});

// ---------------------------------------------------------------------------
// pi-ai 的 OpenAI 兼容层会自动把 system 消息换成 `developer` 角色（前提是
// 它认为上游支持）。秒悟网关明确只接受 system/assistant/user/tool/function，
// 发 developer 直接 400：
//   developer is not one of ['system', 'assistant', 'user', 'tool', 'function']
// 这条测试锁住「compat 必须显式关掉它」，否则换 pi-ai 版本或改 baseUrl 时
// 会静默回归成「模型测试失败」。
// ---------------------------------------------------------------------------

test('pi-ai model 必须关掉 developer 角色，并只用 max_tokens', async () => {
  const { toPiModel } = await import('../src/llm/adapter.ts');
  const base = {
    id: 'qwen3.8-flash',
    name: 'Qwen3.8-Flash',
    contextWindow: 200_000,
    maxTokens: 64_000,
    vision: true,
    reasoning: true,
  };
  const reasoningModel = toPiModel(base, 'https://api.meoo.host/meoo-ai/compatible-mode/v1');
  assert.equal(reasoningModel.compat?.supportsDeveloperRole, false, '必须关掉 developer 角色');
  assert.equal(reasoningModel.compat?.maxTokensField, 'max_tokens', '网关只认 max_tokens');
  assert.equal(reasoningModel.compat?.supportsReasoningEffort, true, 'reasoning 模型要能发 reasoning_effort');
  assert.deepEqual(reasoningModel.thinkingLevelMap, { low: 'low', medium: 'medium', high: 'high' });

  const plainModel = toPiModel({ ...base, reasoning: false }, 'https://api.meoo.host/meoo-ai/compatible-mode/v1');
  assert.equal(plainModel.compat?.supportsDeveloperRole, false, '非 reasoning 模型同样不能发 developer');
  assert.equal(plainModel.compat?.supportsReasoningEffort, undefined, '非 reasoning 模型不发 reasoning_effort');
  assert.equal(plainModel.thinkingLevelMap, undefined);
});
