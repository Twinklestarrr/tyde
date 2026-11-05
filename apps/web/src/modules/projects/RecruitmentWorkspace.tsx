import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  createRecruitmentScope,
  RECRUITMENT_SCOPE_OPTIONS,
  validateRecruitmentScope,
  type RecruitmentScope,
  type RecruitmentScopeErrors,
} from './expert-recruitment-scope';

const selectionFields = [
  ['projectStatuses', '人员项目状态'],
  ['occupancyStatuses', '人员占用状态'],
  ['admissionStatuses', '准入情况'],
  ['materials', '证书上传'],
] as const;
const numberFields = [
  ['matchMin', '匹配分下限'],
  ['matchMax', '匹配分上限'],
  ['recommendationCount', '推荐人员数量'],
] as const;
const columns = {
  recommendation: {
    individual: [
      '用户ID',
      '用户名称',
      '人才等级',
      '活跃度',
      '信息匹配度',
      '质量分',
      '信用分',
      '风险标记',
      '项目状态',
      '占用状态',
      '预计可用时长',
      '操作',
    ],
    organization: ['组织名称', '组织主管', '组织带宽', '项目状态', '推荐人数', '历史项目', '操作'],
  },
  records: {
    individual: [
      '用户ID',
      '用户名称',
      '人才等级',
      '招募方式',
      '信息匹配度',
      '质量分',
      '信用分',
      '风险标记',
      '项目状态',
      '操作',
    ],
    organization: [
      '组织名称',
      '组织主管',
      '组织带宽',
      '招募方式',
      '招募进度',
      '项目状态',
      '分配业务量',
      '分配角色',
      '操作',
    ],
  },
};
function PendingList({ mode }: { mode: 'recommendation' | 'records' }) {
  const name = mode === 'records' ? '招募记录' : '推荐结果';
  return (
    <section aria-label={name} className="min-w-0 space-y-3">
      <Tabs defaultValue="individual">
        <TabsList aria-label={`${name}主体`}>
          <TabsTrigger value="individual">个人</TabsTrigger>
          <TabsTrigger value="organization">组织</TabsTrigger>
        </TabsList>
        {(['individual', 'organization'] as const).map((type) => (
          <TabsContent key={type} value={type}>
            <div
              tabIndex={0}
              role="region"
              aria-label={`${name}表格滚动区域`}
              className="overflow-x-auto rounded-xl border"
            >
              <table
                aria-label={`${type === 'individual' ? '个人' : '组织'}${name}`}
                className="w-full text-xs"
              >
                <thead>
                  <tr>
                    {columns[mode][type].map((label) => (
                      <th key={label} className="whitespace-nowrap p-3 text-left font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={columns[mode][type].length} className="p-8 text-center">
                      <p role="status">{name}待同步</p>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
function ScopeDialog({
  value,
  onClose,
  onSave,
}: {
  value: RecruitmentScope;
  onClose: () => void;
  onSave: (value: RecruitmentScope) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [errors, setErrors] = useState<RecruitmentScopeErrors>({});
  const form = useRef<HTMLFormElement>(null);
  return (
    <Dialog title="候选范围设置" aria-label="候选范围设置" size="lg" onClose={onClose}>
      <p className="mb-4 text-sm text-muted-foreground">
        条件仅在当前项目视图内暂存，推荐结果待同步。多选留空表示不限。
      </p>
      <form
        ref={form}
        noValidate
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          const next = validateRecruitmentScope(draft);
          setErrors(next);
          if (Object.keys(next).length) {
            requestAnimationFrame(() =>
              form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
            );
            return;
          }
          onSave(draft);
        }}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {selectionFields.map(([field, label]) => (
            <fieldset key={field} className="rounded-xl border p-3">
              <legend className="px-1 text-sm font-medium">{label}</legend>
              <div className="flex max-h-40 flex-wrap gap-3 overflow-y-auto">
                {RECRUITMENT_SCOPE_OPTIONS[field].map((option) => (
                  <label key={option} className="flex min-h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft[field].includes(option)}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [field]: event.target.checked
                            ? [...current[field], option]
                            : current[field].filter((value) => value !== option),
                        }))
                      }
                    />
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {numberFields.map(([field, label]) => (
            <label key={field} className="space-y-2 text-sm">
              {label}
              <Input
                type="number"
                aria-label={label}
                aria-invalid={!!errors[field]}
                value={draft[field] ?? ''}
                min={field === 'recommendationCount' ? 1 : 0}
                max={field === 'recommendationCount' ? undefined : 100}
                step={1}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field]: event.target.value === '' ? null : Number(event.target.value),
                  }))
                }
              />
              {errors[field] && <span className="text-xs text-destructive">{errors[field]}</span>}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(createRecruitmentScope());
              setErrors({});
            }}
          >
            重置
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit">暂存条件</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** 与旧版相同，仅保留本项目本次视图内的范围草稿，不发送推荐或历史业务请求。 */
export function RecruitmentWorkspace({ children }: { children: ReactNode }) {
  const [section, setSection] = useState('recruitment');
  const [source, setSource] = useState('manual');
  const [scope, setScope] = useState(createRecruitmentScope);
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-4">
      <dl aria-label="招募人数统计" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {['需求人数', '待准入人数', '已入项人数', '待入项人数'].map((label) => (
          <Card key={label} className="space-y-1 p-4">
            <dt className="text-sm">{label}</dt>
            <dd>—</dd>
            <p className="text-xs text-muted-foreground">待同步</p>
          </Card>
        ))}
      </dl>
      <Tabs value={section} onValueChange={setSection}>
        <TabsList aria-label="招募工作区">
          <TabsTrigger value="recruitment">人员招募</TabsTrigger>
          <TabsTrigger value="records">招募记录</TabsTrigger>
        </TabsList>
        <TabsContent value="recruitment" forceMount hidden={section !== 'recruitment'}>
          <Tabs value={source} onValueChange={setSource}>
            <TabsList aria-label="人员招募方式">
              <TabsTrigger value="recommendation">智能推荐</TabsTrigger>
              <TabsTrigger value="manual">手动搜索</TabsTrigger>
            </TabsList>
            <TabsContent
              value="manual"
              forceMount
              hidden={source !== 'manual'}
              className="space-y-4"
            >
              {children}
            </TabsContent>
            <TabsContent
              value="recommendation"
              forceMount
              hidden={source !== 'recommendation'}
              className="space-y-4"
            >
              <Card className="space-y-4 p-4">
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    人员推荐
                  </Button>
                  <Button disabled>生成推荐</Button>
                </div>
                <dl aria-label="已暂存候选范围" className="grid gap-3 text-sm sm:grid-cols-2">
                  {selectionFields.map(([field, label]) => (
                    <div key={field}>
                      <dt>{label}</dt>
                      <dd>{scope[field].join('、') || '不限'}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>匹配分范围</dt>
                    <dd>
                      {scope.matchMin}–{scope.matchMax}
                    </dd>
                  </div>
                  <div>
                    <dt>推荐人员数量</dt>
                    <dd>{scope.recommendationCount}</dd>
                  </div>
                </dl>
                <p className="text-sm text-muted-foreground">
                  推荐结果待同步；暂存条件不会生成人员推荐，也不会修改手动搜索结果。
                </p>
              </Card>
              <PendingList mode="recommendation" />
            </TabsContent>
          </Tabs>
        </TabsContent>
        <TabsContent value="records" forceMount hidden={section !== 'records'}>
          <PendingList mode="records" />
        </TabsContent>
      </Tabs>
      {editing && (
        <ScopeDialog
          value={scope}
          onClose={() => setEditing(false)}
          onSave={(value) => {
            setScope(value);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
