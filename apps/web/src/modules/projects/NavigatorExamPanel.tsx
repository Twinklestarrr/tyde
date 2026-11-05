import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, EntranceExamCard, EntranceExamConfiguration } from '@tyde/shared';
import { api } from '@/services/api';
import { SESSION_KEY } from '@/hooks/useSession';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EntranceExamDialog, ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { EntranceExamAdmissions } from './EntranceExamRosterViews';
import { EntranceExamConfigurationView } from './EntranceExamConfigurationView';
import { EntranceExamReview } from './EntranceExamReview';

/** NAV复用考试读取和人工提交，具体阅卷资格由原提交接口校验。 */
export function NavigatorExamPanel({
  user,
  projectId,
  onChanged,
}: {
  user: AuthUser;
  projectId: number;
  onChanged: () => Promise<void>;
}) {
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [view, setView] = useState('grading');
  const [configuration, setConfiguration] = useState<EntranceExamConfiguration | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  function identity() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return session?.id === user.id && (session.selectedRole ?? session.role) === 'NAVIGATOR';
  }
  function requireIdentity() {
    if (!identity()) throw new Error('当前身份已变化，请重新打开领航员考试。');
  }
  const management = useQuery({
    queryKey: ['entrance-exams', user.id, 'NAVIGATOR', projectId, 'management'],
    queryFn: async () => {
      requireIdentity();
      const data = await api.getEntranceExamManagement(projectId);
      requireIdentity();
      return data;
    },
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  async function changed() {
    requireIdentity();
    await onChanged();
    if (!identity()) return;
    await Promise.all([
      cache.invalidateQueries(
        { queryKey: ['entrance-exams', user.id, 'NAVIGATOR', projectId] },
        { throwOnError: true },
      ),
      cache.invalidateQueries(
        { queryKey: ['entrance-exam-roster', user.id, 'NAVIGATOR', projectId] },
        { throwOnError: true },
      ),
      cache.invalidateQueries(
        { queryKey: ['entrance-exam-admissions', user.id, 'NAVIGATOR', projectId] },
        { throwOnError: true },
      ),
    ]);
  }
  async function openConfig(exam: EntranceExamCard) {
    if (opening !== null || exam.status !== 'ACTIVE') return;
    setOpening(exam.examId);
    setError(null);
    try {
      requireIdentity();
      const data = await api.getEntranceExamConfiguration({ projectId, examId: exam.examId });
      requireIdentity();
      setConfiguration(data);
    } catch (value) {
      if (identity()) setError(value);
    } finally {
      if (mounted.current) setOpening(null);
    }
  }
  if (management.isSuccess && !management.data.needWrittenExam)
    return (
      <section aria-label="领航员准入考试">
        <EmptyState title="本项目不需要准入考试" />
      </section>
    );
  return (
    <section aria-label="领航员准入考试" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>准入考试</CardTitle>
        <Button
          variant="outline"
          size="mobileTouch"
          loading={management.isFetching}
          onClick={() => void management.refetch()}
        >
          刷新考试
        </Button>
      </div>
      <p className="text-[13px] leading-6 text-muted-foreground">
        领航员按历史人工阅卷安排查看考试与准入情况；考试配置由策略官维护。
      </p>
      <ErrorNotice error={management.error} />
      <ErrorNotice error={error} />
      {management.isPending && <LoadingState>正在读取准入考试…</LoadingState>}
      {management.isError && (
        <Alert>
          当前无法读取该项目考试，请核对本人阅卷安排后刷新。创建项目或需求方身份本身不授予阅卷权限。
        </Alert>
      )}
      {management.isSuccess && (
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (window.dispatchEvent(new Event(ENTRANCE_EXAM_LEAVE_REQUEST, { cancelable: true })))
              setView(next);
          }}
        >
          <TabsList aria-label="考试视图" variant="business">
            <TabsTrigger variant="business" value="admission">
              准入情况
            </TabsTrigger>
            <TabsTrigger variant="business" value="grading">
              阅卷
            </TabsTrigger>
          </TabsList>
          <TabsContent value="admission">
            <EntranceExamAdmissions user={user} projectId={projectId} role="NAVIGATOR" />
          </TabsContent>
          <TabsContent value="grading">
            <EntranceExamReview
              user={user}
              projectId={projectId}
              exams={management.data.exams}
              role="NAVIGATOR"
              canManage={false}
              onChanged={changed}
              renderActions={(exam) => (
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={exam.status === 'CLOSED' || opening !== null}
                  loading={opening === exam.examId}
                  onClick={() => void openConfig(exam)}
                >
                  查看配置
                </Button>
              )}
            />
          </TabsContent>
        </Tabs>
      )}
      {configuration && (
        <EntranceExamDialog
          label="考试配置"
          title={`考试配置 · ${configuration.examName}`}
          onClose={() => setConfiguration(null)}
        >
          <EntranceExamConfigurationView config={configuration} />
        </EntranceExamDialog>
      )}
    </section>
  );
}
