import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  type AuthUser,
  type WorkbenchApplication,
  type WorkbenchAttendanceApplicationResult,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { SESSION_KEY } from '@/hooks/useSession';
import { OrganizationDialog } from '@/modules/organizations/common';
import { api } from '@/services/api';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 仅处理本人列表中的待审考勤申请；退出组织不支持此撤回接口。 */
export function ProfileApplicationWithdrawal({
  application,
  userId,
  onSuccess,
  onRefresh,
}: {
  application: WorkbenchApplication;
  userId: string;
  onSuccess: (result: WorkbenchAttendanceApplicationResult) => Promise<void>;
  onRefresh: () => Promise<unknown>;
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const allowed =
    application.status === 'PENDING' &&
    ['ATTENDANCE_LEAVE', 'ATTENDANCE_CORRECTION'].includes(application.businessType) &&
    application.canWithdraw !== false &&
    uuid.test(application.applicationId) &&
    Number.isInteger(application.flowVersionNo) &&
    application.flowVersionNo >= 0;
  if (!allowed) return null;

  return (
    <>
      <Button
        variant="outline"
        size="settings"
        onClick={() => {
          setError(undefined);
          setConflict(false);
          setOpen(true);
        }}
      >
        撤回申请
      </Button>
      {open && (
        <OrganizationDialog title="撤回考勤申请" busy={busy} onClose={() => setOpen(false)}>
          <form
            className="space-y-[20px]"
            onSubmit={async (event) => {
              event.preventDefault();
              if (inFlight.current || conflict) return;
              inFlight.current = true;
              setBusy(true);
              setError(undefined);
              try {
                const result = await api.withdrawMyAttendance({
                  applicationId: application.applicationId,
                  flowVersionNo: application.flowVersionNo,
                });
                if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== userId) return;
                setOpen(false);
                await onSuccess(result);
              } catch (failure) {
                setError(failure);
                if (failure instanceof ApiError && failure.status === 409) setConflict(true);
                if (
                  failure instanceof ApiError &&
                  failure.status === 401 &&
                  cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id === userId
                )
                  void cache.invalidateQueries({ queryKey: SESSION_KEY });
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            <p className="break-words text-[13px] leading-[22px]">
              确认撤回「{application.title}」？撤回后停止审批，已有考勤记录不会改变。
            </p>
            <ErrorNotice error={error} />
            {conflict && (
              <p role="status" className="text-[13px] leading-[22px] text-muted-foreground">
                申请状态或版本已变化，请先读取最新记录。
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-[8px]">
              <Button
                variant="outline"
                size="settings"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              {conflict ? (
                <Button
                  size="settings"
                  onClick={async () => {
                    await onRefresh();
                    setOpen(false);
                  }}
                >
                  读取最新记录
                </Button>
              ) : (
                <Button type="submit" size="settings" loading={busy}>
                  确认撤回
                </Button>
              )}
            </div>
          </form>
        </OrganizationDialog>
      )}
    </>
  );
}
