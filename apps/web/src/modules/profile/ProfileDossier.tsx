import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthUser } from '@tyde/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/shared/FormField';
import { OrganizationDialog, shanghaiToday } from '@/modules/organizations/common';

const groups = {
  education: ['学历', '就读院校', '专业', '开始月份', '结束月份'],
  work: ['公司', '职位', '开始月份', '结束月份', '工作描述'],
  projects: ['项目名称', '开始月份', '结束月份', '职责', '成果'],
} as const;
type Group = keyof typeof groups;
type Material = { id: number; name: string };
type Draft = {
  name: string;
  phone: string;
  email: string;
  birth: string;
  education: string[][];
  work: string[][];
  projects: string[][];
  qualifications: Material[];
  portfolios: Material[];
};
const sectionLabels = ['基本信息', '教育经历', '工作经历', '项目经历', '证书', '作品集'];
const degrees = ['高中及以下', '大专', '本科', '硕士', '博士'];
const empty = (group: Group) => groups[group].map(() => '');

/** 本地档案只恢复同账号文字；格式错误不采用部分损坏内容。 */
function restore(user: AuthUser): { draft: Draft; notice: string } {
  const draft: Draft = {
    name: user.realName,
    phone: user.phone.includes('*') ? '' : user.phone,
    email: '',
    birth: '',
    education: [empty('education')],
    work: [],
    projects: [],
    qualifications: [{ id: 0, name: '' }],
    portfolios: [{ id: 1, name: '' }],
  };
  try {
    const raw = sessionStorage.getItem(`tyde:profile-dossier:${user.id}`);
    if (!raw) return { draft, notice: '' };
    const value = JSON.parse(raw);
    if (
      value.version !== 2 ||
      value.accountId !== user.id ||
      !value.draft ||
      !['name', 'phone', 'email', 'birth'].every((key) => typeof value.draft[key] === 'string') ||
      !Object.entries(groups).every(
        ([key, fields]) =>
          Array.isArray(value.draft[key]) &&
          value.draft[key].every(
            (row: unknown) =>
              Array.isArray(row) &&
              row.length === fields.length &&
              row.every((cell) => typeof cell === 'string'),
          ),
      ) ||
      !value.draft.education.length ||
      !['qualifications', 'portfolios'].every(
        (key) =>
          Array.isArray(value.draft[key]) &&
          value.draft[key].length > 0 &&
          value.draft[key].every(
            (entry: unknown) =>
              !!entry &&
              typeof entry === 'object' &&
              'id' in entry &&
              Number.isInteger(entry.id) &&
              Number(entry.id) >= 0 &&
              'name' in entry &&
              typeof entry.name === 'string',
          ),
      ) ||
      value.draft.portfolios.length > 8 ||
      new Set(
        [...value.draft.qualifications, ...value.draft.portfolios].map(
          (entry: Material) => entry.id,
        ),
      ).size !==
        value.draft.qualifications.length + value.draft.portfolios.length
    )
      throw new Error();
    return { draft: value.draft, notice: '已恢复文字草稿；文件未保存在浏览器中，请重新选择。' };
  } catch {
    return { draft, notice: '暂存草稿无法恢复，请重新填写。' };
  }
}

