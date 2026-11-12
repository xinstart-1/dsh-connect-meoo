/**
 * 每日登录积分：逐令牌领取 / 核对。
 *
 * 秒悟的「签到」不是一个独立的 check-in 接口，而是**每日首次登录赠送积分**
 * （`daily_login`，2000 分，7 天有效）。网页端在启动时调用
 * `POST /api/mc/entitlement/init` 领取；该接口只认浏览器会话 ——
 * 用 API Key 打它会返回 `HTTP 403 API_KEY_ROUTE_FORBIDDEN`。
 *
 * 所以这里做两件事，并且**不把「核对」说成「领取」**：
 *
 * - OAuth 令牌：真的调 `/api/mc/entitlement/init`，再回读积分确认；
 * - API Key 令牌：读积分/权益，报告「今天是否已有批次」。没有就如实报
 *   `unsupported`，附上 403 证据，提示用浏览器授权一次 —— 不伪造成功。
 *
 * 为什么值得做：一个账号一天只发一次，但**每个账号都要有人去触发**。
 * 多令牌用户以前只有当前账号会被打开，其余账号的每日额度就白白过期。
 *
 * @module dsh-connect-meoo/host/checkin
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AUTH_DIRNAME, CHECKIN_FILENAME, DAILY_GRANT_PATH } from '../constants.ts';
import {
  activateToken,
  dshHome,
  listTokens,
  maskToken,
  upsertToken,
  type StoredAuth,
} from '../credentials/store.ts';
import { MeooError, controlRequest, fetchPoints, type PointsSummary } from '../protocol/client.ts';

/** 一次签到的结果分类。 */
export type CheckinStatus = 'granted' | 'already' | 'unsupported' | 'failed';

/** 一个令牌的签到结果（落盘与界面共用）。 */
export interface CheckinRecord {
  credentialId: string;
  /** 账号展示名（拿不到时用脱敏标签）。 */
  name: string;
  kind: 'apikey' | 'oauth';
  status: CheckinStatus;
  /** 今天这一批每日登录积分的剩余额度（拿得到才有）。 */
  amount?: number;
  /** 失败/不支持时的原文，便于整段贴进反馈。 */
  message?: string;
  atMs: number;
}

/** 落盘的签到状态。 */
export interface CheckinState {
  version: 1;
  /** 最近一次完整跑完的日期（`YYYY-MM-DD`，UTC+8）。 */
  lastRunDate: string | null;
  lastRunAtMs: number;
  records: CheckinRecord[];
}

/** 默认状态。 */
export const EMPTY_CHECKIN: CheckinState = Object.freeze({
  version: 1,
  lastRunDate: null,
  lastRunAtMs: 0,
  records: [],
}) as CheckinState;

/** 签到记录文件路径。 */
export function checkinFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), AUTH_DIRNAME, CHECKIN_FILENAME);
}

/** UTC+8 的日期字符串（秒悟的活动按北京时间算）。 */
export function shanghaiDate(nowMs: number): string {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 把 `HH:MM` 解析成分钟数；非法返回 undefined。 */
export function parseCheckinTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match === null ? undefined : `${match[1]}:${match[2]}`;
}

/** 某一天的 `HH:MM`（UTC+8）对应的绝对时刻。 */
function todayAt(time: string, nowMs: number): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const shifted = new Date(nowMs + 8 * 3_600_000);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute) -
    8 * 3_600_000
  );
}

/** 下一次签到时刻（今天的点过了就是明天）。 */
export function nextCheckinAt(time: string, nowMs: number): number {
  const target = todayAt(time, nowMs);
  return target > nowMs ? target : target + 86_400_000;
}

/**
 * 现在是否该跑一次（今天的点已到，且今天还没跑过）。
 * @param lastRunDate - 上次完整跑完的日期。
 * @param time - `HH:MM`。
 * @param nowMs - 当前时刻。
 */
export function isCheckinDue(lastRunDate: string | null, time: string, nowMs: number): boolean {
  const today = shanghaiDate(nowMs);
  return lastRunDate !== today && nowMs >= todayAt(time, nowMs);
}

/** 读签到记录（坏文件回落空状态，永不抛）。 */
export async function readCheckinState(env: NodeJS.ProcessEnv = process.env): Promise<CheckinState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(checkinFile(env), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_CHECKIN };
    const record = parsed as Record<string, unknown>;
    const records: CheckinRecord[] = [];
    for (const entry of Array.isArray(record.records) ? record.records : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.credentialId !== 'string' || typeof row.atMs !== 'number') continue;
      const status: CheckinStatus =
        row.status === 'granted' || row.status === 'already' || row.status === 'unsupported'
          ? row.status
          : 'failed';
      records.push({
        credentialId: row.credentialId,
        name: typeof row.name === 'string' ? row.name : row.credentialId,
        kind: row.kind === 'oauth' ? 'oauth' : 'apikey',
        status,
        ...(typeof row.amount === 'number' ? { amount: row.amount } : {}),
        ...(typeof row.message === 'string' ? { message: row.message } : {}),
        atMs: row.atMs,
      });
    }
    return {
      version: 1,
      lastRunDate: typeof record.lastRunDate === 'string' ? record.lastRunDate : null,
      lastRunAtMs: typeof record.lastRunAtMs === 'number' ? record.lastRunAtMs : 0,
      records: records.slice(-20),
    };
  } catch {
    return { ...EMPTY_CHECKIN };
  }
}

/** 原子写签到记录（权限 0o600）。 */
export async function writeCheckinState(
  state: CheckinState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = checkinFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...state, records: state.records.slice(-20) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, file);
}

