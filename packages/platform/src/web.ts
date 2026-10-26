import {
  API_PREFIX,
  ApiError,
  OrganizationImportError,
  AVATAR_MAX_BYTES,
  AVATAR_EXTENSIONS,
  PROJECT_ATTACHMENT_MAX_BYTES,
  PROJECT_ATTACHMENT_EXTENSIONS,
  BUSINESS_ROLES,
  type AuthApi,
  type ApiFailure,
  type AuthUser,
  type OrganizationDetail,
  type OrganizationMember,
  type OrganizationPage,
  type OrganizationUpdateResult,
  type OrganizationMemberUpdateResult,
  type OrganizationMemberRoleResult,
  type OrganizationDepartureResult,
  type OrganizationPendingApproval,
  type OrganizationApprovalRecord,
  type OrganizationApprovalProcessResult,
  type OrganizationImportResult,
  type OrganizationScheduleDay,
  type OrganizationSchedulesInput,
  type OrganizationSchedulesResult,
  type OrganizationScheduleResult,
  type WorkbenchProject,
  type WorkbenchProjectDetail,
  type NavigatorProjectCard,
  type ProjectCategory,
  type ProjectRequester,
  type ProjectDraft,
  type CurrentProjectDraft,
  type ProjectMutation,
  type ProjectManagerCandidate,
  type ProjectManagerRecruitmentInput,
  type ProjectManagerRecruitmentResult,
  type ProjectAttachmentUploadResult,
  type WorkbenchAssignmentDetail,
  type WorkbenchProductionPlan,
  type WorkbenchApplication,
  type WorkbenchAttendanceQuery,
  type WorkbenchAttendanceDay,
  type WorkbenchAttendanceMonth,
  type WorkbenchHolidayMonth,
  type WorkbenchAttendanceApplicationResult,
  type WorkbenchScheduleResult,
  type WorkbenchAttendanceUpdateResult,
  type ImageUploadResult,
  type BusinessLicenseUploadResult,
  type BusinessRole,
  type UserProfileUpdateInput,
  type RegistrationRequired,
  type VerifyResult,
} from '@tyde/shared';

