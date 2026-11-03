import { House, RefreshCw } from 'lucide-react';
import { TideIcon } from './icons';
import { Button } from './ui/button';
import { Card, CardDescription, CardTitle } from './ui/card';

function returnHome() {
  const home = new URL(window.location.href);
  home.hash = '/';
  window.history.replaceState(window.history.state, '', home);
  window.location.reload();
}

/** 不依赖会话或角色上下文；布局本身出错时仍可恢复应用。 */
export function PageRecovery({
  fullPage = false,
  title = '页面暂时无法显示',
  description = '遇到了一点问题，请重试，或返回首页继续使用。',
  onRetry = () => window.location.reload(),
  loading = false,
}: {
  fullPage?: boolean;
  title?: string;
  description?: string;
  onRetry?: () => void;
  loading?: boolean;
}) {
  return (
    <div className={fullPage ? 'flex min-h-svh flex-col bg-muted' : 'py-[32px] sm:py-[64px]'}>
      {fullPage && (
        <header className="flex h-[64px] shrink-0 items-center gap-[10px] border-b bg-card px-[16px] sm:px-[32px]">
          <span className="grid size-[32px] place-items-center rounded-[8px] bg-primary text-primary-foreground">
            <TideIcon className="size-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-width:2]" />
          </span>
          <span className="text-[20px] font-semibold">Tyde</span>
        </header>
      )}
      <div className={fullPage ? 'grid flex-1 place-items-center px-[16px] py-[32px]' : ''}>
        <Card asChild>
          <section
            aria-label={title}
            role="alert"
            className="mx-auto w-full max-w-[480px] px-6 py-8 text-center sm:p-10"
          >
            <div className="mx-auto mb-5 grid size-[56px] place-items-center rounded-[8px] bg-accent text-[var(--color-primary-strong)]">
              <RefreshCw className="size-[26px]" aria-hidden />
            </div>
            <CardTitle asChild>
              <h1>{title}</h1>
            </CardTitle>
            <CardDescription className="mt-3">{description}</CardDescription>
            <div className="mt-[28px] flex flex-wrap justify-center gap-[10px]">
              <Button size="account" onClick={returnHome}>
                <House className="size-[16px]" aria-hidden />
                返回首页
              </Button>
              <Button variant="outline" size="account" onClick={onRetry} loading={loading}>
                <RefreshCw className="size-[16px]" aria-hidden />
                重试
              </Button>
            </div>
          </section>
        </Card>
      </div>
    </div>
  );
}
