import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuthUser,
  ProjectExpertRecruitmentCandidate,
  ProjectRecruitmentSubjectType,
} from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { OrganizationMemberDossier } from '@/modules/organizations/OrganizationMemberDossier';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { recruitmentCandidateKey, recruitmentCandidateName } from './expert-recruitment-form';

const assignmentLabels = {
  PENDING_ACCEPTANCE: '待接单',
  ACCEPTED: '已接单',
  REJECTED: '已拒绝',
  REPLACED: '已被更换',
};

export type RecruitmentCandidateView = 'ALL' | ProjectRecruitmentSubjectType | 'SELECTED';

/** 关键词与分页读取候选，主体分类仅筛选已加载数据。 */
export function RecruitmentCandidates({
  user,
  projectId,
  disabled = false,
  excludedKeys = [],
  view,
  onViewChange,
  onRecruit,
  onRecruitAgain,
  onPick,
}: {
  user: AuthUser;
  projectId: number;
  disabled?: boolean;
  excludedKeys?: string[];
  view: RecruitmentCandidateView;
  onViewChange: (view: RecruitmentCandidateView) => void;
  onRecruit?: (candidate: ProjectExpertRecruitmentCandidate) => void;
  onRecruitAgain?: (candidate: ProjectExpertRecruitmentCandidate) => void;
  onPick?: (candidate: ProjectExpertRecruitmentCandidate) => void;
}) {
  const cache = useQueryClient();
  const scope = useId();
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState({ keyword: '', current: 1 });
  const [loaded, setLoaded] = useState<ProjectExpertRecruitmentCandidate[]>([]);
  const [known, setKnown] = useState<ProjectExpertRecruitmentCandidate[]>([]);
  const [dossier, setDossier] = useState<ProjectExpertRecruitmentCandidate | null>(null);
  const sessionMatches = () => {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === 'PM';
  };
  const query = useQuery({
    queryKey: ['project-recruitment-candidates', user.id, 'PM', projectId, filter],
    enabled: (user.selectedRole ?? user.role) === 'PM',
    queryFn: async () => {
      const ensureSession = () => {
        if (!sessionMatches()) throw new Error('登录状态或当前角色已变化，请重新进入招募页面。');
      };
      ensureSession();
      const result = await api.listExpertRecruitmentCandidates({
        projectId,
        current: filter.current,
        size: 21,
        ...(filter.keyword ? { keyword: filter.keyword } : {}),
      });
      ensureSession();
      return result;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = !query.isError && sessionMatches() ? query.data : undefined;
  useEffect(() => {
    if (!data) return;
    const merge = (previous: ProjectExpertRecruitmentCandidate[]) => [
      ...new Map(
        [...previous, ...data.records].map((candidate) => [
          recruitmentCandidateKey(candidate),
          candidate,
        ]),
      ).values(),
    ];
    setLoaded(merge);
    setKnown(merge);
  }, [data]);
  const records =
    data &&
    [
      ...new Map(
        [...(view === 'SELECTED' ? known : loaded), ...data.records].map((candidate) => [
          recruitmentCandidateKey(candidate),
          candidate,
        ]),
      ).values(),
    ].filter(
      (candidate) =>
        !excludedKeys.includes(recruitmentCandidateKey(candidate)) &&
        (view === 'ALL' ||
          (view === 'SELECTED'
            ? candidate.assignment?.status === 'PENDING_ACCEPTANCE' ||
              candidate.assignment?.status === 'ACCEPTED'
            : candidate.subjectType === view)),
    );
  const blocked = disabled || query.isFetching || query.isError || !sessionMatches();

  function choose(
    candidate: ProjectExpertRecruitmentCandidate,
    action: (candidate: ProjectExpertRecruitmentCandidate) => void,
  ) {
    if (
      blocked ||
      !sessionMatches() ||
      candidate.availableAction === 'NONE' ||
      excludedKeys.includes(recruitmentCandidateKey(candidate))
    )
      return;
    action(candidate);
  }

  return (
    <div ref={setPortal} role="region" aria-label="执行专家候选" className="min-w-0 space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setLoaded([]);
          setFilter({ keyword: keyword.trim(), current: 1 });
        }}
      >
        <SearchInput
          id={`${scope}-keyword`}
          label="筛选执行专家"
          value={keyword}
          maxLength={100}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="姓名、昵称或组织名称"
          containerClassName="flex-1 basis-[220px] sm:max-w-none"
        />
        <div className="min-w-[140px] flex-1 sm:max-w-[180px]">
          <label htmlFor={`${scope}-subject`} className="sr-only">
            主体类型
          </label>
          <Select
            value={view}
            onValueChange={(value) => onViewChange(value as RecruitmentCandidateView)}
          >
            <SelectTrigger id={`${scope}-subject`} aria-label="主体类型" size="profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent container={portal}>
              <SelectItem value="ALL">全部主体</SelectItem>
              <SelectItem value="ORGANIZATION">组织</SelectItem>
              <SelectItem value="INDIVIDUAL">个人</SelectItem>
              <SelectItem value="SELECTED">已选</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" size="settings" loading={query.isFetching}>
          查询候选
        </Button>
        <Button
          variant="outline"
          size="settings"
          onClick={() => {
            setKeyword('');
            onViewChange('ALL');
            setLoaded([]);
            setFilter({ keyword: '', current: 1 });
          }}
        >
          重置筛选
        </Button>
        <Button
          variant="outline"
          size="settings"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新候选
        </Button>
      </form>
      <ErrorNotice error={query.error} />
      {(user.selectedRole ?? user.role) !== 'PM' ? (
        <EmptyState title="请切换到策略官后查看招募候选。" />
      ) : query.isPending ? (
        <LoadingState>正在读取执行专家候选…</LoadingState>
      ) : (
        data && (
          <>
            {records?.length ? (
              <div
                role="group"
                aria-label="候选列表"
                tabIndex={0}
                className="grid max-h-[36rem] min-w-0 gap-3 overflow-y-auto overscroll-y-contain pr-1 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-2"
              >
                {records.map((candidate) => {
                  const assignment = candidate.assignment;
                  const name = recruitmentCandidateName(candidate);
                  return (
                    <Card key={recruitmentCandidateKey(candidate)} asChild>
                      <article aria-label={name} className="flex min-w-0 flex-col gap-3 p-5">
                        <div className="min-w-0">
                          <h3 className="break-words text-base font-semibold">{name}</h3>
                          <p className="mt-1 text-[12px] text-muted-foreground">
                            {candidate.subjectType === 'ORGANIZATION' ? '组织' : '个人'}
                          </p>
                          {candidate.subjectType === 'ORGANIZATION' && (
                            <p className="mt-1 break-words text-[13px]">
                              主管：
                              {[candidate.supervisorNickname, candidate.supervisorName]
                                .filter(Boolean)
                                .join(' / ') || '未填写'}
                            </p>
                          )}
                        </div>
                        {candidate.description && (
                          <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">
                            {candidate.description}
                          </p>
                        )}
                        <div className="space-y-2 text-[13px] leading-5">
                          <p>
                            最近分配：
                            {assignment ? assignmentLabels[assignment.status] : '尚无分配'}
                          </p>
                          {assignment && (
                            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                              {[
                                ['生产量级', assignment.productionRequirement],
                                ['作业人数', assignment.operatorHeadcount],
                                ['质检人数', assignment.inspectorHeadcount],
                              ].map(([label, value]) => (
                                <div key={label} className="min-w-0">
                                  <dt className="text-[12px] text-muted-foreground">{label}</dt>
                                  <dd className="mt-1 break-all">{value ?? '未设置'}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                        <div className="mt-auto flex flex-wrap gap-2">
                          {candidate.subjectType === 'INDIVIDUAL' && (
                            <Button
                              variant="outline"
                              size="mobileTouch"
                              onClick={() => setDossier(candidate)}
                            >
                              查看档案
                            </Button>
                          )}
                          {onPick ? (
                            <Button
                              size="mobileTouch"
                              disabled={blocked || candidate.availableAction === 'NONE'}
                              onClick={() => choose(candidate, onPick)}
                            >
                              选择此对象
                            </Button>
                          ) : (
                            <>
                              {onRecruit && (
                                <Button
                                  size="mobileTouch"
                                  disabled={blocked || candidate.availableAction === 'NONE'}
                                  onClick={() => choose(candidate, onRecruit)}
                                >
                                  加入下发
                                </Button>
                              )}
                              {candidate.availableAction === 'RECRUIT_AGAIN' && onRecruitAgain && (
                                <Button
                                  variant="outline"
                                  size="mobileTouch"
                                  disabled={blocked}
                                  onClick={() => choose(candidate, onRecruitAgain)}
                                >
                                  补招
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </article>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Card>
                <EmptyState
                  title="已加载候选中暂无匹配对象"
                  description="可切换分类或加载更多候选；新选择保留在下发清单中。"
                />
              </Card>
            )}
            {data.current < data.pages && (
              <Button
                variant="outline"
                loading={query.isFetching}
                onClick={() => setFilter((value) => ({ ...value, current: value.current + 1 }))}
              >
                加载更多
              </Button>
            )}
            <Pagination
              aria-label="执行专家候选分页"
              current={data.current}
              size={21}
              total={data.total}
              pages={data.pages}
              loading={query.isFetching}
              onPageChange={(current) => setFilter((value) => ({ ...value, current }))}
            />
          </>
        )
      )}
      {dossier && (
        <OrganizationMemberDossier
          member={{ userId: '', phoneMasked: '' }}
          name={recruitmentCandidateName(dossier)}
          onClose={() => setDossier(null)}
        />
      )}
    </div>
  );
}
