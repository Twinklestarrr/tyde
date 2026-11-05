import {
  ApiError,
  type ProjectStandardMaterials,
  type ProjectStandardMaterialsInput,
} from '@tyde/shared';
import type { ExamDraftFile } from './entrance-exam-form';

export interface StandardTrainingDraft {
  standardContent: string;
  standardLink: string;
  files: ExamDraftFile[];
}

/** 超时、响应不明及会话变化都不能证明无版本/幂等的保存未执行。 */
export function standardTrainingFailureIsUnknown(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    ['SESSION_CHANGED', 'INVALID_RESPONSE'].includes(String(error.code)) ||
    ![400, 401, 403, 404, 409, 413, 422, 429].includes(error.status)
  );
}

export function standardTrainingDraft(materials: ProjectStandardMaterials): StandardTrainingDraft {
  return {
    standardContent: materials.standardContent ?? '',
    standardLink: materials.standardLink ?? '',
    files: materials.attachments.map((file) => ({
      key: `existing-${file.id}`,
      name: file.fileName,
      size: file.fileSize,
      status: 'ready',
      reference: { objectKey: file.objectKey },
    })),
  };
}

/** 保存完整材料快照；保留附件只传ID，新上传凭证只在当前草稿内存中使用。 */
export function standardTrainingInput(
  materials: ProjectStandardMaterials,
  draft: StandardTrainingDraft,
): ProjectStandardMaterialsInput {
  const standardContent = draft.standardContent.trim() || null;
  const standardLink = draft.standardLink.trim() || null;
  if (!standardContent) throw new Error('请填写标准正文。');
  if (draft.standardLink.length > 2000) throw new Error('标准链接最多2000字符。');
  if (draft.files.length > 20) throw new Error('标准附件最多20个。');
  const input: ProjectStandardMaterialsInput = {
    projectId: materials.projectId,
    standardContent,
    standardLink,
    attachments: draft.files.map((file, sortNo) => {
      if (file.status !== 'ready' || !file.reference?.objectKey)
        throw new Error('请先完成所有附件上传，或移除上传失败的附件。');
      const existing = materials.attachments.find((item) => file.key === `existing-${item.id}`);
      if (existing) return { id: existing.id, sortNo };
      if (!file.reference.uploadToken)
        throw new Error(`附件“${file.name}”缺少上传凭证，请重新上传。`);
      return {
        attachmentType: 'STANDARD_REFERENCE',
        objectKey: file.reference.objectKey,
        uploadToken: file.reference.uploadToken,
        sortNo,
      };
    }),
  };
  // 现有材料接口沿用16KiB整请求上限，按实际UTF-8序列化大小阻止超限提交。
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16 * 1024)
    throw new Error('标准材料内容过长，请缩短正文或改用附件、标准链接后再保存。');
  return input;
}

/** 历史链接保留原文；只为明确的HTTP(S)地址提供打开入口。 */
export function standardMaterialLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
