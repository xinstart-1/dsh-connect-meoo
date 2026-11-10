/**
 * 状态文档组装的测试。
 *
 * 这个函数存在的意义是让**缺省**只有一个定义处：页面在三种宿主版本上
 * （老版本没有 status 路由、新版本有、有但读不到）都要能渲染出同一句话。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatusDocument } from '../src/host/status.ts';

test('缺省段落全部给安全值', () => {
  const doc = buildStatusDocument({
    version: '0.0.1',
    login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true },
    models: [],
    gateway: 'https://api.meoo.host/meoo-ai/compatible-mode/v1',
  });
  assert.equal(doc.version, '0.0.1');
  assert.equal(doc.points.state, 'unavailable');
  assert.deepEqual(doc.points, { state: 'unavailable' });
  assert.deepEqual(doc.projects, []);
  assert.deepEqual(doc.settings.disabledModels, []);
  assert.equal(doc.settings.pollIntervalMs, 300_000);
  assert.equal(doc.settings.composerPill, true);
  assert.equal(doc.settings.sidebarPanel, false);
  assert.equal(doc.lastError, undefined);
  assert.ok(doc.readAtMs > 0);
});

test('传入的段落原样保留', () => {
  const doc = buildStatusDocument({
    version: '0.0.1',
    login: { state: 'signed-in', source: 'oauth', name: 'tester', hasServiceAk: true, canLogin: true },
    points: { state: 'ok', available: 100, consumed: 5, frozen: 0, nextExpiry: '2026-12-01' },
    projects: [{ urlId: 'p1', name: '项目一', selected: true }],
    activeProject: 'p1',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 128_000, vision: false, enabled: true },
    ],
    settings: { pollIntervalMs: 600_000, composerPill: false, sidebarPanel: true, disabledModels: [] },
    gateway: 'https://gw',
    lastError: 'something failed',
    nowMs: 42,
  });
  assert.equal(doc.login.name, 'tester');
  assert.equal(doc.points.available, 100);
  assert.equal(doc.activeProject, 'p1');
  assert.equal(doc.models.length, 1);
  assert.equal(doc.settings.pollIntervalMs, 600_000);
  assert.equal(doc.lastError, 'something failed');
  assert.equal(doc.readAtMs, 42);
});

test('空 lastError 不写进文档（诊断里显示「无」而不是空串）', () => {
  const doc = buildStatusDocument({
    version: '0.0.1',
    login: { state: 'signed-in', source: 'oauth', hasServiceAk: true, canLogin: true },
    models: [],
    gateway: 'https://gw',
    lastError: '',
  });
  assert.equal('lastError' in doc, false);
});
