import type { OrganizationMember } from '@tyde/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { OrganizationDialog } from './common';

/** 沿用旧版档案只读预览；列表之外的材料尚未同步，不拿本人的草稿替代成员档案。 */
export function OrganizationMemberDossier({
  member,
  name,
  onClose,
}: {
  member: Pick<OrganizationMember, 'userId' | 'phoneMasked'>;
  name: string;
  onClose: () => void;
}) {
  return (
    <OrganizationDialog title={`${name}的档案`} onClose={onClose}>
      <p className="mb-4 text-sm text-muted-foreground">详细档案暂未同步</p>
      <Tabs defaultValue="identity">
        <TabsList className="flex h-auto flex-wrap" aria-label="成员档案内容">
          {['用户信息', '学历证明', '资格证书', '作品集'].map((label, index) => (
            <TabsTrigger key={label} value={index === 0 ? 'identity' : String(index)}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="identity" className="space-y-4">
          <dl className="space-y-2 text-sm">
            <div>
              <dt>姓名</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>用户 ID</dt>
              <dd className="break-all">{member.userId || '—'}</dd>
            </div>
            <div>
              <dt>手机号</dt>
              <dd>{member.phoneMasked || '—'}</dd>
            </div>
          </dl>
          {['教育经历', '工作经历', '项目经历'].map((label) => (
            <section key={label}>
              <h3 className="text-sm font-medium">{label}</h3>
              <p className="text-sm text-muted-foreground">暂未同步</p>
            </section>
          ))}
        </TabsContent>
        {[1, 2, 3].map((index) => (
          <TabsContent key={index} value={String(index)}>
            <EmptyState title="材料暂未同步" description="尚无可预览材料或核验结果。" />
            <Button variant="outline" disabled>
              反馈（材料暂未同步）
            </Button>
          </TabsContent>
        ))}
      </Tabs>
    </OrganizationDialog>
  );
}