/** 保留旧版仅前端暂存的档案边界；没有任何上传、解析、核验或业务写请求。 */
export function ProfileDossier({ user }: { user: AuthUser }) {
  const [initial] = useState(() => restore(user));
  const [draft, setDraft] = useState(initial.draft);
  const [notice, setNotice] = useState(initial.notice);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [replacement, setReplacement] = useState<File | null>(null);
  const [active, setActive] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const nextMaterial = useRef(
    Math.max(
      ...initial.draft.qualifications.map((entry) => entry.id),
      ...initial.draft.portfolios.map((entry) => entry.id),
    ) + 1,
  );
  useEffect(() => {
    const sync = () => {
      if (!form.current?.getClientRects().length) return;
      const sections = [...form.current.querySelectorAll<HTMLElement>('[data-dossier-section]')];
      const current = sections.reduce(
        (found, section, index) => (section.getBoundingClientRect().top <= 100 ? index : found),
        -1,
      );
      setActive(
        window.scrollY > 0 &&
          window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2
          ? 5
          : Math.max(0, current),
      );
    };
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    const observer = new ResizeObserver(sync);
    if (form.current) observer.observe(form.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);
  function save() {
    try {
      sessionStorage.setItem(
        `tyde:profile-dossier:${user.id}`,
        JSON.stringify({ version: 2, accountId: user.id, draft }),
      );
      setNotice('文字草稿已暂存；刷新后文件需重新选择。资料尚未提交。');
    } catch {
      setNotice('草稿暂存失败，当前输入仍保留，请重试。');
    }
  }
  function confirm(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = '请填写姓名';
    if (draft.phone && !/^\+?[\d\s()-]{6,32}$/.test(draft.phone))
      next.phone = '请填写有效的电话号码';
    if (draft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email))
      next.email = '请填写有效的邮箱地址';
    if (draft.birth && (draft.birth > shanghaiToday() || !/^\d{4}-\d{2}-\d{2}$/.test(draft.birth)))
      next.birth = '请选择不晚于今天的出生日期';
    for (const group of Object.keys(groups) as Group[])
      draft[group].forEach((row, index) => {
        groups[group].forEach((label, field) => {
          if (group === 'education' && !row[field]?.trim())
            next[`${group}-${index}-${field}`] = `请填写${label}`;
        });
        const start = groups[group].indexOf('开始月份'),
          end = groups[group].indexOf('结束月份');
        if (row[start] && row[end] && row[start]! > row[end]!)
          next[`${group}-${index}-${end}`] = '结束月份不能早于开始月份';
      });
    if (!files.education) next.education = '请选择学历证明';
    setErrors(next);
    if (Object.keys(next).length)
      requestAnimationFrame(() =>
        form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    else setNotice('必填信息已检查。信息确认尚未开放，请先存草稿；资料尚未提交。');
  }
  function selectFile(key: string, file: File | undefined) {
    if (!file) return;
    const ext = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    const mime: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
    };
    const error =
      !mime[ext] || (key === 'resume' && ext !== 'pdf')
        ? '文件格式不支持'
        : file.type && file.type !== mime[ext]
          ? '文件格式与扩展名不一致'
          : file.size === 0
            ? '不能选择空文件'
            : file.size > 10 * 1024 * 1024
              ? '文件大小不能超过 10MB'
              : '';
    setErrors((current) => ({ ...current, [key]: error }));
    if (error) return;
    if (key === 'resume' && files.resume) {
      setReplacement(file);
      return;
    }
    setFiles((current) => ({ ...current, [key]: file }));
  }
  function removeMaterial(group: 'qualifications' | 'portfolios', id: number) {
    const fileKey = `${group === 'qualifications' ? 'qualification' : 'portfolio'}-${id}`;
    setFiles((current) => ({ ...current, [fileKey]: null }));
    const replacementId = nextMaterial.current++;
    setDraft((current) => ({
      ...current,
      [group]:
        current[group].length === 1
          ? [{ id: replacementId, name: '' }]
          : current[group].filter((entry) => entry.id !== id),
    }));
  }
  function addMaterial(group: 'qualifications' | 'portfolios') {
    const entry = { id: nextMaterial.current++, name: '' };
    setDraft((current) => ({ ...current, [group]: [...current[group], entry] }));
  }
  function upload(key: string, label: string) {
    return (
      <FormField key={key} label={label} controlId={`dossier-file-${key}`} error={errors[key]}>
        <Input
          id={`dossier-file-${key}`}
          type="file"
          accept={key === 'resume' ? '.pdf' : '.pdf,.jpg,.jpeg,.png'}
          aria-invalid={!!errors[key]}
          onChange={(event) => {
            selectFile(key, event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <p className="text-xs text-muted-foreground">
          {files[key]?.name ?? '未选择'} · 仅本地选择，尚未上传
        </p>
        {files[key] && (
          <Button
            variant="outline"
            size="mobileTouch"
            onClick={() => setFiles((current) => ({ ...current, [key]: null }))}
          >
            移除{label}
          </Button>
        )}
      </FormField>
    );
  }
  return (
    <Card className="space-y-5 p-5">
      <p className="text-sm">信息完整度：低。请真实填写；当前仅支持文字草稿，信息尚未确认。</p>
      <nav aria-label="档案分区" className="sticky top-16 z-10 flex flex-wrap gap-2 bg-card py-2">
        {sectionLabels.map((label, index) => (
          <Button
            key={label}
            variant={active === index ? 'soft' : 'ghost'}
            size="mobileTouch"
            aria-current={active === index ? 'location' : undefined}
            onClick={() => {
              const sections =
                form.current?.querySelectorAll<HTMLElement>('[data-dossier-section]');
              sections?.[index]?.scrollIntoView({ block: 'start' });
            }}
          >
            {label}
          </Button>
        ))}
      </nav>
      <form ref={form} onSubmit={confirm} className="space-y-6" noValidate>
        <section data-dossier-section className="scroll-mt-28 space-y-3">
          <h3>基本信息</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['name', '姓名'],
                ['phone', '电话'],
                ['email', '邮箱'],
                ['birth', '出生日期'],
              ] as const
            ).map(([key, label]) => (
              <FormField key={key} label={label} controlId={`dossier-${key}`} error={errors[key]}>
                <Input
                  id={`dossier-${key}`}
                  type={key === 'birth' ? 'date' : 'text'}
                  aria-invalid={!!errors[key]}
                  value={draft[key]}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                />
              </FormField>
            ))}
          </div>
          {upload('resume', '简历（PDF，10MB 以内）')}
        </section>
        {(Object.keys(groups) as Group[]).map((group, index) => (
          <section key={group} data-dossier-section className="scroll-mt-28 space-y-3">
            <h3>{sectionLabels[index + 1]}</h3>
            {draft[group].map((row, rowIndex) => (
              <div key={rowIndex} className="space-y-3 rounded-md border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {groups[group].map((label, field) => {
                    const id = `${group}-${rowIndex}-${field}`;
                    const update = (value: string) =>
                      setDraft((current) => ({
                        ...current,
                        [group]: current[group].map((old, at) =>
                          at === rowIndex
                            ? old.map((cell, cellIndex) => (cellIndex === field ? value : cell))
                            : old,
                        ),
                      }));
                    return (
                      <FormField key={label} controlId={id} label={label} error={errors[id]}>
                        {label === '学历' ? (
                          <select
                            id={id}
                            value={row[field]}
                            onChange={(event) => update(event.target.value)}
                            aria-invalid={!!errors[id]}
                            className="min-h-11 w-full rounded-md border bg-card px-3"
                          >
                            <option value="">请选择学历</option>
                            {degrees.map((degree) => (
                              <option key={degree}>{degree}</option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            id={id}
                            type={label.includes('月份') ? 'month' : 'text'}
                            value={row[field]}
                            onChange={(event) => update(event.target.value)}
                            aria-invalid={!!errors[id]}
                          />
                        )}
                      </FormField>
                    );
                  })}
                </div>
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={group === 'education' && draft[group].length === 1}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      [group]: current[group].filter((_, at) => at !== rowIndex),
                    }))
                  }
                >
                  删除此段{sectionLabels[index + 1]}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="mobileTouch"
              onClick={() =>
                setDraft((current) => ({ ...current, [group]: [...current[group], empty(group)] }))
              }
            >
              添加{sectionLabels[index + 1]}
            </Button>
          </section>
        ))}
        <section data-dossier-section className="scroll-mt-28 space-y-3">
          <h3>证书</h3>
          {upload('education', '学历证明')}
          {draft.qualifications.map((entry, index) => (
            <div key={entry.id} className="space-y-3 rounded-lg border p-3">
              <label className="block text-sm">
                资格证书名称
                <select
                  className="mt-2 block w-full rounded border p-2"
                  aria-label={`资格证书 ${index + 1}名称`}
                  disabled
                  value={entry.name}
                >
                  <option value={entry.name}>{entry.name || '标准字典尚未接入，暂无候选'}</option>
                </select>
              </label>
              {upload(`qualification-${entry.id}`, `资格证书 ${index + 1}材料`)}
              <Button
                variant="outline"
                size="mobileTouch"
                onClick={() => removeMaterial('qualifications', entry.id)}
              >
                删除资格证书 {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="mobileTouch"
            onClick={() => addMaterial('qualifications')}
          >
            添加资格证书
          </Button>
        </section>
        <section data-dossier-section className="scroll-mt-28 space-y-3">
          <h3>作品集</h3>
          {draft.portfolios.map((entry, index) => (
            <div key={entry.id} className="space-y-3 rounded-lg border p-3">
              <FormField
                controlId={`dossier-portfolio-name-${entry.id}`}
                label="作品集名称（选填）"
              >
                <Input
                  id={`dossier-portfolio-name-${entry.id}`}
                  aria-label={`作品集 ${index + 1}名称`}
                  value={entry.name}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      portfolios: current.portfolios.map((item) =>
                        item.id === entry.id ? { ...item, name: event.target.value } : item,
                      ),
                    }))
                  }
                />
              </FormField>
              {upload(`portfolio-${entry.id}`, `作品集 ${index + 1}文件`)}
              <Button
                variant="outline"
                size="mobileTouch"
                onClick={() => removeMaterial('portfolios', entry.id)}
              >
                删除作品集 {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="mobileTouch"
            disabled={draft.portfolios.length >= 8}
            onClick={() => addMaterial('portfolios')}
          >
            添加作品集（最多 8 个）
          </Button>
        </section>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="mobileTouch" onClick={save}>
            存草稿
          </Button>
          <Button type="submit" size="mobileTouch">
            信息确认
          </Button>
        </div>
      </form>
      {replacement && (
        <OrganizationDialog title="替换已有简历" onClose={() => setReplacement(null)}>
          <p>确认替换当前选择的简历？</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReplacement(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setFiles((current) => ({ ...current, resume: replacement }));
                setReplacement(null);
              }}
            >
              确认替换
            </Button>
          </div>
        </OrganizationDialog>
      )}
    </Card>
  );
}
