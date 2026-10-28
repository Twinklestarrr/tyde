import { useEffect, type PropsWithChildren } from 'react';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { AuthLayout } from '../layouts/AuthLayout';
import { WorkspaceLayout } from '../layouts/WorkspaceLayout';
import { WorkspaceViewProvider } from '../layouts/WorkspaceView';
import { LoginPage } from '../modules/auth/LoginPage';
import { RegisterPage } from '../modules/auth/RegisterPage';
import { ProfilePage } from '../modules/profile/ProfilePage';
import { OrganizationPage } from '../modules/organizations/OrganizationPage';
import { OrganizationCreatePage } from '../modules/organizations/OrganizationCreatePage';
import { AuthFlowProvider, useAuthFlow } from '../modules/auth/AuthFlow';
import { useSession } from '../hooks/useSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { Button } from '../components/ui/button';
import { PageRecovery } from '../components/PageRecovery';
import { NavigatorProjectsPage } from '../modules/projects/NavigatorProjectsPage';
import { ProjectCreatePage } from '../modules/projects/ProjectCreatePage';
import { ProjectDetailPage } from '../modules/projects/ProjectDetailPage';
import { StrategistProjectsPage } from '../modules/projects/StrategistProjectsPage';
import { StrategistProjectPage } from '../modules/projects/StrategistProjectPage';
import { ExpertProjectsPage } from '../modules/projects/ExpertProjectsPage';

/** 离开注册资料页后销毁一次性凭证；布局由匹配路由决定。 */
function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { clearRegistration } = useAuthFlow();
  const registration = pathname === '/register';
  useEffect(() => {
    if (!registration) clearRegistration();
  }, [registration, clearRegistration]);
  return <Outlet />;
}

function AuthPageLayout({
  children,
  registration = false,
}: PropsWithChildren<{ registration?: boolean }>) {
  return (
    <AuthLayout registration={registration}>
      <div className="flex min-w-0 flex-col">
        <header className={`flex-none ${registration ? 'mb-0' : 'mb-[28px]'}`}>
          <h1
            className={`m-0 font-semibold text-foreground ${registration ? 'text-[20px]' : 'text-[24px]'}`}
          >
            {registration ? '完善个人资料' : '登录 / 注册'}
          </h1>
          <p className="mt-[8px] text-[13px] leading-relaxed text-muted-foreground">
            {registration
              ? '请完善个人信息，完成账号注册。'
              : '使用手机号登录，新账号通过验证码注册。'}
          </p>
          {registration && (
            <Link
              to="/auth"
              className="mt-[4px] inline-flex min-h-[44px] items-center rounded-md text-[12px] text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
            >
              返回登录 / 注册
            </Link>
          )}
        </header>
        {children}
      </div>
    </AuthLayout>
  );
}

/** Provider 与页面处于同一匹配链，避免导航中途拆掉旧页面的上下文。 */
function WorkspaceRoute() {
  return (
    <SessionBoundary>
      <Workspace />
    </SessionBoundary>
  );
}

function Workspace() {
  const session = useSession();
  const user = session.data;
  return user ? (
    <WorkspaceViewProvider key={user.id} user={user}>
      <WorkspaceLayout user={user}>
        {session.isError && (
          <div className="mb-[16px] space-y-[8px]">
            <ErrorNotice error={session.error} />
            <Button onClick={() => void session.refetch()} loading={session.isFetching}>
              重试读取账户资料
            </Button>
          </div>
        )}
        <Outlet />
      </WorkspaceLayout>
    </WorkspaceViewProvider>
  ) : null;
}

/** 会话请求失败时保留错误和重试入口，仅 401 视为未登录。 */
function SessionBoundary({ children }: PropsWithChildren) {
  const session = useSession();
  if (session.isPending)
    return (
      <div className="grid min-h-svh place-items-center bg-muted p-[24px]">
        <p role="status" className="text-[14px] text-[var(--color-neutral-strong)]">
          正在恢复登录状态...
        </p>
      </div>
    );
  if (session.isError && !session.data)
    return (
      <PageRecovery
        fullPage
        title="暂时无法加载账户资料"
        description="请稍后重试，或返回首页重新加载。"
        onRetry={() => void session.refetch()}
        loading={session.isFetching}
      />
    );
  if (!session.data) return <Navigate to="/auth" replace />;
  return children;
}

function HomePage() {
  const session = useSession();
  if (session.data && (session.data.selectedRole ?? session.data.role) === 'NAVIGATOR')
    return <NavigatorProjectsPage key={session.data.id} user={session.data} />;
  if (session.data && (session.data.selectedRole ?? session.data.role) === 'PM')
    return <StrategistProjectsPage key={session.data.id} user={session.data} />;
  return session.data && <ExpertProjectsPage key={session.data.id} user={session.data} />;
}

function NavigatorProjectsRoute() {
  const session = useSession();
  const { created } = projectsRoute.useSearch();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'NAVIGATOR')
    return <Navigate to="/" replace />;
  return (
    session.data && (
      <NavigatorProjectsPage key={session.data.id} user={session.data} created={created} />
    )
  );
}

