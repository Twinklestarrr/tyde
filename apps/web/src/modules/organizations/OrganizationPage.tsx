import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ClipboardList, LogOut, Pencil, Plus, RefreshCw, Users } from 'lucide-react';
import type {
  AuthUser,
  OrganizationDetail,
  OrganizationUpdateInput,
  OrganizationUpdateResult,
  OrganizationDepartureResult,
} from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { ErrorNotice } from '@/components/ErrorNotice';
import { UserAvatar } from '@/components/UserAvatar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OrganizationMembers } from './OrganizationMembers';
import { OrganizationApprovals } from './OrganizationApprovals';
import { OrganizationImport } from './OrganizationImport';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationLogoField, useOrganizationLogo } from './OrganizationLogoField';
import { OrganizationDialog, joinStatusLabels, positionLabels, shanghaiToday } from './common';

const participating = ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function OrganizationPage({ user }: { user: AuthUser }) {
  const org = user.organization;
  const orgId = typeof org?.id === 'string' ? org.id : '';
  if (!uuid.test(orgId))
    return (
      <div className="mx-auto max-w-[1040px] space-y-[16px]">
        <OrganizationPageHeader title="我的组织" description="在这里查看组织资料、成员与审批。" />
        <section className="flex flex-col gap-[20px] rounded-[12px] border bg-card p-[20px] sm:flex-row sm:items-center sm:justify-between sm:p-[28px]">
          <div className="min-w-0">
            <h2 className="m-0 text-[20px] font-semibold">还没有组织</h2>
            <p className="mt-[6px] max-w-[520px] text-[14px] leading-[22px] text-[var(--color-neutral-strong)]">
              创建组织后，你会成为组织主管，可以完善资料、管理成员和处理审批。
            </p>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-[10px] sm:w-auto sm:flex-row sm:items-center">
            <Button asChild size="account" className="text-[14px]">
              <Link to="/organization/create">
                <Plus className="size-[16px]" aria-hidden />
                创建组织
              </Link>
            </Button>
            <Button asChild variant="outline" size="account" className="text-[14px]">
              <Link to="/">返回工作台</Link>
            </Button>
          </div>
        </section>
      </div>
    );
  return (
    <CurrentOrganization
      key={[user.id, orgId, org?.position, org?.joinStatus].join(':')}
      user={user}
      orgId={orgId}
    />
  );
}

