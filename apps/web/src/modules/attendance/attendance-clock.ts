import {
  ApiError,
  type AuthUser,
  type AttendanceClockInput,
  type AttendanceClockResult,
} from '@tyde/shared';

export const CLOCK_TIMEZONE = 'Asia/Shanghai';
export interface ClockScope {
  orgId: string | null;
  name: string;
}
const participating = (value: unknown) =>
  ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(value));
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** 默认组织由服务端选定，不能用数组首项、账号类型或读取失败来推断个人范围。 */
export function attendanceClockScope(user: AuthUser): ClockScope {
  if ((user.selectedRole ?? user.role) !== 'EXPERT') throw new Error('请切换至执行专家身份打卡。');
  const organizations = user.organizations?.filter((org) => participating(org.joinStatus));
  if (user.organization) {
    const org = user.organization;
    if (
      !uuid(org.id) ||
      !participating(org.joinStatus) ||
      (organizations &&
        !organizations.some((item) => item.id.toLowerCase() === String(org.id).toLowerCase()))
    )
      throw new Error('当前默认组织身份尚未确认，请重新读取身份后打卡。');
    return {
      orgId: org.id.toLowerCase(),
      name: typeof org.name === 'string' && org.name.trim() ? org.name.trim() : '当前组织',
    };
  }
  if (organizations?.length) throw new Error('当前存在有效组织但默认组织未确认，请重新读取身份。');
  return { orgId: null, name: '个人考勤' };
}
export function attendanceClockInput(
  scope: ClockScope,
  idempotencyKey = crypto.randomUUID(),
): AttendanceClockInput {
  return {
    ...(scope.orgId ? { orgId: scope.orgId } : {}),
    timezone: CLOCK_TIMEZONE,
    idempotencyKey,
  };
}
export function clockReceiptMatches(
  result: AttendanceClockResult,
  userId: string,
  scope: ClockScope,
) {
  return (
    result.userId.toLowerCase() === userId.toLowerCase() &&
    (result.orgId?.toLowerCase() ?? null) === scope.orgId
  );
}
export function clockFailureIsUnknown(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    ['INVALID_RESPONSE', 'SESSION_CHANGED'].includes(String(error.code)) ||
    ![400, 401, 403, 404, 409, 413, 422, 429].includes(error.status)
  );
}
