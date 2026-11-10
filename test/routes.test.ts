/**
 * 宿主路由的测试：回环判定、方法限制、动作白名单、请求体处理。
 *
 * 这些是**安全边界**，不是普通功能 —— 一条被绕过的白名单等于把上游任意接口
 * 暴露给任何能打开页面的人。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTION_PATH, STATUS_PATH, isLoopbackHost, registerRoutes } from '../src/host/routes.ts';

test('isLoopbackHost 认整个 127.0.0.0/8 与 localhost', () => {
  for (const host of [
    '127.0.0.1',
    '127.0.0.1:61487',
    '127.1.2.3',
    '127.255.255.255:80',
    'localhost',
    'localhost:3000',
    'LOCALHOST:8080',
    '[::1]',
    '[::1]:61487',
    '::1',
  ]) {
    assert.equal(isLoopbackHost(host), true, `${host} 应判为本机`);
  }
});

test('isLoopbackHost 拒绝一切非回环地址', () => {
  for (const host of [
    undefined,
    '',
    '   ',
    '192.168.1.10',
    '10.0.0.1:8080',
    'example.com',
    'evil.example.com:61487',
    '0.0.0.0',
    '128.0.0.1',
    '127.0.0.1.evil.com',
  ]) {
    assert.equal(isLoopbackHost(host), false, `${String(host)} 不该判为本机`);
  }
});

/** 起一个假的 webServer，返回已注册的路由表。 */
function fakeHost(): {
  routes: Map<string, (req: FakeRequest, res: FakeResponse) => void | Promise<void>>;
  host: Parameters<typeof registerRoutes>[0];
} {
  const routes = new Map<string, (req: FakeRequest, res: FakeResponse) => void | Promise<void>>();
  const host = {
    inject(services: readonly string[], callback: (webCtx: unknown) => void): void {
      assert.deepEqual([...services], ['webServer']);
      callback({
        effect(fn: () => () => void) {
          fn();
        },
        webServer: {
          register(entry: { kind: string; path: string; handler: never }) {
            routes.set(entry.path, entry.handler);
            return () => routes.delete(entry.path);
          },
        },
      });
    },
  } as unknown as Parameters<typeof registerRoutes>[0];
  return { routes, host };
}

interface FakeRequest {
  headers: Record<string, string | undefined>;
  method: string;
  url: string;
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

interface FakeResponse {
  status?: number;
  payload?: unknown;
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string>): FakeResponse;
  end(body?: string): void;
}

function makeRequest(options: {
  host?: string;
  method?: string;
  url?: string;
  body?: string;
}): FakeRequest {
  const body = options.body === undefined ? '' : options.body;
  let consumed = false;
  return {
    headers: { host: options.host ?? '127.0.0.1:61487' },
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
      if (consumed) return;
      consumed = true;
      if (body !== '') yield Buffer.from(body, 'utf8');
    },
  };
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    status: undefined,
    payload: undefined,
    headersSent: false,
    writeHead(status: number): FakeResponse {
      response.status = status;
      response.headersSent = true;
      return response;
    },
    end(body?: string): void {
      response.payload = body === undefined ? undefined : JSON.parse(body);
    },
  };
  return response;
}

test('注册了 status 与 action 两条路由', () => {
  const { routes, host } = fakeHost();
  registerRoutes(host, { status: async () => ({}), action: async () => ({}) });
  assert.ok(routes.has(STATUS_PATH));
  assert.ok(routes.has(ACTION_PATH));
});

test('status 路由只接受 GET，且只给回环 Host', async () => {
  const { routes, host } = fakeHost();
  registerRoutes(host, { status: async () => ({ version: '0.0.1' }), action: async () => ({}) });
  const handler = routes.get(STATUS_PATH)!;

  const ok = makeResponse();
  await handler(makeRequest({}), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { version: '0.0.1' });

  const wrongMethod = makeResponse();
  await handler(makeRequest({ method: 'POST' }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const remote = makeResponse();
  await handler(makeRequest({ host: '192.168.1.5:61487' }), remote);
  assert.equal(remote.status, 403, '非回环 Host 必须被拒');
});

test('action 路由只接受 POST，且动作走白名单', async () => {
  const { routes, host } = fakeHost();
  const seen: Array<{ action: string; body: Record<string, unknown> }> = [];
  registerRoutes(host, {
    status: async () => ({}),
    action: async (action, body) => {
      seen.push({ action, body });
      return { ok: true };
    },
  });
  const handler = routes.get(ACTION_PATH)!;

  const ok = makeResponse();
  await handler(makeRequest({ method: 'POST', url: `${ACTION_PATH}?action=refresh` }), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { ok: true });
  assert.deepEqual(seen, [{ action: 'refresh', body: {} }]);

  const wrongMethod = makeResponse();
  await handler(makeRequest({ method: 'GET', url: `${ACTION_PATH}?action=refresh` }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  // 白名单外：不调用 deps.action，回一个 ok:false。
  const unknown = makeResponse();
  await handler(makeRequest({ method: 'POST', url: `${ACTION_PATH}?action=drop-database` }), unknown);
  assert.equal(unknown.status, 200);
  assert.equal((unknown.payload as { ok: boolean }).ok, false);
  assert.equal(seen.length, 1, '白名单外不该调用业务动作');
});

test('action 路由把 body 解析成对象，坏 JSON 当空对象', async () => {
  const { routes, host } = fakeHost();
  const seen: Record<string, unknown>[] = [];
  registerRoutes(host, {
    status: async () => ({}),
    action: async (_action, body) => {
      seen.push(body);
      return { ok: true };
    },
  });
  const handler = routes.get(ACTION_PATH)!;

  await handler(
    makeRequest({ method: 'POST', url: `${ACTION_PATH}?action=settings`, body: '{"composerPill":false}' }),
    makeResponse(),
  );
  assert.deepEqual(seen[0], { composerPill: false });

  await handler(
    makeRequest({ method: 'POST', url: `${ACTION_PATH}?action=settings`, body: '{ broken' }),
    makeResponse(),
  );
  assert.deepEqual(seen[1], {}, '坏 JSON 当空对象，不抛');

  // 数组不是对象：当空对象处理。
  await handler(
    makeRequest({ method: 'POST', url: `${ACTION_PATH}?action=settings`, body: '[1,2,3]' }),
    makeResponse(),
  );
  assert.deepEqual(seen[2], {});
});

test('action 路由把业务异常转成 ok:false，不让请求 500', async () => {
  const { routes, host } = fakeHost();
  registerRoutes(host, {
    status: async () => ({}),
    action: async () => {
      throw new Error('上游炸了');
    },
  });
  const response = makeResponse();
  await routes.get(ACTION_PATH)!(makeRequest({ method: 'POST', url: `${ACTION_PATH}?action=login` }), response);
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, { ok: false, error: '上游炸了' });
});
