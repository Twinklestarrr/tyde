import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronDown, LayoutDashboard, LogOut, UserRound } from 'lucide-react';
import type { AuthUser } from '@tyde/shared';
import { TideIcon } from '@/components/icons';
import { UserAvatar } from '@/components/UserAvatar';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { useWorkspaceView, workspaceViewOptions, type WorkspaceView } from './WorkspaceView';

/** 登录后的公共顶栏，Web 与 Electron 使用相同导航和账户入口。 */
export function WorkspaceLayout({ user, children }: PropsWithChildren<{ user: AuthUser }>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { view, setView, isPending: rolePending, error: roleError } = useWorkspaceView();
  const roleOptions = workspaceViewOptions.filter((option) => user.roles.includes(option.value));
  const showOrganization = view === 'EXPERT';
  const name = user.nickname || user.realName;
  const hasOrganization = typeof user.organization?.id === 'string';
  const managesOrganization =
    hasOrganization &&
    ['OWNER', 'ADMIN'].includes(String(user.organization?.position)) &&
    ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(user.organization?.joinStatus));
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      await cache.cancelQueries();
      cache.clear();
      cache.setQueryData(SESSION_KEY, null);
      await navigate({ to: '/auth', replace: true });
    },
  });

  function changeView(next: WorkspaceView) {
    setView(next);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !logout.isPending) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open, logout.isPending]);

  return (
    <div
      className={`min-h-svh [&_*]:box-border ${pathname === '/profile' ? 'bg-background' : 'bg-muted'}`}
    >
      <a
        href="#workspace-main"
        className="sr-only z-50 focus:not-sr-only focus:fixed focus:top-[12px] focus:left-[12px] focus:rounded-[8px] focus:bg-card focus:p-[12px]"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('workspace-main')?.focus();
        }}
      >
        跳转到主要内容
      </a>
      <header className="sticky top-0 z-30 border-b bg-card">
        <div className="mx-auto flex h-[64px] max-w-[1280px] items-center gap-[12px] px-[16px] min-[400px]:gap-[24px] sm:gap-[40px] sm:px-[32px]">
          <Link
            to="/"
            aria-label="Tyde 首页"
            className="flex shrink-0 items-center gap-[8px] rounded-[8px] focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="grid size-[32px] place-items-center rounded-[8px] bg-primary text-primary-foreground">
              <TideIcon className="size-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-width:2]" />
            </span>
            <span className="text-[20px] font-semibold tracking-tight max-[359px]:hidden">
              Tyde
            </span>
            <span className="hidden border-l pl-[10px] text-[13px] text-[var(--color-neutral-strong)] sm:inline">
              潮汐
            </span>
          </Link>
          <nav
            aria-label="主导航"
            className="flex h-full shrink-0 items-center gap-[8px] whitespace-nowrap sm:gap-[24px]"
          >
            <Link
              to="/"
              aria-current={pathname === '/' ? 'page' : undefined}
              className={`relative flex h-full items-center gap-[8px] px-[4px] text-[13px] font-medium outline-offset-4 transition-colors hover:text-[var(--color-primary-strong)] ${pathname === '/' ? 'text-[var(--color-primary-strong)] after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-t after:bg-primary' : 'text-[var(--color-neutral-strong)]'}`}
            >
              <LayoutDashboard className="hidden size-[18px] sm:block" aria-hidden />
              工作台
            </Link>
            {showOrganization && (
              <Link
                to="/organization"
                aria-current={pathname.startsWith('/organization') ? 'page' : undefined}
                className={`relative flex h-full items-center gap-[8px] px-[4px] text-[13px] font-medium outline-offset-4 transition-colors hover:text-[var(--color-primary-strong)] ${pathname.startsWith('/organization') ? 'text-[var(--color-primary-strong)] after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-t after:bg-primary' : 'text-[var(--color-neutral-strong)]'}`}
              >
                <Building2 className="hidden size-[18px] sm:block" aria-hidden />
                {managesOrganization ? '组织管理' : '我的组织'}
              </Link>
            )}
          </nav>
          <div className="ml-auto hidden shrink-0 lg:block">
            <Select
              value={view}
              disabled={rolePending}
              onValueChange={(value) => {
                const option = roleOptions.find((item) => item.value === value);
                if (option) changeView(option.value);
              }}
            >
              <SelectTrigger size="profile" aria-label="当前角色" className="w-[196px]">
                <span className="flex items-center">
                  当前角色：
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div ref={menu} className="relative ml-auto min-w-0 shrink-0 lg:ml-0">
            <Button
              ref={trigger}
              variant="ghost"
              size="account"
              className="gap-[8px] px-[8px]"
              aria-label="账户菜单"
              aria-expanded={open}
              aria-controls="account-menu"
              onClick={() => setOpen((current) => !current)}
            >
              <UserAvatar
                url={user.avatarUrl}
                name={name}
                className="size-[32px] rounded-full text-[13px]"
              />
              <span className="hidden max-w-[80px] truncate text-foreground sm:block lg:max-w-[140px]">
                {name}
              </span>
              <ChevronDown
                className={`size-[18px] transition-transform ${open ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </Button>
            {open && (
              <nav
                id="account-menu"
                aria-label="账户选项"
                className="absolute right-0 top-[calc(100%+8px)] w-[248px] max-w-[calc(100vw-32px)] rounded-[12px] border bg-popover p-[6px] shadow-lg"
              >
                <div className="mb-[6px] border-b px-[12px] py-[12px]">
                  <p className="truncate text-[14px] font-semibold">{name}</p>
                  <p className="mt-[4px] text-[12px] text-[var(--color-neutral-strong)]">
                    {user.phone}
                  </p>
                </div>
                <div className="mb-[6px] border-b px-[6px] pb-[12px] lg:hidden">
                  <p className="mb-[6px] px-[6px] text-[12px] text-[var(--color-neutral-strong)]">
                    切换角色
                  </p>
                  <div role="group" aria-label="当前角色" className="grid grid-cols-3 gap-[4px]">
                    {roleOptions.map((option) => (
                      <Button
                        key={option.value}
                        variant={view === option.value ? 'soft' : 'ghost'}
                        size="account"
                        className="px-[4px] text-[12px]"
                        disabled={rolePending}
                        aria-pressed={view === option.value}
                        onClick={() => {
                          changeView(option.value);
                          trigger.current?.focus();
                        }}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <Button
                  asChild
                  variant="ghost"
                  size="account"
                  className="w-full justify-start gap-[12px] hover:bg-accent"
                >
                  <Link
                    to="/profile"
                    onClick={() => setOpen(false)}
                    aria-current={pathname === '/profile' ? 'page' : undefined}
                  >
                    <UserRound className="size-[18px]" aria-hidden />
                    个人中心
                  </Link>
                </Button>
                {showOrganization && (
                  <Button
                    asChild
                    variant="ghost"
                    size="account"
                    className="w-full justify-start gap-[12px] hover:bg-accent"
                  >
                    <Link
                      to="/organization"
                      onClick={() => setOpen(false)}
                      aria-current={pathname === '/organization' ? 'page' : undefined}
                    >
                      <Building2 className="size-[18px]" aria-hidden />
                      {managesOrganization ? '组织管理' : '我的组织'}
                    </Link>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="account"
                  className="w-full justify-start gap-[12px]"
                  loading={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  <LogOut className="size-[18px]" aria-hidden />
                  退出登录
                </Button>
                <ErrorNotice error={logout.error} />
              </nav>
            )}
          </div>
        </div>
      </header>
      <main
        id="workspace-main"
        tabIndex={-1}
        className={`mx-auto w-full max-w-[1280px] px-[16px] pb-[24px] outline-none sm:px-[32px] sm:pb-[32px] ${pathname === '/profile' ? 'pt-[16px]' : 'pt-[24px] sm:pt-[32px]'}`}
      >
        {roleError != null && (
          <div className="mb-[16px]">
            <ErrorNotice error={roleError} />
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
