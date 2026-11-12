/**
 * 多令牌存储：迁移、去重、切换、删除。
 *
 * 这些函数是「不把用户已有令牌弄丢」的唯一防线，所以单独钉。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activateToken,
  clearAuth,
  listTokens,
  maskToken,
  normalizeAuth,
  removeToken,
  upsertToken,
  type StoredAuth,
} from '../src/credentials/store.ts';

/** 一份旧版（单令牌）登录态。 */
function legacy(): Record<string, unknown> {
  return {
    apiBaseUrl: 'https://meoo.com',
    apiKey: 'meoo_ak_legacy_secret_1234',
    username: '老账号',
    projectUrlId: 'p1',
    serviceAk: 'meoo_project_service_v1.old',
    serviceAkProjectId: 'p1',
  };
}

test('旧版单令牌会迁移成一条 cred_legacy，且顶层字段保持不变', () => {
  const auth = normalizeAuth(legacy());
  assert.equal(auth.activeId, 'cred_legacy');
  assert.equal(auth.credentials?.length, 1);
  assert.equal(auth.credentials?.[0]?.kind, 'apikey');
  assert.equal(auth.apiKey, 'meoo_ak_legacy_secret_1234');
  assert.equal(auth.username, '老账号');
  const list = listTokens(auth);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.active, true);
  assert.equal(list[0]?.masked, 'meoo_ak_…1234');
});

test('同一个 API Key 再保存一次是更新，不会出现两条', () => {
  let auth = normalizeAuth(legacy());
  auth = upsertToken(auth, {
    kind: 'apikey',
    apiKey: 'meoo_ak_legacy_secret_1234',
    username: '改名了',
    projectUrlId: 'p2',
    serviceAk: 'meoo_project_service_v1.new',
    serviceAkProjectId: 'p2',
  });
  assert.equal(listTokens(auth).length, 1);
  assert.equal(auth.username, '改名了');
  assert.equal(auth.serviceAk, 'meoo_project_service_v1.new');
});

test('新增第二个令牌不会覆盖第一个，activeId 指向新增项', () => {
  let auth = normalizeAuth(legacy());
  auth = upsertToken(auth, {
    kind: 'oauth',
    accessToken: 'oauth-access-bbbb',
    refreshToken: 'oauth-refresh-bbbb',
    accessExpiresAt: Date.now() + 3_600_000,
    username: 'B 账号',
  });
  assert.equal(listTokens(auth).length, 2);
  assert.equal(listTokens(auth).filter((item) => item.active).length, 1);
  assert.equal(listTokens(auth).find((item) => item.active)?.name, 'B 账号');
  assert.equal(auth.apiKey, null, '切到 OAuth 后顶层 API Key 必须清空');
});

test('同一账号的 API Key 与 OAuth 令牌并存，不互相覆盖', () => {
  let auth = normalizeAuth(legacy());
  auth = upsertToken(auth, {
    kind: 'oauth',
    accessToken: 'oauth-same-user',
    refreshToken: 'oauth-refresh-same-user',
    accessExpiresAt: Date.now() + 3_600_000,
    username: '同一个人',
    userId: 'u-1',
  });
  assert.equal(listTokens(auth).length, 2);

  // 再贴这个账号的 API Key：userId 相同，但必须新增，不能把 OAuth 那份改成 API Key。
  auth = upsertToken(auth, {
    kind: 'apikey',
    apiKey: 'meoo_ak_same_user',
    username: '同一个人',
    userId: 'u-1',
  });
  assert.equal(listTokens(auth).length, 3);
  const oauth = listTokens(auth).filter((item) => item.kind === 'oauth');
  assert.equal(oauth.length, 1, 'OAuth 令牌必须还在');
  const stored = auth.credentials?.find((item) => item.kind === 'oauth');
  assert.equal(stored?.accessToken, 'oauth-same-user');
  assert.equal(stored?.refreshToken, 'oauth-refresh-same-user');
});

test('切换令牌会同步顶层字段（老插件仍能读到当前令牌）', () => {
  let auth = normalizeAuth(legacy());
  auth = upsertToken(auth, {
    kind: 'oauth',
    accessToken: 'oauth-access-bbbb',
    refreshToken: 'oauth-refresh-bbbb',
    accessExpiresAt: Date.now() + 3_600_000,
    username: 'B 账号',
  });
  const b = listTokens(auth).find((item) => item.name === 'B 账号');
  assert.ok(b !== undefined);
  auth = activateToken(auth, b.id);
  assert.equal(auth.activeId, b.id);
  assert.equal(auth.accessToken, 'oauth-access-bbbb');
  assert.equal(auth.apiKey, null);
  assert.equal(auth.refreshToken, 'oauth-refresh-bbbb');
});

test('删除当前令牌会顺位切到剩下的第一份；删空则清空登录态', () => {
  let auth = normalizeAuth(legacy());
  auth = upsertToken(auth, {
    kind: 'oauth',
    accessToken: 'oauth-access-bbbb',
    refreshToken: 'oauth-refresh-bbbb',
    accessExpiresAt: Date.now() + 3_600_000,
    username: 'B 账号',
  });
  const active = auth.activeId;
  assert.ok(active !== null && active !== undefined);
  auth = removeToken(auth, active);
  assert.equal(listTokens(auth).length, 1);
  assert.equal(auth.activeId, 'cred_legacy');
  assert.equal(auth.apiKey, 'meoo_ak_legacy_secret_1234');

  auth = removeToken(auth, 'cred_legacy');
  assert.deepEqual(listTokens(auth), []);
  assert.equal(auth.apiKey, null);
  assert.equal(auth.accessToken, null);
});

test('clearAuth 清掉所有令牌但保留主站地址', () => {
  const auth: StoredAuth = normalizeAuth(legacy());
  const cleared = clearAuth(auth);
  assert.equal(cleared.apiBaseUrl, 'https://meoo.com');
  assert.equal(cleared.credentials?.length, 0);
  assert.equal(cleared.activeId, null);
  assert.deepEqual(listTokens(cleared), []);
});

test('maskToken 只留可辨认前后缀，不泄露完整值', () => {
  assert.equal(maskToken('meoo_ak_abcdef1234'), 'meoo_ak_…1234');
  assert.equal(maskToken('oauth-access-bbbb'), '…bbbb');
  assert.equal(maskToken(''), '—');
});
