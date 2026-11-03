import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';

interface OrganizationPageHeaderProps {
  title: string;
  description: string;
  backToOrganization?: boolean;
  actions?: ReactNode;
}

/** 组织首页与创建页共用的页头，避免全局标题外边距撑开布局。 */
export function OrganizationPageHeader({
  title,
  description,
  backToOrganization = false,
  actions,
}: OrganizationPageHeaderProps) {
  return (
    <div className="space-y-[12px]">
      {backToOrganization && (
        <Button asChild variant="ghost" size="account" className="-ml-[12px]">
          <Link to="/organization">
            <ArrowLeft className="size-[17px]" aria-hidden />
            返回我的组织
          </Link>
        </Button>
      )}
      <PageHeader
        title={title}
        description={description}
        icon={<Building2 className="size-[22px]" aria-hidden />}
        actions={actions}
      />
    </div>
  );
}
