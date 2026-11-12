/**
 * 每日登录积分：日期/时刻、API Key 与 OAuth 的差异化结果、多令牌逐个跑。
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  claimDailyGrant,
  isCheckinDue,
  nextCheckinAt,
  runCheckin,
  shanghaiDate,
} from '../src/host/checkin.ts';
import { normalizeAuth, upsertToken, type StoredAuth } from '../src/credentials/store.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 装一个按「方法 + 路径」作答的假 fetch。 */
function stubFetch(routes: Array<{ method?: string; match: (url: string) => boolean; status?: number; body: unknown }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const route of routes) {
      if ((route.method ?? 'GET') === method && route.match(url)) {
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ detail: 'no route' }), { status: 404 });
  }) as typeof fetch;
}

/** 今天（UTC+8）的积分批次。 */
function pointsWithDaily(remaining = 2000): unknown {
  return {
    account: { availableBalance: 4321, totalConsumed: 10, frozenBalance: 0 },
    activeGrants: [
      {
        sourceType: 'DAILY_LOGIN',
        grantDetails: [
          {
            remainingAmount: remaining,
            expiresDate: '2026-11-19T23:59:59',
            effectiveDate: `${shanghaiDate(Date.now())}T00:00:00`,
          },
        ],
      },
    ],
  };
}

function apiKeyAuth(): StoredAuth {
  return normalizeAuth({
    apiBaseUrl: 'https://meoo.com',
    apiKey: 'meoo_ak_test_1234',
    username: 'API 账号',
  });
}

function oauthAuth(): StoredAuth {
  return normalizeAuth({
    apiBaseUrl: 'https://meoo.com',
    accessToken: 'oauth-access',
    refreshToken: 'oauth-refresh',
    accessExpiresAt: Date.now() + 3_600_000,
    username: 'OAuth 账号',
  });
}

test('UTC+8 日期与签到时刻换算', () => {
  // 2026-11-12 01:00Z = 北京时间 09:00
  const nine = Date.UTC(2026, 10, 12, 1, 0, 0);
  assert.equal(shanghaiDate(nine), '2026-11-12');
  // 北京时间 10:00 = 02:00Z
  assert.equal(nextCheckinAt('10:00', nine), Date.UTC(2026, 10, 12, 2, 0, 0));
  assert.equal(isCheckinDue(null, '10:00', nine), false);
  assert.equal(isCheckinDue(null, '10:00', Date.UTC(2026, 10, 12, 2, 0, 0)), true);
  assert.equal(isCheckinDue('2026-11-12', '10:00', Date.UTC(2026, 10, 12, 3, 0, 0)), false);
  // 过了点就是明天，不会「补昨天的」
  assert.equal(nextCheckinAt('10:00', Date.UTC(2026, 10, 12, 3, 0, 0)), Date.UTC(2026, 10, 13, 2, 0, 0));
});

test('API Key 今天已有批次 → already，不去打 403 的领取接口', async () => {
  stubFetch([{ match: (url) => url.includes('/account/points'), body: pointsWithDaily(1800) }]);
  const result = await claimDailyGrant(apiKeyAuth());
  assert.equal(result.status, 'already');
  assert.equal(result.amount, 1800);
});

test('API Key 今天没有批次 → unsupported，并给出 403 证据', async () => {
  stubFetch([{ match: (url) => url.includes('/account/points'), body: { account: { availableBalance: 1 }, activeGrants: [] } }]);
  const result = await claimDailyGrant(apiKeyAuth());
  assert.equal(result.status, 'unsupported');
  assert.match(result.message ?? '', /HTTP 403/);
  assert.match(result.message ?? '', /API_KEY_ROUTE_FORBIDDEN/);
});

test('OAuth 没有批次 → 调 entitlement/init 并回读确认 granted', async () => {
  let calls = 0;
  stubFetch([
    {
      match: (url) => url.includes('/account/points'),
      body: calls++ === 0 ? { account: { availableBalance: 2321 }, activeGrants: [] } : pointsWithDaily(2000),
    },
    {
      method: 'POST',
      match: (url) => url.includes('/api/mc/entitlement/init'),
      body: { success: true, data: { initialized: true, dailyLoginGranted: true, dailyLoginGrantAmount: 2000 } },
    },
  ]);
  const result = await claimDailyGrant(oauthAuth());
  assert.equal(result.status, 'granted');
  assert.equal(result.amount, 2000);
});

test('OAuth 领取接口拒绝（403）→ unsupported，不伪造成功', async () => {
  stubFetch([
    { match: (url) => url.includes('/account/points'), body: { account: { availableBalance: 1 }, activeGrants: [] } },
    {
      method: 'POST',
      match: (url) => url.includes('/api/mc/entitlement/init'),
      status: 403,
      body: { success: false, errCode: 'API_KEY_ROUTE_FORBIDDEN', message: 'API Key 不允许访问此接口' },
    },
  ]);
  const result = await claimDailyGrant(oauthAuth());
  assert.equal(result.status, 'unsupported');
  assert.match(result.message ?? '', /403/);
});

test('多令牌会逐个跑，且保留原来的当前令牌', async () => {
  let auth = oauthAuth();
  auth = upsertToken(auth, { kind: 'apikey', apiKey: 'meoo_ak_other_5678', username: '另一个账号' });
  const activeBefore = auth.activeId;
  assert.ok(activeBefore !== null && activeBefore !== undefined);

  stubFetch([
    { match: (url) => url.includes('/account/points'), body: pointsWithDaily(2000) },
    { method: 'POST', match: (url) => url.includes('/api/mc/entitlement/init'), body: { success: true, data: {} } },
  ]);
  const result = await runCheckin(auth);
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every((record) => record.status === 'already'));
  assert.equal(result.auth.activeId, activeBefore, '跑完签到必须切回用户原来的账号');
});
