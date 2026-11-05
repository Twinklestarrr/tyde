import { useEffect, useState, type PropsWithChildren } from 'react';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useNavigate,
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
import {
  ProjectDirectoryPage,
  type ProjectDirectorySearch,
  type ProjectDirectoryDetailSearch,
} from '../modules/projects/ProjectDirectoryPage';
import { ProjectDirectoryDetailPage } from '../modules/projects/ProjectDirectoryDetailPage';

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

/** 认证区共享背景与卡片，只在 Outlet 中切换登录和完善资料表单。 */
function AuthPageLayout() {
  const registration = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === registrationRoute.id),
  });
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
        <Outlet />
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

/** 首次恢复有界重试；失败回登录入口，但不清除仍可能有效的会话。 */
function SessionBoundary({ children }: PropsWithChildren) {
  const session = useSession();
  const navigate = useNavigate();
  const [expired, setExpired] = useState(false);
  const recovering = session.isPending && session.failureCount > 0;
  useEffect(() => {
    if (recovering && !expired) void navigate({ to: '/', replace: true });
  }, [recovering, expired, navigate]);
  useEffect(() => {
    if (!session.isPending) return;
    const timer = window.setTimeout(() => setExpired(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [session.isPending]);
  if (!session.data && (expired || session.isError)) return <Navigate to="/auth" replace />;
  if (session.isPending)
    return (
      <div className="grid min-h-svh place-items-center bg-muted p-[24px]">
        <p role="status" className="text-[14px] text-[var(--color-neutral-strong)]">
          正在恢复登录状态...
        </p>
      </div>
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
  const { tab, personnelView } = strategistProjectRoute.useSearch();
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
        initialPersonnelView={personnelView}
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

function ProjectDirectoryRoute() {
  const session = useSession();
  const search = projectDirectoryRoute.useSearch();
  const navigate = useNavigate();
  const user = session.data;
  return (
    user && (
      <ProjectDirectoryPage
        key={`${user.id}:${user.selectedRole ?? user.role}`}
        user={user}
        search={search}
        onSearch={(next) => void navigate({ to: '/project-directory', search: next })}
      />
    )
  );
}

function ProjectDirectoryDetailRoute() {
  const session = useSession();
  const { projectId } = projectDirectoryDetailRoute.useParams();
  const search = projectDirectoryDetailRoute.useSearch();
  const user = session.data;
  if (user && search.scope === 'participating' && (user.selectedRole ?? user.role) !== 'EXPERT')
    return <Navigate to="/project-directory" search={{}} replace />;
  if (!/^[1-9]\d*$/.test(projectId) || Number(projectId) > 2_147_483_647 || search.invalidSource)
    return (
      <PageRecovery
        title="项目地址无效"
        description="请通过顶部“项目”返回项目列表，重新选择项目。"
      />
    );
  return (
    user && (
      <ProjectDirectoryDetailPage
        key={`${user.id}:${user.selectedRole ?? user.role}:${projectId}:${search.scope}:${search.assignmentId}:${search.movementId}`}
        user={user}
        projectId={Number(projectId)}
        search={search}
      />
    )
  );
}

function directoryPositiveId(value: unknown) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)))
    return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? id : undefined;
}

function directorySearch(search: Record<string, unknown>): ProjectDirectorySearch {
  return {
    ...(search.view === 'managed' || search.view === 'participating' ? { view: search.view } : {}),
    ...(typeof search.keyword === 'string' ? { keyword: search.keyword.trim().slice(0, 128) } : {}),
    ...(directoryPositiveId(search.page) ? { page: directoryPositiveId(search.page) } : {}),
  };
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
const projectDirectoryRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/project-directory',
  validateSearch: directorySearch,
  component: ProjectDirectoryRoute,
  errorComponent: () => <PageRecovery />,
});
const projectDirectoryDetailRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/project-directory/$projectId',
  validateSearch: (search: Record<string, unknown>): ProjectDirectoryDetailSearch => {
    const assignmentId = directoryPositiveId(search.assignmentId);
    const movementId = directoryPositiveId(search.movementId);
    const personal = search.scope === 'participating';
    const invalidScope = search.scope !== undefined && search.scope !== 'managed' && !personal;
    const invalidSource =
      invalidScope ||
      (personal
        ? (assignmentId === undefined) === (movementId === undefined) ||
          (search.assignmentId !== undefined && assignmentId === undefined) ||
          (search.movementId !== undefined && movementId === undefined)
        : search.assignmentId !== undefined || search.movementId !== undefined);
    return {
      ...directorySearch(search),
      scope: personal ? 'participating' : 'managed',
      ...(assignmentId === undefined ? {} : { assignmentId }),
      ...(movementId === undefined ? {} : { movementId }),
      ...(invalidSource ? { invalidSource: true } : {}),
    };
  },
  component: ProjectDirectoryDetailRoute,
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
  ): {
    tab?:
      | 'PRODUCTION_PLAN'
      | 'ENTRANCE_EXAM'
      | 'STANDARD_TRAINING'
      | 'RECRUIT_EXECUTION_EXPERT'
      | 'PERSONNEL_MANAGEMENT'
      | 'PRODUCTION_TASK';
    personnelView?: 'movements';
  } =>
    search.tab === 'ENTRANCE_EXAM' ||
    search.tab === 'PRODUCTION_PLAN' ||
    search.tab === 'STANDARD_TRAINING' ||
    search.tab === 'RECRUIT_EXECUTION_EXPERT' ||
    search.tab === 'PERSONNEL_MANAGEMENT' ||
    search.tab === 'PRODUCTION_TASK'
      ? {
          tab: search.tab,
          ...(search.tab === 'PERSONNEL_MANAGEMENT' && search.personnelView === 'movements'
            ? { personnelView: 'movements' as const }
            : {}),
        }
      : {},
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
const authenticationRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authentication',
  component: AuthPageLayout,
});
const loginRoute = createRoute({
  getParentRoute: () => authenticationRoute,
  path: '/auth',
  component: LoginPage,
});
const registrationRoute = createRoute({
  getParentRoute: () => authenticationRoute,
  path: '/register',
  component: RegisterPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    workspaceRoute.addChildren([
      homeRoute,
      profileRoute,
      projectsRoute,
      projectCreateRoute,
      projectDetailRoute,
      projectDirectoryRoute,
      projectDirectoryDetailRoute,
      strategistProjectsRoute,
      strategistProjectRoute,
      organizationRoute,
      organizationCreateRoute,
    ]),
    authenticationRoute.addChildren([loginRoute, registrationRoute]),
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