function CurrentOrganization({ user, orgId }: { user: AuthUser; orgId: string }) {
  const cache = useQueryClient();
  const summary = user.organization!;
  const position =
    summary.position === 'OWNER' ? 'OWNER' : summary.position === 'ADMIN' ? 'ADMIN' : 'MEMBER';
  const joinStatus = typeof summary.joinStatus === 'string' ? summary.joinStatus : '';
  const manager = position !== 'MEMBER' && participating.includes(joinStatus);
  const canDepart = position !== 'OWNER' && joinStatus === 'ACTIVE';
  const [exiting, setExiting] = useState(false);
  const [notice, setNotice] = useState('');
  const selfDepartureKeys = useRef(new Map<string, string>());
  const detailKey = ['organization', user.id, orgId, 'detail', position, joinStatus];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => api.getOrganization(orgId),
    enabled: manager,
    retry: false,
    refetchOnWindowFocus: false,
  });
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ['organization', user.id, orgId] });
    await cache.invalidateQueries({ queryKey: ['profile-organization'] });
    await cache.invalidateQueries({ queryKey: SESSION_KEY });
  }
  async function organizationSaved(result: OrganizationUpdateResult) {
    await cache.cancelQueries({ queryKey: detailKey });
    cache.setQueryData<OrganizationDetail>(detailKey, (previous) =>
      previous
        ? { ...previous, description: result.description, logoUrl: result.logoUrl }
        : previous,
    );
    setNotice('组织资料已保存');
    try {
      await Promise.all([
        cache.invalidateQueries({ queryKey: detailKey }, { throwOnError: true }),
        cache.invalidateQueries({ queryKey: ['profile-organization'] }, { throwOnError: true }),
        cache.invalidateQueries({ queryKey: SESSION_KEY }, { throwOnError: true }),
      ]);
    } catch {
      setNotice('组织资料已保存，但读取最新数据失败，请点击刷新重新读取。');
    }
  }
  return (
    <div className="mx-auto max-w-[1200px] space-y-[16px]">
      <OrganizationPageHeader
        title={manager ? '组织管理' : '我的组织'}
        description={
          manager ? '维护组织资料、管理团队成员与处理退出申请。' : '查看所属组织与本人入组状态。'
        }
        actions={
          manager || canDepart ? (
            <>
              {manager && (
                <Button
                  variant="outline"
                  size="settings"
                  onClick={() => void refresh()}
                  loading={detail.isFetching}
                >
                  <RefreshCw className="size-[16px]" aria-hidden />
                  刷新
                </Button>
              )}
              {manager && <OrganizationImport orgId={orgId} user={user} onSuccess={refresh} />}
              {canDepart && (
                <Button
                  variant="destructiveOutline"
                  size="settings"
                  onClick={() => setExiting(true)}
                >
                  <LogOut className="size-[16px]" aria-hidden />
                  申请退出组织
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {notice && <Alert>{notice}</Alert>}
      <div className="min-w-0 space-y-[16px]">
        <OrganizationCard
          orgId={orgId}
          summary={summary}
          detail={manager ? detail.data : undefined}
          canEdit={position === 'OWNER' && joinStatus === 'ACTIVE'}
          onUpdated={organizationSaved}
        />
        <div className="min-w-0 space-y-[16px]">
          {manager && detail.isPending && (
            <p role="status" className="text-[13px] text-muted-foreground">
              正在读取组织资料…
            </p>
          )}
          {manager && detail.isError && (
            <div className="space-y-[8px] rounded-[12px] border bg-card p-[20px]">
              <p className="text-[13px]">组织详情未更新，当前显示账户中的组织摘要。</p>
              <ErrorNotice error={detail.error} />
              <Button variant="outline" size="settings" onClick={() => void detail.refetch()}>
                重试组织资料
              </Button>
            </div>
          )}
          {manager ? (
            <Tabs defaultValue="members" className="min-w-0">
              <TabsList
                aria-label="组织管理内容"
                className="mb-[16px] h-[48px] w-full justify-start gap-[24px] rounded-none border-b bg-transparent p-0"
              >
                <TabsTrigger
                  value="members"
                  className="h-full gap-[7px] rounded-none border-b-2 border-transparent px-[2px] text-[13px] text-[var(--color-neutral-strong)] data-[state=active]:border-[var(--color-primary-strong)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--color-primary-strong)] data-[state=active]:shadow-none"
                >
                  <Users className="size-[16px]" aria-hidden />
                  人员管理
                </TabsTrigger>
                <TabsTrigger
                  value="approvals"
                  className="h-full gap-[7px] rounded-none border-b-2 border-transparent px-[2px] text-[13px] text-[var(--color-neutral-strong)] data-[state=active]:border-[var(--color-primary-strong)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--color-primary-strong)] data-[state=active]:shadow-none"
                >
                  <ClipboardList className="size-[16px]" aria-hidden />
                  审批中心
                </TabsTrigger>
              </TabsList>
              <TabsContent value="members" className="m-0 min-w-0">
                <OrganizationMembers
                  orgId={orgId}
                  user={user}
                  position={position}
                  canWrite={manager}
                  onSessionChanged={refresh}
                />
              </TabsContent>
              <TabsContent value="approvals" className="m-0 min-w-0">
                <OrganizationApprovals
                  orgId={orgId}
                  user={user}
                  position={position}
                  onSessionChanged={refresh}
                />
              </TabsContent>
            </Tabs>
          ) : (
            <section className="rounded-[12px] border bg-card p-[24px]">
              <h2 className="m-0 text-[17px] font-semibold">我的组织关系</h2>
              <dl className="mt-[20px] space-y-[12px] text-[13px]">
                <div className="flex justify-between gap-[12px]">
                  <dt>组织角色</dt>
                  <dd>{positionLabels[position]}</dd>
                </div>
                <div className="flex justify-between gap-[12px]">
                  <dt>入组状态</dt>
                  <dd>
                    {joinStatusLabels[joinStatus as keyof typeof joinStatusLabels] ?? '待确认'}
                  </dd>
                </div>
              </dl>
              <p className="mt-[20px] text-[13px] leading-[22px] text-[var(--color-neutral-strong)]">
                组织资料编辑、人员管理与审批由组织主管或管理员负责。
              </p>
              {joinStatus === 'EXIT_APPROVING' && (
                <Alert className="mt-[16px]">退出申请正在审批中，请等待组织主管处理。</Alert>
              )}
              {joinStatus === 'PENDING_LEAVE' && (
                <Alert className="mt-[16px]">退出申请已通过，将按拟离职日期处理。</Alert>
              )}
            </section>
          )}
        </div>
      </div>
      {exiting && (
        <SelfDeparture
          orgId={orgId}
          requestKeys={selfDepartureKeys.current}
          onClose={() => setExiting(false)}
          onSuccess={async (result) => {
            setNotice(
              result.flowStatus === 'PENDING'
                ? '退出申请已提交，请等待组织主管审批。'
                : '退出申请已处理，请查看最新组织状态。',
            );
            setExiting(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function OrganizationCard({
  orgId,
  summary,
  detail,
  canEdit,
  onUpdated,
}: {
  orgId: string;
  summary: NonNullable<AuthUser['organization']>;
  detail?: OrganizationDetail;
  canEdit: boolean;
  onUpdated: (result: OrganizationUpdateResult) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const org = detail ?? summary;
  const name = typeof org.name === 'string' ? org.name : '所属组织';
  const description = typeof org.description === 'string' ? org.description : '';
  const logo = typeof org.logoUrl === 'string' ? org.logoUrl : '';
  const credit = typeof org.unifiedCreditCode === 'string' ? org.unifiedCreditCode : '';
  const tags = Array.isArray(org.expertiseTags)
    ? org.expertiseTags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return (
    <aside
      aria-label="组织基本信息"
      className="min-w-0 rounded-[12px] border bg-card px-[16px] py-[16px] sm:px-[20px]"
    >
      <div className="flex flex-wrap items-start gap-[14px]">
        <UserAvatar
          name={name}
          url={logo}
          className="size-[44px] shrink-0 rounded-[10px] text-[18px]"
        />
        <div className="min-w-0 flex-1 basis-[200px]">
          <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
            <h2 className="m-0 break-words text-[17px] leading-[25px] font-semibold">{name}</h2>
            <span className="inline-flex items-center gap-[5px] rounded-[5px] bg-[var(--color-primary-soft)] px-[7px] py-[2px] text-[11px] font-medium text-[var(--color-primary-strong)]">
              {org.verifyStatus === 'APPROVED'
                ? '已生效'
                : org.verifyStatus === 'REJECTED'
                  ? '认证未通过'
                  : '认证待审核'}
            </span>
            {typeof org.status === 'string' && (
              <span className="text-[12px] text-[var(--color-neutral-strong)]">
                {{ ACTIVE: '正常', FROZEN: '冻结', DISSOLVED: '已解散' }[org.status] ?? org.status}
              </span>
            )}
          </div>
          <p className="mt-[4px] break-words whitespace-pre-wrap text-[13px] leading-[21px] text-[var(--color-neutral-strong)]">
            {description || '暂未填写组织简介'}
          </p>
          {(credit || tags.length > 0) && (
            <div className="mt-[8px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px] text-[12px] text-[var(--color-neutral-strong)]">
              {credit && (
                <p className="min-w-0 break-all">
                  统一社会信用代码 <span className="ml-[4px] font-mono">{credit}</span>
                </p>
              )}
              {tags.length > 0 && (
                <ul aria-label="组织领域" className="flex flex-wrap gap-[6px]">
                  {tags.map((tag) => (
                    <li key={tag} className="rounded-[4px] bg-muted px-[7px] py-[2px]">
                      {tag}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {canEdit && detail && (
          <Button
            variant="ghost"
            size="mobileTouch"
            className="ml-auto shrink-0"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-[14px]" aria-hidden />
            编辑组织资料
          </Button>
        )}
      </div>
      {editing && detail && (
        <OrganizationEdit
          orgId={orgId}
          detail={detail}
          onClose={() => setEditing(false)}
          onSuccess={onUpdated}
        />
      )}
    </aside>
  );
}

export function OrganizationEdit({
  orgId,
  detail,
  onClose,
  onSuccess,
}: {
  orgId: string;
  detail: OrganizationDetail;
  onClose: () => void;
  onSuccess: (result: OrganizationUpdateResult) => Promise<void>;
}) {
  const [description, setDescription] = useState(detail.description ?? '');
  const [error, setError] = useState<unknown>();
  const logo = useOrganizationLogo(detail.logoUrl ?? '', 500, () => setError(undefined));
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  return (
    <OrganizationDialog title="编辑组织资料" onClose={onClose} busy={busy}>
      <form
        className="space-y-[20px]"
        onSubmit={async (event) => {
          event.preventDefault();
          if (inFlight.current) return;
          const input: OrganizationUpdateInput = { orgId };
          if (description.trim() !== (detail.description ?? ''))
            input.description = description.trim();
          inFlight.current = true;
          setBusy(true);
          setError(undefined);
          try {
            Object.assign(input, await logo.prepare());
            if (Object.keys(input).length === 1) {
              onClose();
              return;
            }
            const result = await api.updateOrganization(input);
            await onSuccess(result);
            onClose();
          } catch (failure) {
            setError(failure);
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        <p className="text-[13px] text-[var(--color-neutral-strong)]">
          可以修改组织简介和 Logo；组织名称与信用代码暂不可修改。
        </p>
        <fieldset disabled={busy} className="space-y-[20px]">
          <FormField
            controlId="org-description"
            label="组织简介"
            description="最多 1000 字符；留空可清除。"
          >
            <Textarea
              id="org-description"
              maxLength={1000}
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="text-[13px]"
            />
          </FormField>
          <OrganizationLogoField logo={logo} disabled={busy} />
        </fieldset>
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-[8px]">
          <Button variant="outline" size="settings" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="settings" loading={busy}>
            保存组织资料
          </Button>
        </div>
      </form>
    </OrganizationDialog>
  );
}

export function SelfDeparture({
  orgId,
  requestKeys,
  onClose,
  onSuccess,
}: {
  orgId: string;
  requestKeys: Map<string, string>;
  onClose: () => void;
  onSuccess: (result: OrganizationDepartureResult) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(shanghaiToday);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const inFlight = useRef(false);
  return (
    <OrganizationDialog title="申请退出组织" onClose={onClose} busy={busy}>
      <form
        className="space-y-[20px]"
        onSubmit={async (event) => {
          event.preventDefault();
          if (inFlight.current) return;
          if (!reason.trim()) {
            setError(new Error('请填写退出原因'));
            return;
          }
          inFlight.current = true;
          setBusy(true);
          setError(undefined);
          try {
            const signature = JSON.stringify([date, reason.trim()]);
            let key = requestKeys.get(signature);
            if (!key) {
              key = crypto.randomUUID();
              requestKeys.set(signature, key);
            }
            const result = await api.requestOrganizationDeparture(
              { orgId, reason: reason.trim(), plannedLeaveDate: date },
              key,
            );
            requestKeys.delete(signature);
            await onSuccess(result);
          } catch (failure) {
            setError(failure);
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        <p className="text-[13px] leading-[22px] text-[var(--color-neutral-strong)]">
          申请会提交给组织主管审批。提交后仍可查看账户中的组织状态。
        </p>
        <fieldset disabled={busy} className="space-y-[20px]">
          <FormField
            controlId="org-exit-date"
            label="拟离职日期"
            required
            description="按上海日期计算，不早于今天。"
          >
            <Input
              id="org-exit-date"
              type="date"
              size="profile"
              required
              min={shanghaiToday()}
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
          </FormField>
          <FormField controlId="org-exit-reason" label="退出原因" required>
            <Textarea
              id="org-exit-reason"
              required
              maxLength={1000}
              rows={4}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="text-[13px]"
            />
          </FormField>
        </fieldset>
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-[8px]">
          <Button variant="outline" size="settings" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="settings" variant="destructive" loading={busy}>
            提交退出申请
          </Button>
        </div>
      </form>
    </OrganizationDialog>
  );
}