/** 从积分批次里找「今天」的每日登录批次。 */
export function dailyGrantToday(points: PointsSummary, today: string): PointsSummary['grants'][number] | undefined {
  return points.grants.find(
    (grant) => grant.sourceType === 'DAILY_LOGIN' && (grant.effectiveDate ?? '').startsWith(today),
  );
}

/** 一个令牌的领取结果。 */
export interface ClaimResult {
  status: CheckinStatus;
  amount?: number;
  message?: string;
}

/** 网页会话接口的响应（只在字段存在时读）。 */
interface DailyGrantResponse {
  initialized?: boolean;
  dailyLoginGranted?: boolean;
  dailyLoginGrantAmount?: number;
}

/**
 * 为一个令牌领取/核对今天的每日登录积分。
 *
 * @param auth - **只含一个令牌**的登录态（`activateToken` 的结果）。
 * @param nowMs - 当前时刻。
 * @returns 结果；不会抛。
 */
export async function claimDailyGrant(auth: StoredAuth, nowMs: number = Date.now()): Promise<ClaimResult> {
  const today = shanghaiDate(nowMs);
  let before: PointsSummary;
  try {
    before = await fetchPoints(auth);
  } catch (error) {
    return { status: 'failed', message: messageOf(error) };
  }
  const existing = dailyGrantToday(before, today);
  if (existing !== undefined) {
    return { status: 'already', amount: existing.remaining };
  }

  // API Key 打网页会话接口会被拒（403 API_KEY_ROUTE_FORBIDDEN），
  // 这一步不去自讨没趣；如实报告「需要网页会话」。
  if (typeof auth.apiKey === 'string' && auth.apiKey !== '') {
    return {
      status: 'unsupported',
      message:
        '该令牌是 API Key：每日登录积分由网页会话领取，API Key 调用 /api/mc/entitlement/init 会得到 HTTP 403 API_KEY_ROUTE_FORBIDDEN。用浏览器授权登录这个账号一次后，插件就能自动领取。',
    };
  }

  let granted = false;
  let amount = 0;
  let initialized = true;
  try {
    const data = (await controlRequest(auth, 'POST', DAILY_GRANT_PATH, {})) as DailyGrantResponse | null;
    granted = data?.dailyLoginGranted === true;
    amount = typeof data?.dailyLoginGrantAmount === 'number' ? data.dailyLoginGrantAmount : 0;
    initialized = data?.initialized !== false;
  } catch (error) {
    if (error instanceof MeooError && error.status === 403) {
      return {
        status: 'unsupported',
        message: `上游拒绝了这次领取（HTTP 403）：${messageOf(error)}`,
      };
    }
    return { status: 'failed', message: messageOf(error) };
  }

  // 回读确认：网页端也是以「积分批次里出现今天的 daily_login」为准。
  try {
    const after = await fetchPoints(auth);
    const now = dailyGrantToday(after, today);
    if (now !== undefined) {
      return { status: granted || amount > 0 ? 'granted' : 'already', amount: now.remaining };
    }
  } catch {
    // 回读失败时以 init 的响应为准（不把一次网络抖动说成失败）。
  }
  if (granted || amount > 0) return { status: 'granted', amount };
  return {
    status: 'already',
    ...(initialized ? {} : { message: '网页会话没有完成初始化，未确认今天的每日登录积分' }),
  };
}

/**
 * 逐个令牌跑一遍签到/核对。
 *
 * 顺序执行（不并发）：每个账号一次控制面请求，串行更容易在上游限流下活下来，
 * 也让日志顺序稳定。单个令牌失败不影响其余令牌。
 *
 * @param auth - 完整登录态（含全部令牌）。
 * @param nowMs - 当前时刻。
 * @returns 每个令牌的结果，以及可能被 OAuth 续期更新过的登录态。
 */
export async function runCheckin(
  auth: StoredAuth,
  nowMs: number = Date.now(),
): Promise<{ records: CheckinRecord[]; auth: StoredAuth }> {
  const records: CheckinRecord[] = [];
  let working = auth;
  const activeBefore = auth.activeId ?? null;

  for (const token of listTokens(auth)) {
    const single = activateToken(working, token.id);
    const result = await claimDailyGrant(single, nowMs);
    const name = single.username !== null && single.username !== undefined && single.username !== ''
      ? single.username
      : token.kind === 'apikey'
        ? maskToken(single.apiKey)
        : maskToken(single.accessToken);
    records.push({
      credentialId: token.id,
      name,
      kind: token.kind,
      status: result.status,
      ...(result.amount === undefined || result.amount <= 0 ? {} : { amount: result.amount }),
      ...(result.message === undefined ? {} : { message: result.message }),
      atMs: nowMs,
    });
    // 把 OAuth 续期后的 token 写回列表；`upsertToken` 会激活这一项，随后恢复原选择。
    working = upsertToken(working, {
      id: token.id,
      kind: token.kind,
      apiKey: single.apiKey ?? null,
      accessToken: single.accessToken ?? null,
      refreshToken: single.refreshToken ?? null,
      accessExpiresAt: single.accessExpiresAt ?? 0,
      scope: single.scope ?? null,
      openid: single.openid ?? null,
      username: single.username ?? null,
      userId: single.userId ?? null,
      projectUrlId: single.projectUrlId ?? null,
      serviceAk: single.serviceAk ?? null,
      serviceAkProjectId: single.serviceAkProjectId ?? null,
      savedAt: token.savedAt,
    });
  }

  if (activeBefore !== null && listTokens(working).some((token) => token.id === activeBefore)) {
    working = activateToken(working, activeBefore);
  }
  return { records, auth: working };
}

/** 错误原文（不翻译、不概括）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
