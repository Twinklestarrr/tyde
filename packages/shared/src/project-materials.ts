import type { ProjectAttachmentInput } from './projects.js';
import type { WorkbenchProjectDetail } from './workbench.js';

/** 现有标准材料接口响应；下载仍须通过鉴权文件代理。 */
export interface ProjectStandardMaterials {
  projectId: number;
  standardContent: string | null;
  standardLink: string | null;
  attachments: WorkbenchProjectDetail['attachments'];
  currentNodeCode: string | null;
  stateTransitioned: boolean;
  canConfirmRead: boolean;
  /** 上海墙钟时间 yyyy-MM-dd HH:mm:ss。 */
  confirmedReadAt: string | null;
  readConfirmationTransitioned: boolean;
  versionNo: number;
}

export interface ProjectStandardMaterialsInput {
  projectId: number;
  /** 省略/null清空；正文与链接去除首尾空白后至少填写一项。 */
  standardContent?: string | null;
  standardLink?: string | null;
  /** 省略/null保留，[]清空，非空数组整体替换；最多20个。 */
  attachments?: ProjectAttachmentInput[] | null;
}

export interface ProjectStandardMaterialsApi {
  getProjectStandardMaterials(projectId: number): Promise<ProjectStandardMaterials>;
  /** 无客户端版本字段或幂等键；网络未知结果应先显式读取核实。 */
  updateProjectStandardMaterials(
    input: ProjectStandardMaterialsInput,
  ): Promise<ProjectStandardMaterials>;
}