function StrategistProjectsRoute() {
  const session = useSession();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'PM')
    return <Navigate to="/" replace />;
  return session.data && <StrategistProjectsPage key={session.data.id} user={session.data} />;
}

function StrategistProjectRoute() {
  const session = useSession();
  const { projectId } = strategistProjectRoute.useParams();
  const { tab } = strategistProjectRoute.useSearch();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'PM')
    return <Navigate to="/" replace />;
  if (!/^[1-9]\d*$/.test(projectId) || Number(projectId) > 2_147_483_647)
    return <PageRecovery title="项目地址无效" description="请返回工作台，重新选择项目。" />;
  return (
    session.data && (
      <StrategistProjectPage
        key={`${session.data.id}:${projectId}`}
        user={session.data}
        projectId={Number(projectId)}
        initialTab={tab}
      />
    )
  );
}

function NavigatorProjectCreateRoute() {
  const session = useSession();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'NAVIGATOR')
    return <Navigate to="/" replace />;
  return session.data && <ProjectCreatePage key={session.data.id} user={session.data} />;
}

function NavigatorProjectDetailRoute() {
  const session = useSession();
  const { projectId } = projectDetailRoute.useParams();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'NAVIGATOR')
    return <Navigate to="/" replace />;
  if (!/^[1-9]\d*$/.test(projectId) || Number(projectId) > 2_147_483_647)
    return <PageRecovery title="项目地址无效" description="请返回工作台，重新选择项目。" />;
  return (
    session.data && (
      <ProjectDetailPage
        key={`${session.data.id}:${projectId}`}
        user={session.data}
        projectId={Number(projectId)}
      />
    )
  );
}

function CurrentProfilePage() {
  const session = useSession();
  return session.data && <ProfilePage user={session.data} />;
}

function CurrentOrganizationPage() {
  const session = useSession();
  const { tab } = organizationRoute.useSearch();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'EXPERT')
    return <Navigate to="/" replace />;
  return session.data && <OrganizationPage user={session.data} initialTab={tab} />;
}

function CurrentOrganizationCreatePage() {
  const session = useSession();
  if (session.data && (session.data.selectedRole ?? session.data.role) !== 'EXPERT')
    return <Navigate to="/" replace />;
  return session.data && <OrganizationCreatePage user={session.data} />;
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <Navigate to="/" replace />,
  errorComponent: () => <PageRecovery fullPage />,
});
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'workspace',
  component: WorkspaceRoute,
  errorComponent: () => <PageRecovery fullPage />,
});
const homeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  component: HomePage,
  errorComponent: () => <PageRecovery />,
});
const profileRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/profile',
  component: CurrentProfilePage,
  errorComponent: () => <PageRecovery />,
});
const projectsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/projects',
  validateSearch: (search: Record<string, unknown>): { created?: number } => {
    const created = Number(search.created);
    return {
      created:
        Number.isSafeInteger(created) && created > 0 && created <= 2_147_483_647
          ? created
          : undefined,
    };
  },
  component: NavigatorProjectsRoute,
  errorComponent: () => <PageRecovery />,
});
const projectCreateRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/projects/create',
  component: NavigatorProjectCreateRoute,
  errorComponent: () => <PageRecovery />,
});
const strategistProjectsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/strategist/projects',
  component: StrategistProjectsRoute,
  errorComponent: () => <PageRecovery />,
});
const strategistProjectRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/strategist/projects/$projectId',
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: 'PRODUCTION_PLAN' | 'ENTRANCE_EXAM' } =>
    search.tab === 'ENTRANCE_EXAM' || search.tab === 'PRODUCTION_PLAN' ? { tab: search.tab } : {},
  component: StrategistProjectRoute,
  errorComponent: () => <PageRecovery />,
});
const projectDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/projects/$projectId',
  component: NavigatorProjectDetailRoute,
  errorComponent: () => <PageRecovery />,
});
const organizationRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/organization',
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: 'members' | 'approvals' | 'schedules' } => ({
    tab:
      search.tab === 'members' || search.tab === 'approvals' || search.tab === 'schedules'
        ? search.tab
        : undefined,
  }),
  component: CurrentOrganizationPage,
  errorComponent: () => <PageRecovery />,
});
const organizationCreateRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/organization/create',
  component: CurrentOrganizationCreatePage,
  errorComponent: () => <PageRecovery />,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth',
  component: () => (
    <AuthPageLayout>
      <LoginPage />
    </AuthPageLayout>
  ),
});
const registrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: () => (
    <AuthPageLayout registration>
      <RegisterPage />
    </AuthPageLayout>
  ),
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    workspaceRoute.addChildren([
      homeRoute,
      profileRoute,
      projectsRoute,
      projectCreateRoute,
      projectDetailRoute,
      strategistProjectsRoute,
      strategistProjectRoute,
      organizationRoute,
      organizationCreateRoute,
    ]),
    loginRoute,
    registrationRoute,
  ]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/** Web 与 Electron 共用登录、注册及会话恢复。 */
export function App() {
  return (
    <AuthFlowProvider>
      <RouterProvider router={router} />
    </AuthFlowProvider>
  );
}
