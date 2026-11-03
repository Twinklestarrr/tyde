import type { ReactNode } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';

export const orgControlClass =
  'h-[40px] w-full min-w-0 rounded-[8px] border border-input bg-card px-[12px] text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-[640px]:h-[44px]';
export const positionLabels = { OWNER: '主管', ADMIN: '管理员', MEMBER: '成员' };
export const employmentLabels = { FULL_TIME: '全职', PART_TIME: '兼职' };
export const joinStatusLabels = {
  PENDING: '待审核',
  PENDING_ACTIVATION: '待激活',
  ACTIVE: '在组',
  EXIT_APPROVING: '退出审批中',
  PENDING_LEAVE: '待离职',
  LEFT: '已离组',
  REMOVED: '已移除',
};

/** 组织业务保留原调用接口，视觉和模态行为统一交由公共弹框管理。 */
export function OrganizationDialog({
  title,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      busy={busy}
      size={wide ? 'lg' : 'md'}
      closeOnBackdrop={false}
      footer={null}
    >
      {children}
    </Dialog>
  );
}

export function OrganizationPagination({
  current,
  size,
  total,
  onPageChange,
  loading = false,
}: {
  current: number;
  size: number;
  total: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
}) {
  return (
    <Pagination
      current={current}
      size={size}
      total={total}
      onPageChange={onPageChange}
      loading={loading}
    />
  );
}

/** 响应时间以上海时间展示，与后端入离组日期语义一致。 */
export function organizationTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
}

export function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}