/** 两端共享浏览器 HTTP 链路；桌面仅注入可信 API 源与跨源 Cookie 策略。 */
export function createHttpAuth(
  apiBaseUrl: () => Promise<string> = async () => '',
  credentials: RequestCredentials = 'same-origin',
): AuthApi {
  let refreshToken: string | undefined;
  let generation = 0;
  let refreshing: Promise<boolean> | undefined;
  let sessionChanges: Promise<unknown> = Promise.resolve();

  // Cookie 在浏览器收到响应时即生效，登录与退出必须保持服务器响应顺序。
  function changeSession<T>(operation: () => Promise<T>): Promise<T> {
    const task = sessionChanges.then(operation, operation);
    sessionChanges = task.catch(() => undefined);
    return task;
  }

  function invalidResponse(): never {
    throw new ApiError(502, { code: 'INVALID_RESPONSE', message: '服务响应格式异常，请稍后重试' });
  }
  function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function failure(value: unknown): ApiFailure {
    return {
      code:
        record(value) && (typeof value.code === 'string' || typeof value.code === 'number')
          ? value.code
          : 'SERVICE_UNAVAILABLE',
      message:
        record(value) && typeof value.message === 'string' && value.message
          ? value.message
          : '服务暂不可用，请稍后重试',
      ...(record(value) && typeof value.requestId === 'string'
        ? { requestId: value.requestId }
        : {}),
    };
  }
  function retryAfter(response: Response): number | undefined {
    const value = response.headers.get('Retry-After');
    if (!value) return undefined;
    const seconds = /^\d+$/.test(value)
      ? Number(value)
      : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
  interface RequestOptions {
    headers?: Record<string, string>;
    decode?: (response: Response) => Promise<unknown>;
    timeoutMs?: number;
  }
  async function send(
    path: string,
    body?: unknown,
    method = 'POST',
    options: RequestOptions = {},
  ): Promise<Response> {
    try {
      return await fetch(`${await apiBaseUrl()}${API_PREFIX}${path}`, {
        method,
        credentials,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        headers: {
          // 读取沿用 Cookie 认证，避免跨源请求产生额外预检。
          ...(method === 'GET' || method === 'HEAD' ? {} : { 'X-Tyde-Client': 'web' }),
          ...(body !== undefined && !(body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...options.headers,
        },
        ...(body !== undefined
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, { code: 'NETWORK_ERROR', message: '连接服务失败，请检查网络后重试' });
    }
  }
  async function read(response: Response, wrapped = true): Promise<unknown> {
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new ApiError(response.status, failure(payload), retryAfter(response));
    if (!record(payload)) invalidResponse();
    if (!wrapped) return payload;
    if (payload.code !== 200) {
      if (typeof payload.code !== 'number') invalidResponse();
      throw new ApiError(response.status, failure(payload), retryAfter(response));
    }
    if (!Object.hasOwn(payload, 'data')) invalidResponse();
    return payload.data;
  }
  function remember(value: unknown, expectedGeneration: number): void {
    if (
      !record(value) ||
      typeof value.accessToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.accessToken) ||
      typeof value.refreshToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.refreshToken) ||
      value.tokenType !== 'Bearer' ||
      typeof value.expiresIn !== 'number' ||
      !Number.isFinite(value.expiresIn) ||
      value.expiresIn <= 0
    )
      invalidResponse();
    if (generation !== expectedGeneration)
      throw new ApiError(409, { code: 'SESSION_CHANGED', message: '登录状态已变化，请重新操作' });
    // Web 使用 HttpOnly Cookie，刷新令牌仅留在适配器内存中。
    refreshToken = value.refreshToken;
  }
  async function refresh(): Promise<boolean> {
    if (refreshing) return refreshing;
    if (!refreshToken) return false;
    const token = refreshToken;
    const current = generation;
    const task = (async () => {
      try {
        remember(await read(await send('/auth/refresh', { refreshToken: token })), current);
        return true;
      } catch (error) {
        if (
          generation === current &&
          error instanceof ApiError &&
          [401, 403].includes(error.status)
        )
          refreshToken = undefined;
        if (error instanceof ApiError && [401, 403, 409].includes(error.status)) return false;
        throw error;
      }
    })();
    refreshing = task;
    try {
      return await task;
    } finally {
      if (refreshing === task) refreshing = undefined;
    }
  }
  async function request(
    path: string,
    body?: unknown,
    method = 'POST',
    authenticated = false,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const current = generation;
    const originalRefreshToken = refreshToken;
    const response = await send(path, body, method, options);
    const ensureCurrentSession = () => {
      if (authenticated && current !== generation)
        throw new ApiError(401, { code: 'SESSION_CHANGED', message: '登录状态已变化，请重新登录' });
    };
    ensureCurrentSession();
    if (response.status === 401 && authenticated) {
      // 迟到的旧请求遇到 401 时，直接复用另一请求已经轮换的新 Cookie。
      const refreshedElsewhere = Boolean(refreshToken && refreshToken !== originalRefreshToken);
      if (refreshedElsewhere || (await refresh())) {
        ensureCurrentSession();
        const data = await (options.decode ?? read)(await send(path, body, method, options));
        ensureCurrentSession();
        return data;
      }
    }
    const data = await (options.decode ?? read)(response);
    ensureCurrentSession();
    return data;
  }
  function user(value: unknown): AuthUser {
    if (
      !record(value) ||
      typeof value.id !== 'string' ||
      typeof value.uid !== 'string' ||
      typeof value.phone !== 'string' ||
      typeof value.realName !== 'string' ||
      typeof value.nickname !== 'string'
    )
      invalidResponse();
    return value as unknown as AuthUser;
  }
  function organization(value: unknown): OrganizationDetail {
    if (
      !record(value) ||
      !['id', 'name', 'createdAt'].every((key) => typeof value[key] === 'string') ||
      !['unifiedCreditCode', 'description', 'businessLicenseUrl', 'logoUrl'].every(
        (key) => value[key] === null || typeof value[key] === 'string',
      ) ||
      !Array.isArray(value.expertiseTags) ||
      !value.expertiseTags.every((tag) => typeof tag === 'string') ||
      !['PENDING', 'APPROVED', 'REJECTED'].includes(value.verifyStatus as string) ||
      !['ACTIVE', 'FROZEN', 'DISSOLVED'].includes(value.status as string) ||
      !['OWNER', 'ADMIN', 'MEMBER'].includes(value.position as string)
    )
      invalidResponse();
    return value as unknown as OrganizationDetail;
  }
  function switchedRole(
    value: unknown,
    role: BusinessRole,
  ): { selectedRole: BusinessRole; roles: BusinessRole[] } {
    if (
      !record(value) ||
      value.selectedRole !== role ||
      !Array.isArray(value.roles) ||
      value.roles.length !== BUSINESS_ROLES.length ||
      !BUSINESS_ROLES.every((availableRole) => (value.roles as unknown[]).includes(availableRole))
    )
      invalidResponse();
    return value as unknown as { selectedRole: BusinessRole; roles: BusinessRole[] };
  }
  const positions = ['OWNER', 'ADMIN', 'MEMBER'];
  const employments = ['FULL_TIME', 'PART_TIME'];
  const joins = [
    'PENDING',
    'PENDING_ACTIVATION',
    'ACTIVE',
    'EXIT_APPROVING',
    'PENDING_LEAVE',
    'LEFT',
    'REMOVED',
  ];
  const flows = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELED'];
  const nodes = [
    'WAITING',
    'PENDING',
    'APPROVED',
    'REJECTED',
    'SKIPPED',
    'CANCELED',
    'TRANSFERRED',
  ];
  const inEnum = (value: unknown, values: string[], nullable = false) =>
    (nullable && value === null) || (typeof value === 'string' && values.includes(value));
  const strings = (value: Record<string, unknown>, keys: string[], nullable = false) =>
    keys.every((key) => typeof value[key] === 'string' || (nullable && value[key] === null));
  const integer = (value: unknown, minimum = 0) =>
    Number.isSafeInteger(value) && Number(value) >= minimum;
  function member(value: unknown): OrganizationMember {
    if (
      !record(value) ||
      !strings(value, ['memberId', 'userId', 'uid', 'phoneMasked']) ||
      !strings(
        value,
        ['realName', 'nickname', 'avatarUrl', 'joinedAt', 'plannedLeaveDate', 'leftAt'],
        true,
      ) ||
      !inEnum(value.userStatus, ['ACTIVE', 'FROZEN', 'BANNED']) ||
      !inEnum(value.employmentType, employments, true) ||
      !inEnum(value.position, positions) ||
      !inEnum(value.joinStatus, joins, true) ||
      !integer(value.activeProjectCount) ||
      !integer(value.versionNo)
    )
      invalidResponse();
    return value as unknown as OrganizationMember;
  }
  function page<T>(value: unknown, parse: (row: unknown) => T): OrganizationPage<T> {
    if (
      !record(value) ||
      !integer(value.total) ||
      !integer(value.pages) ||
      !integer(value.current, 1) ||
      !integer(value.size, 1) ||
      !Array.isArray(value.records)
    )
      invalidResponse();
    return {
      total: value.total as number,
      pages: value.pages as number,
      current: value.current as number,
      size: value.size as number,
      records: value.records.map(parse),
    };
  }
  function organizationUpdated(value: unknown): OrganizationUpdateResult {
    if (
      !record(value) ||
      !strings(value, ['id', 'updatedAt']) ||
      !strings(value, ['description', 'logoUrl'], true)
    )
      invalidResponse();
    return value as unknown as OrganizationUpdateResult;
  }
  function memberUpdated(value: unknown): OrganizationMemberUpdateResult {
    if (
      !record(value) ||
      !strings(value, ['memberId', 'userId', 'updatedAt']) ||
      !strings(value, ['joinedAt'], true) ||
      !inEnum(value.employmentType, employments, true) ||
      !integer(value.versionNo)
    )
      invalidResponse();
    return value as unknown as OrganizationMemberUpdateResult;
  }
  function roleUpdated(value: unknown): OrganizationMemberRoleResult {
    if (
      !record(value) ||
      !strings(value, ['memberId', 'updatedAt']) ||
      !inEnum(value.beforePosition, positions) ||
      !inEnum(value.position, positions)
    )
      invalidResponse();
    return value as unknown as OrganizationMemberRoleResult;
  }
  function departure(value: unknown): OrganizationDepartureResult {
    if (
      !record(value) ||
      !strings(value, ['flowNo', 'businessId', 'memberId', 'appliedAt']) ||
      value.businessType !== 'ORG_MEMBER_EXIT' ||
      !inEnum(value.flowStatus, flows) ||
      !inEnum(value.joinStatus, joins, true) ||
      !strings(value, ['plannedLeaveDate'], true)
    )
      invalidResponse();
    return value as unknown as OrganizationDepartureResult;
  }
  function approvalSummary(value: unknown): value is Record<string, unknown> {
    return (
      record(value) &&
      strings(value, ['flowNo', 'businessType', 'businessId', 'title', 'appliedAt']) &&
      strings(
        value,
        [
          'businessNo',
          'applicantName',
          'applyReason',
          'targetMemberId',
          'targetMemberName',
          'plannedLeaveDate',
        ],
        true,
      )
    );
  }
  function pendingApproval(value: unknown): OrganizationPendingApproval {
    if (
      !approvalSummary(value) ||
      !strings(value, ['nodeId', 'nodeName', 'applicantId']) ||
      !strings(value, ['applicantOrgId', 'dueAt'], true) ||
      !integer(value.nodeVersionNo) ||
      !integer(value.flowVersionNo) ||
      !(value.formData === null || record(value.formData))
    )
      invalidResponse();
    return value as unknown as OrganizationPendingApproval;
  }
  function approvalRecord(value: unknown): OrganizationApprovalRecord {
    if (
      !approvalSummary(value) ||
      !strings(value, ['nodeId', 'nodeCode', 'nodeName', 'operatorName', 'actionAt']) ||
      !strings(value, ['actionComment', 'applicantOrgName', 'finishedAt'], true) ||
      !integer(value.nodeSeq, 1) ||
      !inEnum(value.nodeStatus, nodes) ||
      !inEnum(value.flowStatus, flows) ||
      !inEnum(
        value.actionType,
        [
          'SUBMIT',
          'APPROVE',
          'REJECT',
          'WITHDRAW',
          'TRANSFER',
          'AUTO_PASS',
          'AUTO_REJECT',
          'CANCEL',
          'SKIP',
        ],
        true,
      )
    )
      invalidResponse();
    return value as unknown as OrganizationApprovalRecord;
  }
  function approvalProcessed(value: unknown): OrganizationApprovalProcessResult {
    if (
      !record(value) ||
      !strings(value, ['flowNo', 'nodeId', 'processedAt']) ||
      !strings(value, ['plannedLeaveDate', 'finishedAt'], true) ||
      !inEnum(value.action, ['APPROVE', 'REJECT']) ||
      !inEnum(value.nodeStatus, nodes) ||
      !inEnum(value.flowStatus, flows) ||
      !inEnum(value.joinStatus, joins, true) ||
      !(value.currentNode === null || integer(value.currentNode, 1))
    )
      invalidResponse();
    return value as unknown as OrganizationApprovalProcessResult;
  }
  function imported(value: unknown): OrganizationImportResult {
    if (
      !record(value) ||
      !inEnum(value.sourceType, ['EXCEL', 'CSV', 'TEXT']) ||
      typeof value.textIgnored !== 'boolean' ||
      !['totalCount', 'validCount', 'invalidCount', 'createdCount'].every((key) =>
        integer(value[key]),
      ) ||
      !strings(value, ['createdAt'], true) ||
      !Array.isArray(value.rowErrors) ||
      !Array.isArray(value.members) ||
      !value.rowErrors.every(
        (row) =>
          record(row) &&
          integer(row.rowNo) &&
          strings(row, ['field', 'message']) &&
          strings(row, ['value'], true) &&
          inEnum(row.errorCode, [
            'REQUIRED_MISSING',
            'ACCOUNT_REGISTERED',
            'FORMAT_INVALID',
            'ALREADY_JOINED_OTHER_ORGANIZATION',
            'DUPLICATE_IN_BATCH',
            'LIMIT_EXCEEDED',
          ]),
      ) ||
      !value.members.every(
        (row) =>
          record(row) &&
          strings(row, ['memberId', 'userId', 'uid', 'realName']) &&
          strings(row, ['phoneMasked', 'joinedAt'], true) &&
          inEnum(row.accountType, ['INDIVIDUAL', 'ORGANIZATION']) &&
          inEnum(row.position, ['ADMIN', 'MEMBER']) &&
          inEnum(row.employmentType, employments, true) &&
          inEnum(row.joinStatus, ['PENDING_ACTIVATION', 'ACTIVE']),
      )
    )
      invalidResponse();
    return value as unknown as OrganizationImportResult;
  }
  const attendanceManualStatuses = [
    'PRESENT',
    'LATE',
    'EARLY_LEAVE',
    'LATE_EARLY',
    'LEAVE',
    'ABSENT',
    'REST',
  ];
  const attendanceStatuses = [...attendanceManualStatuses, 'UNSCHEDULED', 'REVIEW_REQUIRED'];
  const booleans = (value: Record<string, unknown>, keys: string[], nullable = false) =>
    keys.every((key) => typeof value[key] === 'boolean' || (nullable && value[key] === null));
  const integers = (value: Record<string, unknown>, keys: string[], nullable = false) =>
    keys.every((key) => integer(value[key]) || (nullable && value[key] === null));
  const numbers = (value: Record<string, unknown>, keys: string[], nullable = false) =>
    keys.every(
      (key) =>
        (typeof value[key] === 'number' && Number.isFinite(value[key])) ||
        (nullable && value[key] === null),
    );
  function workbenchProject(value: unknown): WorkbenchProject {
    if (
      !record(value) ||
      !integer(value.assignmentId, 1) ||
      !integer(value.projectId, 1) ||
      !strings(value, ['requesterName', 'currentNodeCode']) ||
      !strings(value, ['projectName'], true) ||
      !booleans(value, ['needWrittenExam']) ||
      !inEnum(value.admissionStatus, ['PASSED', 'PENDING', 'NOT_PASSED', 'NOT_EXAMINED'])
    )
      invalidResponse();
    return value as unknown as WorkbenchProject;
  }
  function workbenchProjectDetail(value: unknown): WorkbenchProjectDetail;
  function workbenchProjectDetail(value: unknown, draft: true): ProjectDraft;
  function workbenchProjectDetail(
    value: unknown,
    draft = false,
  ): WorkbenchProjectDetail | ProjectDraft {
    if (
      !record(value) ||
      !integer(value.id, 1) ||
      !integer(value.versionNo) ||
      value.status !== (draft ? 'DRAFT' : 'PUBLISHED') ||
      (draft ? value.creatorName !== null : typeof value.creatorName !== 'string') ||
      !inEnum(value.requesterType, ['INDIVIDUAL', 'ORGANIZATION']) ||
      !strings(value, [
        'projectNo',
        'requesterId',
        'requesterName',
        'creatorUid',
        'createdAt',
        'updatedAt',
      ]) ||
      !strings(
        value,
        [
          'projectName',
          'projectDescription',
          'categoryLevel1Name',
          'categoryLevel2Name',
          'quantityUnit',
          'deadline',
          'experienceRequirement',
          'workSummary',
          'specialRequirement',
          'mandatoryRequirement',
          'standardContent',
          'standardLink',
          'currentNodeCode',
        ],
        true,
      ) ||
      !integers(value, ['categoryLevel1Id', 'categoryLevel2Id', 'requiredHeadcount'], true) ||
      !numbers(value, ['projectQuantity'], true) ||
      !inEnum(value.difficultyLevel, ['EASY', 'MEDIUM', 'HARD'], true) ||
      !inEnum(
        value.educationRequirement,
        ['PHD', 'MASTER', 'BACHELOR', 'COLLEGE', 'BELOW_COLLEGE'],
        true,
      ) ||
      !inEnum(value.employmentType, ['FULL_TIME', 'PART_TIME', 'UNLIMITED'], true) ||
      !Array.isArray(value.categoryLevel3Ids) ||
      !value.categoryLevel3Ids.every((id) => integer(id, 1)) ||
      !Array.isArray(value.categoryLevel3Names) ||
      !value.categoryLevel3Names.every((name) => typeof name === 'string') ||
      !Array.isArray(value.attachments) ||
      !value.attachments.every(
        (item) =>
          record(item) &&
          integer(item.id, 1) &&
          strings(item, ['fileName', 'objectKey', 'extension', 'contentType', 'fileHash']) &&
          integers(item, ['fileSize', 'sortNo']) &&
          inEnum(item.attachmentType, ['STANDARD_REFERENCE', 'CASE', 'OTHER']) &&
          item.status === 'ACTIVE',
      )
    )
      invalidResponse();
    return value as unknown as WorkbenchProjectDetail | ProjectDraft;
  }
  function navigatorProject(value: unknown): NavigatorProjectCard {
    if (
      !record(value) ||
      !integer(value.id, 1) ||
      !strings(value, [
        'projectNo',
        'categoryDisplayName',
        'statusDescription',
        'currentNodeCode',
        'workbenchStatusDescription',
        'currentActionDescription',
        'requesterName',
        'creatorName',
        'projectManagerStatusDescription',
        'createdAt',
        'updatedAt',
      ]) ||
      !strings(
        value,
        [
          'projectName',
          'projectDescription',
          'categoryLevel1Name',
          'categoryLevel2Name',
          'branchNodeCode',
          'creatorId',
          'projectManagerId',
          'projectManagerName',
          'deadline',
        ],
        true,
      ) ||
      value.status !== 'PUBLISHED' ||
      !inEnum(value.workbenchStatus, ['PENDING', 'PROCESSING']) ||
      !inEnum(value.currentAction, ['RECRUIT_PROJECT_MANAGER', 'VIEW_DETAIL']) ||
      !booleans(value, ['needAssistGrading']) ||
      !integer(value.activeExpertCount) ||
      !integers(value, ['requiredHeadcount'], true) ||
      !Array.isArray(value.categoryLevel3Names) ||
      !value.categoryLevel3Names.every((name) => typeof name === 'string') ||
      !Array.isArray(value.projectOwners) ||
      !value.projectOwners.every(
        (owner) =>
          record(owner) &&
          strings(owner, ['userId', 'name']) &&
          strings(owner, ['avatarUrl'], true),
      )
    )
      invalidResponse();
    return value as unknown as NavigatorProjectCard;
  }
  function projectCategory(value: unknown): ProjectCategory {
    if (
      !record(value) ||
      !integer(value.id, 1) ||
      !strings(value, ['categoryCode', 'categoryName']) ||
      ![1, 2, 3].includes(Number(value.categoryLevel)) ||
      typeof value.categoryLevel !== 'number' ||
      !Number.isSafeInteger(value.sortNo)
    )
      invalidResponse();
    return value as unknown as ProjectCategory;
  }
  function currentProjectDraft(value: unknown): CurrentProjectDraft {
    if (!record(value) || typeof value.hasDraft !== 'boolean') invalidResponse();
    if (value.hasDraft) workbenchProjectDetail(value.draft, true);
    else if (value.draft !== null) invalidResponse();
    return value as unknown as CurrentProjectDraft;
  }
  function projectMutation(value: unknown, operation: string): ProjectMutation {
    const published = operation === 'CREATE_PROJECT';
    if (
      !record(value) ||
      !integer(value.id, 1) ||
      !integer(value.versionNo) ||
      !strings(value, ['projectNo', 'updatedAt']) ||
      value.operation !== operation ||
      value.status !== (published ? 'PUBLISHED' : 'DRAFT') ||
      value.currentNodeCode !== (published ? 'RECRUIT_PROJECT_MANAGER' : null) ||
      (published ? typeof value.publishedAt !== 'string' : value.publishedAt !== null)
    )
      invalidResponse();
    return value as unknown as ProjectMutation;
  }
  function projectManagerCandidate(value: unknown): ProjectManagerCandidate {
    if (
      !record(value) ||
      !inEnum(value.status, ['CURRENT', 'RECOMMENDED']) ||
      !uuid(value.userId) ||
      !strings(value, ['uid', 'name']) ||
      !strings(value, ['avatarUrl'], true) ||
      !integer(value.currentProjectCount)
    )
      invalidResponse();
    return value as unknown as ProjectManagerCandidate;
  }
  function projectManagerRecruitment(
    value: unknown,
    input: ProjectManagerRecruitmentInput,
  ): ProjectManagerRecruitmentResult {
    if (
      !record(value) ||
      !integer(value.recruitmentId, 1) ||
      value.projectId !== input.projectId ||
      !inEnum(value.recruitmentType, ['INITIAL', 'REPLACEMENT']) ||
      value.assignmentMode !== 'DIRECT' ||
      value.status !== 'ASSIGNED' ||
      !inEnum(
        value.currentNodeCode,
        [
          'RECRUIT_PROJECT_MANAGER',
          'PRODUCTION_PLAN',
          'ENTRANCE_EXAM',
          'STANDARD_TRAINING',
          'RECRUIT_EXECUTION_EXPERT',
          'PERSONNEL_MANAGEMENT',
          'PRODUCTION_TASK',
          'COMPLETED',
        ],
        true,
      ) ||
      (value.recruitmentType === 'INITIAL' && value.currentNodeCode !== 'PRODUCTION_PLAN') ||
      value.nextStage !== value.currentNodeCode ||
      value.primaryAction !== 'CHANGE_PROJECT_MANAGER' ||
      !attendanceTime(value.assignedAt)
    )
      invalidResponse();
    const manager = projectManagerCandidate(value.manager);
    if (
      manager.status !== 'CURRENT' ||
      manager.userId.toLowerCase() !== input.candidateUserId.toLowerCase()
    )
      invalidResponse();
    return value as unknown as ProjectManagerRecruitmentResult;
  }
  function projectUploaded(
    value: unknown,
    file: File,
    extension: string,
  ): ProjectAttachmentUploadResult {
    if (
      !record(value) ||
      !uuid(value.fileId) ||
      !strings(value, [
        'objectKey',
        'uploadToken',
        'fileName',
        'extension',
        'contentType',
        'fileHash',
      ]) ||
      value.url !== null ||
      value.sensitive !== true ||
      value.size !== file.size ||
      value.extension !== extension ||
      !/^project-attachment\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.[a-z0-9]+$/.test(
        String(value.objectKey),
      ) ||
      !String(value.objectKey).endsWith(`.${extension}`) ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(value.uploadToken)) ||
      !/^[a-f0-9]{64}$/.test(String(value.fileHash))
    )
      invalidResponse();
    return value as unknown as ProjectAttachmentUploadResult;
  }
  function workbenchPlan(value: unknown): WorkbenchProductionPlan {
    if (
      !record(value) ||
      !booleans(value, ['hasPlan']) ||
      !integers(value, ['planId', 'operatorHeadcount', 'inspectorHeadcount'], true) ||
      !numbers(value, ['operatorCpd', 'inspectorCpd', 'totalExpectedOutput'], true) ||
      !Array.isArray(value.crowds) ||
      !value.crowds.every(
        (row) =>
          record(row) &&
          integers(row, ['id'], true) &&
          integer(row.sequenceNo, 1) &&
          strings(row, ['crowdName', 'profileRequirement'], true),
      ) ||
      !Array.isArray(value.stages) ||
      !value.stages.every(
        (row) =>
          record(row) &&
          integers(row, ['id', 'workdayCount', 'operatorHeadcount', 'naturalDayCount'], true) &&
          integer(row.sequenceNo, 1) &&
          strings(row, ['stageName', 'startDate', 'endDate'], true) &&
          numbers(row, ['operatorCpd', 'accuracyRate', 'expectedOutput'], true) &&
          inEnum(row.workdayCountSource, ['AUTO', 'MANUAL'], true),
      )
    )
      invalidResponse();
    return value as unknown as WorkbenchProductionPlan;
  }
  function workbenchAssignment(value: unknown, assignmentId: number): WorkbenchAssignmentDetail {
    if (
      !record(value) ||
      value.assignmentId !== assignmentId ||
      !strings(value, ['currentNodeCode'], true) ||
      !Array.isArray(value.availableOperations) ||
      !value.availableOperations.every((operation) => operation === 'VIEW_DETAIL')
    )
      invalidResponse();
    workbenchProjectDetail(value.projectDetail);
    workbenchPlan(value.productionPlan);
    return value as unknown as WorkbenchAssignmentDetail;
  }
  function workbenchApplication(value: unknown): WorkbenchApplication {
    if (
      !record(value) ||
      !strings(value, [
        'applicationId',
        'flowNo',
        'businessType',
        'businessId',
        'title',
        'appliedAt',
      ]) ||
      !strings(
        value,
        [
          'businessNo',
          'applicantOrgId',
          'applicantOrgName',
          'applyReason',
          'currentNodeCode',
          'targetMemberId',
          'targetMemberName',
          'plannedLeaveDate',
          'finishedAt',
        ],
        true,
      ) ||
      !integer(value.flowVersionNo) ||
      !(value.currentNode === null || integer(value.currentNode, 1)) ||
      !inEnum(value.status, flows) ||
      !(value.canWithdraw === undefined || typeof value.canWithdraw === 'boolean') ||
      !(value.formData === null || record(value.formData))
    )
      invalidResponse();
    return value as unknown as WorkbenchApplication;
  }
  function attendanceCalendarDay(value: unknown): OrganizationScheduleDay {
    if (
      !record(value) ||
      !strings(value, ['scheduleDate']) ||
      !strings(
        value,
        [
          'shiftStartAt',
          'shiftEndAt',
          'timezone',
          'batchNo',
          'firstClockInAt',
          'lastClockOutAt',
          'reviewReason',
        ],
        true,
      ) ||
      !integers(value, ['scheduleId', 'versionNo', 'dailyId', 'dailyVersionNo'], true) ||
      !booleans(value, ['reviewRequired', 'manualOverride'], true) ||
      !inEnum(value.calendarStatus, [...attendanceStatuses, 'PENDING_ATTENDANCE']) ||
      !inEnum(value.dayType, ['WORK', 'REST'], true) ||
      !inEnum(value.sourceType, ['MANUAL', 'AI_ASSISTANT'], true) ||
      !inEnum(value.status, ['ACTIVE', 'CANCELED'], true) ||
      !inEnum(value.autoStatus, attendanceStatuses, true) ||
      !inEnum(value.finalStatus, attendanceStatuses, true)
    )
      invalidResponse();
    return value as unknown as OrganizationScheduleDay;
  }
  function workbenchAttendanceDay(value: unknown): WorkbenchAttendanceDay {
    attendanceCalendarDay(value);
    if (
      !record(value) ||
      !record(value.permissions) ||
      !booleans(value.permissions, [
        'canApplyLeave',
        'canApplyCorrection',
        'canWithdraw',
        'canDirectUpdate',
      ])
    )
      invalidResponse();
    const application = value.application;
    if (!(
      application === null ||
      (record(application) &&
        strings(application, ['applicationId', 'flowNo']) &&
        integer(application.flowVersionNo) &&
        inEnum(application.applicationType, ['LEAVE', 'CORRECTION']) &&
        inEnum(application.status, flows) &&
        inEnum(application.finalStatus, attendanceManualStatuses) &&
        booleans(application, ['canWithdraw']))
    ))
      invalidResponse();
    return value as unknown as WorkbenchAttendanceDay;
  }
  function monthQuery(input: WorkbenchAttendanceQuery): string {
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) ||
      Number(input.month.slice(0, 4)) < 1900 ||
      (input.orgId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.orgId))
    )
      throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '请提供有效的月份和组织 ID' });
    return new URLSearchParams({
      month: input.month,
      ...(input.orgId ? { orgId: input.orgId } : {}),
    }).toString();
  }
  const monthDayCount = (month: string) =>
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  function workbenchAttendance(
    value: unknown,
    input: WorkbenchAttendanceQuery,
  ): WorkbenchAttendanceMonth {
    if (
      !record(value) ||
      value.month !== input.month ||
      value.organizationId !== (input.orgId ?? null) ||
      value.independentSchedule !== !input.orgId ||
      !strings(value, ['userId']) ||
      !strings(value, ['memberId', 'realName', 'nickname'], true) ||
      !record(value.summary) ||
      !integers(value.summary, [
        'presentCount',
        'lateCount',
        'earlyLeaveCount',
        'leaveCount',
        'absentCount',
      ]) ||
      !record(value.permissions) ||
      !booleans(value.permissions, [
        'canBatchSchedule',
        'canDirectUpdate',
        'canApply',
        'canWithdraw',
      ]) ||
      !Array.isArray(value.days) ||
      value.days.length !== monthDayCount(input.month)
    )
      invalidResponse();
    value.days.forEach((day, index) => {
      if (
        workbenchAttendanceDay(day).scheduleDate !==
        `${input.month}-${String(index + 1).padStart(2, '0')}`
      )
        invalidResponse();
    });
    return value as unknown as WorkbenchAttendanceMonth;
  }
  function workbenchHolidays(value: unknown, month: string): WorkbenchHolidayMonth {
    if (
      !record(value) ||
      value.month !== month ||
      !Array.isArray(value.days) ||
      !value.days.every(
        (row) =>
          record(row) &&
          strings(row, ['date', 'weekName', 'holidayName']) &&
          typeof row.date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
          row.date.startsWith(`${month}-`) &&
          Number(row.date.slice(8)) >= 1 &&
          Number(row.date.slice(8)) <= monthDayCount(month) &&
          integer(row.dayOfWeek, 1) &&
          Number(row.dayOfWeek) <= 7 &&
          inEnum(row.calendarDayType, ['PUBLIC_HOLIDAY', 'MAKEUP_WORKDAY']) &&
          inEnum(row.defaultScheduleDayType, ['WORK', 'REST']),
      )
    )
      invalidResponse();
    return value as unknown as WorkbenchHolidayMonth;
  }
  const uuid = (value: unknown) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const attendanceVersion = (value: unknown) => integer(value) && Number(value) <= 2147483647;
  const attendanceDate = (value: unknown): value is string => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number(value.slice(0, 4)) < 1900
    )
      return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const attendanceTime = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value) &&
    attendanceDate(value.slice(0, 10));
  const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  function invalidAttendanceInput(): never {
    throw new ApiError(400, {
      code: 'VALIDATION_ERROR',
      message: '排班或考勤参数不完整，请检查日期、时段和版本后重试',
    });
  }
  function organizationSchedulesInput(input: OrganizationSchedulesInput) {
    if (
      !record(input) ||
      !onlyKeys(input, [
        'orgId',
        'month',
        'keyword',
        'employmentType',
        'joinStatus',
        'position',
        'projectId',
        'current',
        'size',
      ]) ||
      !uuid(input.orgId) ||
      typeof input.month !== 'string' ||
      !(
        input.keyword == null ||
        (typeof input.keyword === 'string' && input.keyword.length <= 100)
      ) ||
      !(input.employmentType == null || inEnum(input.employmentType, employments)) ||
      !(input.joinStatus == null || inEnum(input.joinStatus, joins)) ||
      !(input.position == null || inEnum(input.position, positions)) ||
      !(
        input.projectId == null ||
        (integer(input.projectId, 1) && input.projectId <= 2147483647)
      ) ||
      !(
        input.current === undefined ||
        (integer(input.current, 1) && input.current <= 2147483647)
      ) ||
      !(input.size === undefined || (integer(input.size, 1) && input.size <= 100))
    )
      invalidAttendanceInput();
    monthQuery(input);
  }
  function organizationSchedules(
    value: unknown,
    input: OrganizationSchedulesInput,
  ): OrganizationSchedulesResult {
    if (
      !record(value) ||
      value.month !== input.month ||
      !integers(value, ['total', 'pages']) ||
      value.current !== (input.current ?? 1) ||
      value.size !== (input.size ?? 20) ||
      value.pages !== Math.ceil(Number(value.total) / Number(value.size)) ||
      !Array.isArray(value.members) ||
      value.members.length !==
        Math.min(
          Number(value.size),
          Math.max(0, Number(value.total) - (Number(value.current) - 1) * Number(value.size)),
        )
    )
      invalidResponse();
    const members = new Set<string>();
    for (const member of value.members) {
      if (
        !record(member) ||
        !uuid(member.memberId) ||
        !uuid(member.userId) ||
        members.has(String(member.memberId).toLowerCase()) ||
        !strings(member, ['realName', 'nickname'], true) ||
        !inEnum(member.joinStatus, joins) ||
        typeof member.canSchedule !== 'boolean' ||
        member.canSchedule !==
          ['ACTIVE', 'EXIT_APPROVING', 'PENDING_LEAVE'].includes(String(member.joinStatus)) ||
        !record(member.summary) ||
        !integers(member.summary, [
          'presentCount',
          'lateCount',
          'earlyLeaveCount',
          'leaveCount',
          'absentCount',
        ]) ||
        !Array.isArray(member.days) ||
        member.days.length !== monthDayCount(input.month)
      )
        invalidResponse();
      members.add(String(member.memberId).toLowerCase());
      member.days.forEach((day, index) => {
        const parsed = attendanceCalendarDay(day);
        if (
          parsed.scheduleDate !== `${input.month}-${String(index + 1).padStart(2, '0')}` ||
          ![parsed.versionNo, parsed.dailyVersionNo].every(
            (version) => version === null || attendanceVersion(version),
          )
        )
          invalidResponse();
      });
    }
    return value as unknown as OrganizationSchedulesResult;
  }
  function scheduleTimezone(value: unknown) {
    if (!(value == null || (typeof value === 'string' && value.length <= 64)))
      invalidAttendanceInput();
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: (value as string | null | undefined)?.trim() || 'Asia/Shanghai',
      });
    } catch {
      invalidAttendanceInput();
    }
  }
  function organizationShift(value: Record<string, unknown>) {
    const time = (item: unknown): item is string =>
      typeof item === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(item);
    if (
      !inEnum(value.dayType, ['WORK', 'REST']) ||
      (value.dayType === 'REST'
        ? value.startTime != null || value.endTime != null
        : !time(value.startTime) ||
          !time(value.endTime) ||
          `${value.startTime}:00`.slice(0, 8) >= `${value.endTime}:00`.slice(0, 8))
    )
      invalidAttendanceInput();
    scheduleTimezone(value.timezone);
  }
  function organizationScheduleResult(
    value: unknown,
    allowed: Set<string>,
    overwrite: boolean,
    exact = true,
    memberCount = 1,
  ): OrganizationScheduleResult {
    if (
      !record(value) ||
      !strings(value, ['batchNo']) ||
      !String(value.batchNo).trim() ||
      !integers(value, ['createdCount', 'updatedCount', 'skippedCount']) ||
      !Array.isArray(value.conflicts) ||
      value.conflicts.length !== value.skippedCount ||
      (overwrite && value.skippedCount !== 0)
    )
      invalidResponse();
    const count =
      Number(value.createdCount) + Number(value.updatedCount) + Number(value.skippedCount);
    if (
      count > 5000 ||
      (exact
        ? count !== allowed.size
        : count < memberCount || count > allowed.size || count % memberCount !== 0)
    )
      invalidResponse();
    const conflicts = new Set<string>();
    for (const row of value.conflicts) {
      if (
        !record(row) ||
        !uuid(row.memberId) ||
        !attendanceDate(row.scheduleDate) ||
        !integer(row.scheduleId, 1) ||
        !attendanceVersion(row.versionNo)
      )
        invalidResponse();
      const key = `${String(row.memberId).toLowerCase()}/${row.scheduleDate}`;
      if (!allowed.has(key) || conflicts.has(key)) invalidResponse();
      conflicts.add(key);
    }
    return value as unknown as OrganizationScheduleResult;
  }
  function workbenchAttendanceApplication(value: unknown): WorkbenchAttendanceApplicationResult {
    if (
      !record(value) ||
      !uuid(value.applicationId) ||
      !strings(value, ['flowNo', 'appliedAt']) ||
      !strings(value, ['finishedAt', 'leaveStartAt', 'leaveEndAt'], true) ||
      !attendanceVersion(value.flowVersionNo) ||
      !(value.versionNo === null || attendanceVersion(value.versionNo)) ||
      !(value.dailyId === null || integer(value.dailyId, 1)) ||
      (value.versionNo === null) !== (value.dailyId === null) ||
      !attendanceDate(value.attendanceDate) ||
      !inEnum(value.status, flows) ||
      !inEnum(value.applicationType, ['LEAVE', 'CORRECTION']) ||
      value.businessType !== `ATTENDANCE_${value.applicationType}` ||
      !inEnum(value.finalStatus, attendanceManualStatuses) ||
      (value.applicationType === 'LEAVE'
        ? value.finalStatus !== 'LEAVE' ||
          !attendanceTime(value.leaveStartAt) ||
          !attendanceTime(value.leaveEndAt) ||
          !value.leaveStartAt.startsWith(`${value.attendanceDate} `) ||
          !value.leaveEndAt.startsWith(`${value.attendanceDate} `) ||
          value.leaveStartAt >= value.leaveEndAt
        : value.finalStatus === 'LEAVE' || value.leaveStartAt !== null || value.leaveEndAt !== null)
    )
      invalidResponse();
    return value as unknown as WorkbenchAttendanceApplicationResult;
  }
  const avatarMime: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
  };
  function imageUploaded(
    value: unknown,
    file: File,
    extension: string,
    directory: 'avatar' | 'org-logo',
  ): ImageUploadResult {
    if (
      !record(value) ||
      !strings(value, [
        'objectKey',
        'uploadToken',
        'fileName',
        'extension',
        'contentType',
        'fileHash',
      ]) ||
      !strings(value, ['url'], true) ||
      value.sensitive !== false ||
      value.extension !== extension ||
      value.size !== file.size ||
      value.contentType !== avatarMime[extension] ||
      !(value.objectKey as string).startsWith(`${directory}/`) ||
      !/^(avatar|org-logo)\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.(jpg|jpeg|png|gif|bmp|webp)$/.test(
        value.objectKey as string,
      ) ||
      !(value.objectKey as string).endsWith(`.${extension}`) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.uploadToken as string) ||
      !/^[a-f0-9]{64}$/.test(value.fileHash as string)
    )
      invalidResponse();
    return value as unknown as ImageUploadResult;
  }
  async function uploadPublicImage(
    file: File,
    bizType: 'AVATAR' | 'ORG_LOGO',
  ): Promise<ImageUploadResult> {
    const fileName = file.name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
    const extension = fileName.includes('.') ? fileName.split('.').at(-1)!.toLowerCase() : '';
    if (!(AVATAR_EXTENSIONS as readonly string[]).includes(extension) || !file.size)
      throw new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: '请选择 JPG、JPEG、PNG、GIF、BMP 或 WebP 图片',
      });
    if (file.size > AVATAR_MAX_BYTES)
      throw new ApiError(413, {
        code: 'PAYLOAD_TOO_LARGE',
        message: `${bizType === 'AVATAR' ? '头像' : 'Logo'}图片最大 10 MiB`,
      });
    const declaredType = file.type.split(';')[0]?.trim().toLowerCase();
    if (
      declaredType &&
      declaredType !== 'application/octet-stream' &&
      declaredType !== avatarMime[extension]
    )
      throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '图片类型与扩展名不匹配' });
    const body = new FormData();
    body.append('bizType', bizType);
    body.append('category', 'IMAGE');
    body.append('file', file);
    return imageUploaded(
      await request('/files/upload', body, 'POST', true, { timeoutMs: 60_000 }),
      file,
      extension,
      bizType === 'AVATAR' ? 'avatar' : 'org-logo',
    );
  }
  function businessLicenseUploaded(
    value: unknown,
    file: File,
    extension: string,
  ): BusinessLicenseUploadResult {
    if (
      !record(value) ||
      !strings(value, [
        'objectKey',
        'uploadToken',
        'fileName',
        'extension',
        'contentType',
        'fileHash',
      ]) ||
      value.url !== null ||
      value.sensitive !== true ||
      value.extension !== extension ||
      value.size !== file.size ||
      value.contentType !== avatarMime[extension] ||
      !/^business-license\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.(jpg|jpeg|png|gif|bmp|webp)$/.test(
        value.objectKey as string,
      ) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.uploadToken as string) ||
      !/^[a-f0-9]{64}$/.test(value.fileHash as string)
    )
      invalidResponse();
    return value as unknown as BusinessLicenseUploadResult;
  }
  function idempotencyHeaders(key: string): Record<string, string> {
    if (typeof key !== 'string' || !key.trim() || key.length > 128 || /[\r\n]/.test(key))
      throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '请提供有效的操作幂等键' });
    return { 'Idempotency-Key': key };
  }
  async function readImport(response: Response): Promise<unknown> {
    if (response.status === 400) {
      const payload: unknown = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (
        record(payload) &&
        payload.code === 400 &&
        record(payload.data) &&
        Array.isArray(payload.data.rowErrors) &&
        payload.data.rowErrors.length > 0
      )
        throw new OrganizationImportError(
          failure(payload),
          imported(payload.data),
          retryAfter(response),
        );
    }
    return read(response);
  }
  async function readTemplate(response: Response): Promise<{ blob: Blob; fileName: string }> {
    if (!response.ok) await read(response);
    if (
      response.headers.get('Content-Type')?.split(';')[0]?.trim() !==
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
      invalidResponse();
    const blob = await response.blob();
    if (!blob.size) invalidResponse();
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    let fileName = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? 'member-import-template.xlsx';
    if (encoded) {
      try {
        fileName = decodeURIComponent(encoded);
      } catch {
        /* 保留安全的备用文件名。 */
      }
    }
    fileName = fileName.replace(/[\p{Cc}/\\]/gu, '_');
    if (!fileName.toLowerCase().endsWith('.xlsx')) fileName = 'member-import-template.xlsx';
    return { blob, fileName };
  }
  function updateProfile(input: UserProfileUpdateInput): Promise<AuthUser> {
    if (input.newPassword == null)
      return request('/users/me/update', input, 'POST', true).then(user);
    const current = generation;
    return changeSession(async () => {
      await refreshing?.catch(() => undefined);
      if (current !== generation)
        throw new ApiError(401, { code: 'SESSION_CHANGED', message: '登录状态已变化，请重新登录' });
      const data = await request('/users/me/update', input, 'POST', true);
      // 改密已由后端撤销全部会话；使迟到查询/刷新失效，再允许后续登录。
      generation++;
      refreshToken = undefined;
      await refreshing?.catch(() => undefined);
      return user(data);
    });
  }
  async function authenticate(path: string, body: unknown): Promise<VerifyResult> {
    const current = ++generation;
    refreshToken = undefined;
    return changeSession(async () => {
      // 等待既有轮换完成，避免旧刷新响应覆盖新登录的 Cookie。
      await refreshing?.catch(() => undefined);
      if (generation !== current)
        throw new ApiError(409, { code: 'SESSION_CHANGED', message: '登录状态已变化，请重新操作' });
      const data = await request(path, body);
      if (generation !== current) {
        // Cookie 已随响应生效；在下一次登录前撤销被取代的成功登录。
        if (!(record(data) && data.status === 'registration_required')) {
          try {
            await request('/auth/logout');
          } catch (error) {
            throw new ApiError(
              error instanceof ApiError ? error.status : 0,
              {
                code: 'SESSION_CLEANUP_FAILED',
                message: '登录状态已变化，旧会话清理失败，请先退出登录后重试',
              },
              error instanceof ApiError ? error.retryAfter : undefined,
            );
          }
        }
        throw new ApiError(409, { code: 'SESSION_CHANGED', message: '登录状态已变化，请重新操作' });
      }
      if (record(data) && data.status === 'registration_required') {
        if (
          typeof data.registrationToken !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(data.registrationToken) ||
          typeof data.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(data.expiresAt))
        )
          invalidResponse();
        return {
          status: 'registration_required',
          registrationToken: data.registrationToken,
          expiresAt: data.expiresAt,
        } satisfies RegistrationRequired;
      }
      remember(data, current);
      return { status: 'authenticated' };
    });
  }

  return {
    health: async () => {
      const data = await read(await send('/health/ready', undefined, 'GET'), false);
      if (!record(data) || typeof data.status !== 'string') invalidResponse();
      return { status: data.status };
    },
    sendCode: async (input) => {
      const data = await request('/auth/sms/send', input);
      if (typeof data !== 'string') invalidResponse();
      return data;
    },
    login: async (input) => {
      const result = await authenticate('/auth/login', input);
      if (result.status !== 'authenticated') invalidResponse();
    },
    verifyCode: (input) => authenticate('/auth/sms/login', input),
    completeRegistration: async (input) => user(await request('/auth/register', input)),
    getCurrentUser: async () => user(await request('/users/me', undefined, 'GET', true)),
    switchRole: async (role) =>
      switchedRole(await request('/auth/switch-role', { role }, 'POST', true), role),
    updateProfile,
    changePassword: async (newPassword, confirmNewPassword) => {
      await updateProfile({ newPassword, confirmNewPassword });
    },
    createOrganization: async (input) =>
      organization(await request('/organizations', input, 'POST', true)),
    getOrganization: async (orgId) =>
      organization(
        await request(`/organizations?${new URLSearchParams({ orgId })}`, undefined, 'GET', true),
      ),
    updateOrganization: async (input) =>
      organizationUpdated(await request('/organizations/update', input, 'POST', true)),
    listOrganizationMembers: async (input) =>
      page(await request('/organizations/members', input, 'POST', true), member),
    listOrganizationSchedules: async (input) => {
      organizationSchedulesInput(input);
      return organizationSchedules(
        await request('/organizations/schedules', input, 'POST', true),
        input,
      );
    },
    batchOrganizationSchedules: async (input, key) => {
      if (
        !record(input) ||
        !onlyKeys(input, [
          'orgId',
          'memberIds',
          'startDate',
          'endDate',
          'weekdays',
          'dayType',
          'startTime',
          'endTime',
          'timezone',
          'overwrite',
        ]) ||
        !uuid(input.orgId) ||
        typeof input.overwrite !== 'boolean' ||
        !Array.isArray(input.memberIds) ||
        input.memberIds.length < 1 ||
        input.memberIds.length > 500 ||
        !input.memberIds.every(uuid) ||
        !attendanceDate(input.startDate) ||
        !attendanceDate(input.endDate) ||
        input.startDate > input.endDate ||
        Date.parse(input.endDate) - Date.parse(input.startDate) > 365 * 86400000 ||
        !(
          input.weekdays == null ||
          (Array.isArray(input.weekdays) &&
            input.weekdays.length <= 7 &&
            input.weekdays.every((day) => integer(day, 1) && day <= 7))
        )
      )
        invalidAttendanceInput();
      organizationShift(input);
      const members = new Set(input.memberIds.map((memberId) => memberId.toLowerCase()));
      const weekdays = input.weekdays?.length ? input.weekdays : [1, 2, 3, 4, 5];
      const allowed = new Set<string>();
      for (
        let time = Date.parse(input.startDate);
        time <= Date.parse(input.endDate);
        time += 86400000
      ) {
        const date = new Date(time);
        if (weekdays.includes(date.getUTCDay() || 7))
          for (const memberId of members)
            allowed.add(`${memberId}/${date.toISOString().slice(0, 10)}`);
      }
      if (!allowed.size) invalidAttendanceInput();
      return organizationScheduleResult(
        await request('/organizations/schedules/batch', input, 'PUT', true, {
          headers: idempotencyHeaders(key),
        }),
        allowed,
        input.overwrite,
        false,
        members.size,
      );
    },
    batchOrganizationScheduleDetails: async (input, key) => {
      if (
        !record(input) ||
        !onlyKeys(input, ['orgId', 'schedules', 'timezone', 'overwrite']) ||
        !uuid(input.orgId) ||
        typeof input.overwrite !== 'boolean' ||
        !Array.isArray(input.schedules) ||
        input.schedules.length < 1 ||
        input.schedules.length > 5000
      )
        invalidAttendanceInput();
      scheduleTimezone(input.timezone);
      const members = new Set<string>(),
        allowed = new Set<string>();
      for (const day of input.schedules) {
        if (
          !record(day) ||
          !onlyKeys(day, [
            'memberId',
            'scheduleDate',
            'dayType',
            'startTime',
            'endTime',
            'timezone',
          ]) ||
          !uuid(day.memberId) ||
          !attendanceDate(day.scheduleDate)
        )
          invalidAttendanceInput();
        organizationShift(day);
        const memberId = day.memberId.toLowerCase(),
          target = `${memberId}/${day.scheduleDate}`;
        if (allowed.has(target)) invalidAttendanceInput();
        members.add(memberId);
        allowed.add(target);
      }
      if (members.size > 500) invalidAttendanceInput();
      return organizationScheduleResult(
        await request('/organizations/schedules/details/batch', input, 'PUT', true, {
          headers: idempotencyHeaders(key),
        }),
        allowed,
        input.overwrite,
      );
    },
    updateOrganizationMember: async (input) =>
      memberUpdated(await request('/organizations/members/update', input, 'POST', true)),
    changeOrganizationMemberRole: async (input) =>
      roleUpdated(await request('/organizations/members/position', input, 'POST', true)),
    requestOrganizationDeparture: async (input, key) =>
      departure(
        await request('/organizations/members/exit-requests', input, 'POST', true, {
          headers: idempotencyHeaders(key),
        }),
      ),
    listPendingOrganizationApprovals: async (input) =>
      page(await request('/organizations/approvals/pending', input, 'POST', true), pendingApproval),
    listOrganizationApprovalRecords: async (input) =>
      page(await request('/organizations/approvals/records', input, 'POST', true), approvalRecord),
    processOrganizationApproval: async (input) =>
      approvalProcessed(await request('/organizations/approvals/process', input, 'POST', true)),
    downloadOrganizationMemberTemplate: async (language = 'zh') =>
      (await request('/organizations/member-imports/template', undefined, 'GET', true, {
        headers: { 'Accept-Language': language },
        decode: readTemplate,
      })) as { blob: Blob; fileName: string },
    importOrganizationMembers: async (input, key) => {
      const headers = idempotencyHeaders(key);
      const body = new FormData();
      body.append('orgId', input.orgId);
      if (input.memberText !== undefined) body.append('memberText', input.memberText);
      if (input.file) body.append('csvFile', input.file);
      return imported(
        await request('/organizations/member-imports/generate', body, 'POST', true, {
          headers,
          decode: readImport,
          timeoutMs: 120_000,
        }),
      );
    },
    listNavigatorProjects: async () => {
      const data = await request('/projects/list', undefined, 'GET', true);
      if (!Array.isArray(data)) invalidResponse();
      return data.map(navigatorProject);
    },
    getCurrentProjectDraft: async () =>
      currentProjectDraft(await request('/projects/draft/current', undefined, 'GET', true)),
    getProjectCategories: async (input = {}) => {
      if (
        (input.categoryLevel !== undefined && ![1, 2, 3].includes(input.categoryLevel)) ||
        (input.keyword !== undefined && typeof input.keyword !== 'string')
      )
        throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '请提供有效的项目分类条件' });
      const query = new URLSearchParams({
        ...(input.categoryLevel !== undefined
          ? { categoryLevel: String(input.categoryLevel) }
          : {}),
        ...(input.keyword !== undefined ? { keyword: input.keyword } : {}),
      });
      const data = await request(
        `/project-categories${query.size ? `?${query}` : ''}`,
        undefined,
        'GET',
        true,
      );
      if (!Array.isArray(data)) invalidResponse();
      return data.map(projectCategory);
    },
    getCurrentProjectRequester: async (userId) => {
      if (!uuid(userId))
        throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '请提供有效的本人用户 ID' });
      const data = await request(
        `/project-requesters/INDIVIDUAL/${encodeURIComponent(userId)}/backfill`,
        undefined,
        'GET',
        true,
      );
      if (
        !record(data) ||
        data.requesterType !== 'INDIVIDUAL' ||
        data.requesterId !== userId ||
        typeof data.requesterName !== 'string' ||
        data.orgId !== null ||
        data.orgVerifyStatus !== null
      )
        invalidResponse();
      return data as unknown as ProjectRequester;
    },
    saveProject: async (input) => {
      if (
        !inEnum(input.operation, ['SAVE_DRAFT', 'CREATE_PROJECT']) ||
        (input.versionNo != null && !attendanceVersion(input.versionNo)) ||
        (input.requesterType != null && input.requesterType !== 'INDIVIDUAL') ||
        (input.requesterId != null && !uuid(input.requesterId))
      )
        throw new ApiError(400, {
          code: 'VALIDATION_ERROR',
          message: '项目操作、需求方或草稿版本不合法',
        });
      // 接口不提供幂等键：仅沿用明确401后的会话刷新，不重放网络/5xx/409失败。
      return projectMutation(
        await request('/projects/create', input, 'POST', true),
        input.operation,
      );
    },
    getProjectDetail: async (projectId) => {
      if (!integer(projectId, 1) || projectId > 2147483647)
        throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '请提供有效的项目 ID' });
      const data = workbenchProjectDetail(
        await request(`/projects/${projectId}`, undefined, 'GET', true),
      );
      if (data.id !== projectId) invalidResponse();
      return data;
    },
    listProjectManagerCandidates: async (input) => {
      if (
        !record(input) ||
        !onlyKeys(input, ['projectId', 'keyword']) ||
        !integer(input.projectId, 1) ||
        input.projectId > 2147483647 ||
        (input.keyword !== undefined &&
          (typeof input.keyword !== 'string' || input.keyword.length > 100))
      )
        throw new ApiError(400, {
          code: 'VALIDATION_ERROR',
          message: '请提供有效的项目 ID 和不超过 100 字符的姓名或昵称',
        });
      const query = new URLSearchParams({ projectId: String(input.projectId) });
      if (input.keyword?.trim()) query.set('keyword', input.keyword.trim());
      const data = await request(`/projects/manager-candidates?${query}`, undefined, 'GET', true);
      if (!Array.isArray(data)) invalidResponse();
      return data.map(projectManagerCandidate);
    },
    recruitProjectManager: async (input) => {
      if (
        !record(input) ||
        !onlyKeys(input, ['projectId', 'candidateUserId']) ||
        !integer(input.projectId, 1) ||
        input.projectId > 2147483647 ||
        !uuid(input.candidateUserId)
      )
        throw new ApiError(400, {
          code: 'VALIDATION_ERROR',
          message: '请提供有效的项目 ID 和策略官用户 ID',
        });
      // 无幂等键：仅明确401时沿既有会话刷新重试，不重放网络/5xx/409失败。
      return projectManagerRecruitment(
        await request('/projects/manager-recruitments', input, 'POST', true),
        input,
      );
    },
    uploadProjectAttachment: async (file) => {
      const name = file.name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
      const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
      if (!(PROJECT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension) || !file.size)
        throw new ApiError(400, {
          code: 'VALIDATION_ERROR',
          message: '请选择支持类型的非空项目附件',
        });
      if (file.size > PROJECT_ATTACHMENT_MAX_BYTES)
        throw new ApiError(413, { code: 'PAYLOAD_TOO_LARGE', message: '项目附件最大 50 MiB' });
      const body = new FormData();
      body.append('bizType', 'PROJECT_ATTACHMENT');
      body.append('category', 'PROJECT_ATTACHMENT');
      body.append('file', file);
      return projectUploaded(
        await request('/files/upload', body, 'POST', true, { timeoutMs: 60_000 }),
        file,
        extension,
      );
    },
    readProjectAttachment: async (objectKey) => {
      if (
        typeof objectKey !== 'string' ||
        objectKey.length > 512 ||
        !objectKey.startsWith('project-attachment/') ||
        /[\\\p{Cc}]/u.test(objectKey) ||
        objectKey.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      )
        throw new ApiError(400, {
          code: 'VALIDATION_ERROR',
          message: '请提供有效的项目附件对象 Key',
        });
      return (await request(
        `/files/view?${new URLSearchParams({ objectKey })}`,
        undefined,
        'GET',
        true,
        {
          decode: async (response) => {
            if (!response.ok) await read(response);
            const type = response.headers.get('Content-Type')?.split(';')[0]?.trim();
            if (
              !inEnum(type, [
                'application/octet-stream',
                'application/pdf',
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/bmp',
                'image/webp',
              ])
            )
              invalidResponse();
            const blob = await response.blob();
            if (!blob.size) invalidResponse();
            return blob;
          },
          timeoutMs: 60_000,
        },
      )) as Blob;
    },
    getMyExpertProjects: async (keyword) => {
      if (keyword !== undefined && keyword.length > 100)
        throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '项目关键字最多 100 字符' });
      const query = keyword === undefined ? '' : `?${new URLSearchParams({ keyword })}`;
      const data = await request(`/expert-assignments/my-projects${query}`, undefined, 'GET', true);
      if (!Array.isArray(data)) invalidResponse();
      return data.map(workbenchProject);
    },
    getExpertAssignmentDetail: async (assignmentId) => {
      if (!integer(assignmentId, 1) || assignmentId > 2147483647)
        throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '请提供有效的分配 ID' });
      return workbenchAssignment(
        await request(
          `/expert-assignments/detail?${new URLSearchParams({ assignmentId: String(assignmentId) })}`,
          undefined,
          'GET',
          true,
        ),
        assignmentId,
      );
    },
    listMyApplications: async (input) =>
      page(await request('/users/me/applications', input, 'POST', true), workbenchApplication),
    getMyAttendance: async (input) =>
      workbenchAttendance(
        await request(`/organizations/attendance?${monthQuery(input)}`, undefined, 'GET', true),
        input,
      ),
    getAttendanceHolidays: async (input) =>
      workbenchHolidays(
        await request(
          `/organizations/calendar/holidays?${monthQuery(input)}`,
          undefined,
          'GET',
          true,
        ),
        input.month,
      ),
    batchMySchedules: async (input) => {
      if (
        !record(input) ||
        !onlyKeys(input, ['schedules', 'overwrite', 'timezone', 'idempotencyKey']) ||
        typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey.trim() ||
        input.idempotencyKey.length > 128 ||
        typeof input.overwrite !== 'boolean' ||
        !(
          input.timezone == null ||
          (typeof input.timezone === 'string' && input.timezone.length <= 64)
        ) ||
        !Array.isArray(input.schedules) ||
        !input.schedules.length ||
        input.schedules.length > 366
      )
        invalidAttendanceInput();
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone?.trim() || 'Asia/Shanghai' });
      } catch {
        invalidAttendanceInput();
      }
      const dates = new Set<string>();
      const shiftTime = (value: unknown): value is string =>
        typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value);
      for (const day of input.schedules) {
        if (
          !record(day) ||
          !onlyKeys(day, ['scheduleDate', 'dayType', 'startTime', 'endTime']) ||
          !attendanceDate(day.scheduleDate) ||
          dates.has(day.scheduleDate) ||
          !inEnum(day.dayType, ['WORK', 'REST']) ||
          (day.dayType === 'REST'
            ? day.startTime != null || day.endTime != null
            : !shiftTime(day.startTime) ||
              !shiftTime(day.endTime) ||
              `${day.startTime}:00`.slice(0, 8) >= `${day.endTime}:00`.slice(0, 8))
        )
          invalidAttendanceInput();
        dates.add(day.scheduleDate);
      }
      const { idempotencyKey, ...body } = input;
      const data = await request('/users/me/schedules/batch', body, 'PUT', true, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      if (
        !record(data) ||
        !strings(data, ['batchNo']) ||
        !integers(data, ['createdCount', 'updatedCount', 'skippedCount']) ||
        !Array.isArray(data.conflicts) ||
        data.skippedCount !== data.conflicts.length ||
        Number(data.createdCount) + Number(data.updatedCount) + Number(data.skippedCount) !==
          dates.size ||
        (input.overwrite && data.skippedCount !== 0)
      )
        invalidResponse();
      const conflicts = new Set<string>();
      for (const conflict of data.conflicts) {
        if (
          !record(conflict) ||
          !attendanceDate(conflict.scheduleDate) ||
          !dates.has(conflict.scheduleDate) ||
          conflicts.has(conflict.scheduleDate) ||
          !integer(conflict.scheduleId, 1) ||
          !attendanceVersion(conflict.versionNo)
        )
          invalidResponse();
        conflicts.add(conflict.scheduleDate);
      }
      return data as unknown as WorkbenchScheduleResult;
    },
    applyMyAttendance: async (input) => {
      if (
        !record(input) ||
        !onlyKeys(input, [
          'orgId',
          'attendanceDate',
          'applicationType',
          'finalStatus',
          'reason',
          'versionNo',
          'dailyId',
          'leaveStartAt',
          'leaveEndAt',
        ]) ||
        !uuid(input.orgId) ||
        !attendanceDate(input.attendanceDate) ||
        !inEnum(input.applicationType, ['LEAVE', 'CORRECTION']) ||
        !inEnum(input.finalStatus, attendanceManualStatuses) ||
        typeof input.reason !== 'string' ||
        !input.reason.trim() ||
        input.reason.trim().length > 1000 ||
        !(input.versionNo === null || attendanceVersion(input.versionNo)) ||
        !(input.dailyId == null || integer(input.dailyId, 1)) ||
        (input.applicationType === 'LEAVE'
          ? input.finalStatus !== 'LEAVE' ||
            !attendanceTime(input.leaveStartAt) ||
            !attendanceTime(input.leaveEndAt) ||
            !input.leaveStartAt.startsWith(`${input.attendanceDate} `) ||
            !input.leaveEndAt.startsWith(`${input.attendanceDate} `) ||
            input.leaveStartAt >= input.leaveEndAt
          : input.finalStatus === 'LEAVE' || input.leaveStartAt != null || input.leaveEndAt != null)
      )
        invalidAttendanceInput();
      const data = workbenchAttendanceApplication(
        await request('/organizations/attendance/apply', input, 'POST', true),
      );
      if (
        data.status !== 'PENDING' ||
        data.finishedAt !== null ||
        data.attendanceDate !== input.attendanceDate ||
        data.applicationType !== input.applicationType ||
        data.finalStatus !== input.finalStatus ||
        data.versionNo !== input.versionNo ||
        (input.dailyId != null && data.dailyId !== input.dailyId) ||
        data.leaveStartAt !== (input.leaveStartAt ?? null) ||
        data.leaveEndAt !== (input.leaveEndAt ?? null)
      )
        invalidResponse();
      return data;
    },
    withdrawMyAttendance: async (input) => {
      if (
        !record(input) ||
        !onlyKeys(input, ['applicationId', 'flowVersionNo']) ||
        !uuid(input.applicationId) ||
        !attendanceVersion(input.flowVersionNo)
      )
        invalidAttendanceInput();
      const data = workbenchAttendanceApplication(
        await request('/organizations/attendance/withdraw', input, 'POST', true),
      );
      if (
        data.applicationId !== input.applicationId ||
        data.status !== 'WITHDRAWN' ||
        data.finishedAt === null ||
        data.flowVersionNo !== input.flowVersionNo + 1
      )
        invalidResponse();
      return data;
    },
    updateMyAttendance: async (input) => {
      if (
        !record(input) ||
        !onlyKeys(input, ['orgId', 'dailyId', 'finalStatus', 'manualRemark', 'versionNo']) ||
        !uuid(input.orgId) ||
        !integer(input.dailyId, 1) ||
        !attendanceVersion(input.versionNo) ||
        !inEnum(input.finalStatus, attendanceManualStatuses) ||
        !(
          input.manualRemark == null ||
          (typeof input.manualRemark === 'string' && input.manualRemark.length <= 1000)
        )
      )
        invalidAttendanceInput();
      const data = await request('/organizations/attendance/update', input, 'POST', true);
      if (
        !record(data) ||
        data.id !== input.dailyId ||
        data.versionNo !== input.versionNo + 1 ||
        data.finalStatus !== input.finalStatus ||
        !inEnum(data.beforeStatus, attendanceStatuses, true) ||
        data.manualOverride !== true ||
        data.manualRemark !== (input.manualRemark?.trim() || null) ||
        !strings(data, ['correctedBy', 'correctedAt']) ||
        !integer(data.adjustmentId, 1)
      )
        invalidResponse();
      return data as unknown as WorkbenchAttendanceUpdateResult;
    },
    uploadAvatar: (file) => uploadPublicImage(file, 'AVATAR'),
    uploadOrganizationLogo: (file) => uploadPublicImage(file, 'ORG_LOGO'),
    uploadBusinessLicense: async (file) => {
      const fileName = file.name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
      const extension = fileName.includes('.') ? fileName.split('.').at(-1)!.toLowerCase() : '';
      if (!(AVATAR_EXTENSIONS as readonly string[]).includes(extension) || !file.size)
        throw new ApiError(400, {
          code: 'VALIDATION_ERROR',
          message: '请选择 JPG、JPEG、PNG、GIF、BMP 或 WebP 图片',
        });
      if (file.size > AVATAR_MAX_BYTES)
        throw new ApiError(413, { code: 'PAYLOAD_TOO_LARGE', message: '营业执照图片最大 10 MiB' });
      const declaredType = file.type.split(';')[0]?.trim().toLowerCase();
      if (
        declaredType &&
        declaredType !== 'application/octet-stream' &&
        declaredType !== avatarMime[extension]
      )
        throw new ApiError(400, { code: 'VALIDATION_ERROR', message: '图片类型与扩展名不匹配' });
      const body = new FormData();
      body.append('bizType', 'BUSINESS_LICENSE');
      body.append('category', 'IMAGE');
      body.append('file', file);
      return businessLicenseUploaded(
        await request('/files/upload', body, 'POST', true, { timeoutMs: 60_000 }),
        file,
        extension,
      );
    },
    logout: async () => {
      generation++;
      refreshToken = undefined;
      await changeSession(async () => {
        await refreshing?.catch(() => undefined);
        await request('/auth/logout');
      });
    },
  };
}

export const webAuth = createHttpAuth();
