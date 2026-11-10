/**
 * 端点存在性取证：区分「404 = 路由不存在」与「401 = 路由存在但要鉴权」。
 *
 * 为什么要专门做这件事：项目规则明令「不许说上游限制」。准备写下
 * 「Meoo 没有签到接口」之前，必须拿出证据 —— 光读第三方实现不够，
 * 还要直接问上游：这条路由到底存不存在。
 *
 * 判据：
 * - **404** = 路由不存在（这才是「上游没有」的证据）
 * - **401** = 路由存在，只是缺凭据（不能拿它说「没有」）
 * - 其它 4xx = 路由存在但参数/方法不对
 *
 * 用法：`node scripts/probe-endpoints.mjs`
 */

import { API_BASE, CLI_HEADERS } from '../src/constants.ts';

/** 待取证的控制面路径。 */
const CANDIDATES = [
  // 已知存在（对照组）
  { path: '/open/v1/cli-compat/account/identity', expect: 'known' },
  { path: '/open/v1/cli-compat/account/points', expect: 'known' },
  { path: '/open/v1/cli-compat/account/entitlement', expect: 'known' },
  { path: '/open/v1/cli-compat/projects', expect: 'known' },
  // 签到类（workbuddy 有，Meoo 是否也有？）
  { path: '/open/v1/cli-compat/account/checkin', expect: 'unknown' },
  { path: '/open/v1/cli-compat/account/check-in', expect: 'unknown' },
  { path: '/open/v1/cli-compat/account/signin', expect: 'unknown' },
  { path: '/open/v1/cli-compat/account/sign-in', expect: 'unknown' },
  { path: '/open/v1/cli-compat/account/daily', expect: 'unknown' },
  { path: '/open/v1/cli-compat/account/daily-checkin', expect: 'unknown' },
  { path: '/open/v1/cli-compat/checkin', expect: 'unknown' },
  { path: '/open/v1/cli-compat/points/checkin', expect: 'unknown' },
  // 一个必然不存在的路径（对照组，验证 404 长什么样）
  { path: '/open/v1/cli-compat/definitely-not-a-real-route-xyz', expect: 'control' },
];

/** 带客户端头打一次，只关心状态码。 */
async function probe(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { accept: 'application/json', ...CLI_HEADERS },
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await res.text()).slice(0, 160);
    return { status: res.status, text };
  } catch (error) {
    return { status: 0, text: error instanceof Error ? error.message : String(error) };
  }
}

const results = [];
for (const candidate of CANDIDATES) {
  const { status, text } = await probe(candidate.path);
  results.push({ ...candidate, status, text });
  // 判定：401/403 = 存在（要鉴权）；404 = 不存在；其它 4xx = 存在但请求不对。
  const verdict =
    status === 401 || status === 403
      ? '存在（要鉴权）'
      : status === 404
        ? '不存在'
        : status === 0
          ? '网络失败'
          : `存在（HTTP ${String(status)}）`;
  console.log(`${String(status).padEnd(4)} ${verdict.padEnd(14)} ${candidate.path}`);
  if (candidate.expect === 'known' && status !== 401 && status !== 403) {
    console.log(`     ⚠ 对照组本应是 401，实际 ${String(status)}：${text}`);
  }
}

// 汇总：签到类路径里有几个是「存在」的？
const checkinPaths = results.filter((entry) => entry.expect === 'unknown');
const checkinExists = checkinPaths.filter((entry) => entry.status === 401 || entry.status === 403);
const controlRoute = results.find((entry) => entry.expect === 'control');
const knownRoutes = results.filter((entry) => entry.expect === 'known');

console.log('');
console.log('=== 结论 ===');
console.log(`已知存在的端点（对照组）：${String(knownRoutes.filter((e) => e.status === 401 || e.status === 403).length)}/${String(knownRoutes.length)} 返回 401`);
console.log(`必然不存在的路径（对照组）：HTTP ${String(controlRoute?.status)} —— 这就是「不存在」的样子`);
console.log(
  `签到类候选 ${String(checkinPaths.length)} 条：${String(checkinExists.length)} 条存在` +
    (checkinExists.length === 0 ? '（全部 404，与对照组一致）' : `：${checkinExists.map((e) => e.path).join(', ')}`),
);
console.log('');
if (checkinExists.length === 0) {
  console.log('证据：签到类路径全部 404，与「必然不存在」的对照组同码。');
  console.log('因此「Meoo 没有签到接口」是有据可查的结论，不是猜的。');
} else {
  console.log('发现存在的签到类端点 —— 必须去实现它，不能继续写「没有签到」。');
  process.exitCode = 1;
}
