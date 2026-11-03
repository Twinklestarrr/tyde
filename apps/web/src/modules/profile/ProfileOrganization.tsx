import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AuthUser } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/ui/empty-state';
import { sessionQuery } from '@/hooks/useSession';
import { api } from '@/services/api';

const positions: Record<string, string> = { OWNER: '主管', ADMIN: '管理员', MEMBER: '成员' };
const statuses: Record<string, string> = { ACTIVE: '正常', FROZEN: '冻结', DISSOLVED: '已解散' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ProfileOrganization({ organization }: { organization: AuthUser['organization'] }) {
  if (!organization)
    return (
      <section aria-label="所属组织" className="mt-[24px] border-t pt-[20px]">
        <CardTitle asChild>
          <h3>所属组织</h3>
        </CardTitle>
        <p className="mt-[10px] text-[12px] leading-[20px] text-[var(--color-neutral-strong)]">
          还没有组织，可以创建自己的团队。
        </p>
        <Button asChild variant="outline" size="settings" className="mt-[12px] w-full">
          <Link to="/organization/create">创建组织</Link>
        </Button>
      </section>
    );
  return <OrganizationSummary organization={organization} />;
}

function OrganizationSummary({ organization }: { organization: Record<string, unknown> }) {
  // 订阅已有会话缓存，不额外发起当前用户查询；账户和权限变化时隔离组织查询结果。
  const { data: session } = useQuery({ ...sessionQuery, enabled: false });
  const orgId = typeof organization.id === 'string' ? organization.id : '';
  const position = typeof organization.position === 'string' ? organization.position : '';
  const joinStatus = typeof organization.joinStatus === 'string' ? organization.joinStatus : '';
  const canRead =
    !!session?.id &&
    uuid.test(orgId) &&
    ['OWNER', 'ADMIN'].includes(position) &&
    ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(joinStatus);
  const detail = useQuery({
    queryKey: ['profile-organization', session?.id, orgId, position, joinStatus],
    queryFn: () => api.getOrganization(orgId),
    enabled: canRead,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const summary = canRead && detail.data ? detail.data : organization;
  const name = typeof summary.name === 'string' ? summary.name.trim() : '';
  const description = typeof summary.description === 'string' ? summary.description.trim() : '';
  const logo = typeof summary.logoUrl === 'string' ? summary.logoUrl : null;
  const currentPosition = typeof summary.position === 'string' ? positions[summary.position] : '';
  const status = typeof summary.status === 'string' ? statuses[summary.status] : '';
  const creditCode =
    typeof summary.unifiedCreditCode === 'string' ? summary.unifiedCreditCode.trim() : '';
  const tags = Array.isArray(summary.expertiseTags)
    ? summary.expertiseTags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim())
    : [];

  if (!name && !canRead) return null;
  return (
    <section aria-label="所属组织" className="mt-[24px] border-t pt-[20px]">
      <CardTitle asChild>
        <h3>所属组织</h3>
      </CardTitle>
      {name && (
        <div className="mt-[12px] flex items-start gap-[10px]">
          <UserAvatar url={logo} name={name} className="size-[32px] rounded-[6px] text-[14px]" />
          <div className="min-w-0">
            <p className="break-words text-[13px] leading-[20px] font-medium">{name}</p>
            {currentPosition && (
              <p className="mt-[2px] text-[12px] leading-[18px] text-[var(--color-neutral-strong)]">
                {currentPosition}
              </p>
            )}
          </div>
        </div>
      )}
      {description && (
        <p className="mt-[12px] break-words text-[13px] leading-[22px] text-[var(--color-neutral-strong)]">
          {description}
        </p>
      )}
      {tags.length > 0 && (
        <div aria-label="组织领域" className="mt-[12px] flex flex-wrap gap-[6px]">
          {tags.map((tag, index) => (
            <span
              key={index}
              className="rounded-[5px] border bg-card px-[7px] py-[2px] text-[12px] leading-[18px] text-[var(--color-neutral-strong)]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {(creditCode || status) && (
        <dl className="mt-[12px] space-y-[6px] text-[12px] leading-[20px] text-[var(--color-neutral-strong)]">
          {creditCode && (
            <div>
              <dt>统一社会信用代码</dt>
              <dd className="break-all">{creditCode}</dd>
            </div>
          )}
          {status && (
            <div className="flex gap-[8px]">
              <dt>组织状态</dt>
              <dd>{status}</dd>
            </div>
          )}
        </dl>
      )}
      <Button asChild variant="outline" size="settings" className="mt-[16px] w-full">
        <Link to="/organization">{canRead ? '进入组织管理' : '查看我的组织'}</Link>
      </Button>
      {canRead && detail.isFetching && (
        <LoadingState className="mt-3 justify-start p-0">正在读取组织详情…</LoadingState>
      )}
      {canRead && detail.isError && (
        <div className="mt-[12px] space-y-[8px]">
          <p className="text-[12px] leading-[20px] text-[var(--color-neutral-strong)]">
            {detail.data
              ? '组织详情刷新失败，当前显示上次读取结果。'
              : '组织详情未加载，当前显示账户返回的组织摘要。'}
          </p>
          <ErrorNotice error={detail.error} />
          <Button
            variant="outline"
            size="settings"
            className="w-full"
            loading={detail.isFetching}
            onClick={() => void detail.refetch()}
          >
            重新读取组织信息
          </Button>
        </div>
      )}
    </section>
  );
}
