import type { WorkbenchProjectDetail } from './workbench.js';

/** 当前三个级别互相独立，不构造不存在的父子分类关系。 */
export interface ProjectCategory {
  id: number;
  categoryCode: string;
  categoryName: string;
  categoryLevel: 1 | 2 | 3;
  sortNo: number;
}
export interface ProjectRequester {
  requesterType: 'INDIVIDUAL';
  requesterId: string;
  requesterName: string;
  orgId: null;
  orgVerifyStatus: null;
}
/** 服务端本人待办卡片，不是本人创建项目的完整历史。 */
export interface NavigatorProjectCard {
  id: number;
  projectNo: string;
  projectName: string | null;
  projectDescription: string | null;
  categoryLevel1Name: string | null;
  categoryLevel2Name: string | null;
  categoryLevel3Names: string[];
  categoryDisplayName: string;
  status: 'PUBLISHED';
  statusDescription: string;
  currentNodeCode: string;
  branchNodeCode: string | null;
  workbenchStatus: 'PENDING' | 'PROCESSING';
  workbenchStatusDescription: string;
  currentAction: 'RECRUIT_PROJECT_MANAGER' | 'VIEW_DETAIL';
  currentActionDescription: string;
  needAssistGrading: boolean;
  requesterName: string;
  creatorId: string | null;
  creatorName: string;
  projectManagerId: string | null;
  projectManagerName: string | null;
  projectManagerStatusDescription: string;
  projectOwners: { userId: string; name: string; avatarUrl: string | null }[];
  activeExpertCount: number;
  requiredHeadcount: number | null;
  /** 上海墙钟时间 yyyy-MM-dd HH:mm:ss，不按浏览器时区转换。 */
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
}
export type ProjectDraft = Omit<WorkbenchProjectDetail, 'status' | 'creatorName'> & {
  status: 'DRAFT';
  creatorName: null;
};
export interface CurrentProjectDraft {
  hasDraft: boolean;
  draft: ProjectDraft | null;
}
export interface ProjectAttachmentInput {
  id?: number | null;
  attachmentType?: 'STANDARD_REFERENCE' | 'CASE' | 'OTHER' | null;
  objectKey?: string | null;
  /** 一次性认领凭证，仅保留在当前表单内存；已有附件使用 id 保留。 */
  uploadToken?: string | null;
  sortNo?: number | null;
}
/** 完整快照：字段省略/null会清空；attachments省略/null保留，[]移除全部。 */
export interface ProjectSaveInput {
  operation: 'SAVE_DRAFT' | 'CREATE_PROJECT';
  requesterType?: 'INDIVIDUAL' | null;
  requesterId?: string | null;
  projectName?: string | null;
  projectDescription?: string | null;
  categoryLevel1Id?: number | null;
  categoryLevel2Id?: number | null;
  categoryLevel3Ids?: number[] | null;
  difficultyLevel?: WorkbenchProjectDetail['difficultyLevel'];
  projectQuantity?: number | null;
  quantityUnit?: string | null;
  /** 上海墙钟时间 yyyy-MM-dd HH:mm:ss，不含时区后缀。 */
  deadline?: string | null;
  requiredHeadcount?: number | null;
  educationRequirement?: WorkbenchProjectDetail['educationRequirement'];
  employmentType?: WorkbenchProjectDetail['employmentType'];
  experienceRequirement?: string | null;
  workSummary?: string | null;
  specialRequirement?: string | null;
  mandatoryRequirement?: string | null;
  standardContent?: string | null;
  standardLink?: string | null;
  attachments?: ProjectAttachmentInput[] | null;
  /** 已有唯一草稿时必须回传最新版本；过期返回409，不自动覆盖。 */
  versionNo?: number | null;
}
export interface ProjectMutation {
  id: number;
  projectNo: string;
  operation: ProjectSaveInput['operation'];
  status: 'DRAFT' | 'PUBLISHED';
  currentNodeCode: string | null;
  versionNo: number;
  updatedAt: string;
  publishedAt: string | null;
}
export const PROJECT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const PROJECT_ATTACHMENT_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'txt',
  'md',
  'xls',
  'xlsx',
  'csv',
  'json',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'webp',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'zst',
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
] as const;
export const PROJECT_ATTACHMENT_ACCEPT = PROJECT_ATTACHMENT_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(',');
export interface ProjectAttachmentUploadResult {
  fileId: string;
  objectKey: string;
  uploadToken: string;
  url: null;
  sensitive: true;
  fileName: string;
  extension: (typeof PROJECT_ATTACHMENT_EXTENSIONS)[number];
  size: number;
  contentType: string;
  fileHash: string;
}
export interface ProjectApi {
  listNavigatorProjects(): Promise<NavigatorProjectCard[]>;
  getCurrentProjectDraft(): Promise<CurrentProjectDraft>;
  getProjectCategories(input?: {
    categoryLevel?: 1 | 2 | 3;
    keyword?: string;
  }): Promise<ProjectCategory[]>;
  getCurrentProjectRequester(userId: string): Promise<ProjectRequester>;
  saveProject(input: ProjectSaveInput): Promise<ProjectMutation>;
  getProjectDetail(projectId: number): Promise<WorkbenchProjectDetail>;
  uploadProjectAttachment(file: File): Promise<ProjectAttachmentUploadResult>;
  /** 登录鉴权文件代理返回字节，不把敏感 objectKey 当公开 URL。 */
  readProjectAttachment(objectKey: string): Promise<Blob>;
}
