import type {
  ProjectExpertRecruitmentCandidate,
  ProjectExpertRecruitmentSubmitInput,
} from '@tyde/shared';

export interface RecruitmentDraft {
  key: string;
  candidate: ProjectExpertRecruitmentCandidate;
  quantity: string;
  operators: string;
  inspectors: string;
  sourceRejectedAssignmentId: number | null;
  sourceName: string | null;
}
export const recruitmentCandidateKey = (
  candidate: Pick<ProjectExpertRecruitmentCandidate, 'subjectType' | 'subjectId'>,
) => `${candidate.subjectType}:${candidate.subjectId}`;
export function recruitmentCandidateName(candidate: ProjectExpertRecruitmentCandidate) {
  if (candidate.subjectType === 'ORGANIZATION') return candidate.organizationName || '未命名组织';
  return candidate.nickname && candidate.realName
    ? `${candidate.nickname}(${candidate.realName})`
    : candidate.nickname || candidate.realName || '未命名人员';
}
export function newRecruitmentDraft(
  candidate: ProjectExpertRecruitmentCandidate,
): RecruitmentDraft {
  const rejected = candidate.assignment?.status === 'REJECTED';
  const assignment = rejected ? candidate.assignment : null;
  return {
    key: crypto.randomUUID(),
    candidate,
    quantity:
      assignment?.productionRequirement && assignment.productionRequirement > 0
        ? assignment.productionRequirement.toString()
        : '',
    operators:
      assignment?.operatorHeadcount && assignment.operatorHeadcount > 0
        ? assignment.operatorHeadcount.toString()
        : candidate.subjectType === 'INDIVIDUAL'
          ? '1'
          : '',
    inspectors:
      assignment?.inspectorHeadcount && assignment.inspectorHeadcount > 0
        ? assignment.inspectorHeadcount.toString()
        : '',
    sourceRejectedAssignmentId: rejected ? (assignment?.assignmentId ?? null) : null,
    sourceName: rejected ? recruitmentCandidateName(candidate) : null,
  };
}
/** 转为万分单位比较；不会用浮点小数位数判断输入，更不会悄悄舍入。 */
function quantityUnits(value: string): bigint | null {
  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.replace(/^\+/, '').split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  const decimal = fraction.replace(/0+$/, '');
  if (integer.length > 16 || decimal.length > 4) return null;
  return BigInt(integer) * 10000n + BigInt(decimal.padEnd(4, '0'));
}
export function recruitmentInput(
  projectId: number,
  drafts: RecruitmentDraft[],
): ProjectExpertRecruitmentSubmitInput {
  if (!drafts.length || drafts.length > 100) throw new Error('每次下发请选择1至100个对象。');
  const targets = new Set<string>();
  const sources = new Set<number>();
  const count = (value: string, label: string) => {
    if (
      !/^\d+$/.test(value.trim()) ||
      !Number.isInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > 2147483647
    )
      throw new Error(`${label}须为1至2147483647的整数。`);
    return Number(value);
  };
  const input: ProjectExpertRecruitmentSubmitInput = {
    projectId,
    assignments: drafts.map((draft) => {
      const name = recruitmentCandidateName(draft.candidate);
      const key = recruitmentCandidateKey(draft.candidate);
      if (targets.has(key)) throw new Error(`同一批不能重复下发给${name}。`);
      targets.add(key);
      const value = draft.quantity.trim();
      const units = quantityUnits(value);
      if (units === null || units < 1n || units >= 100000000000000000000n)
        throw new Error(`${name}招募量级须至少0.0001、小于10000000000000000，最多4位小数。`);
      const numeric = Number(value);
      if (quantityUnits(String(numeric)) !== units)
        throw new Error(`${name}招募量级无法精确提交，请调整数值以避免精度损失。`);
      if (draft.sourceRejectedAssignmentId !== null) {
        if (
          draft.candidate.assignment?.status !== 'REJECTED' ||
          draft.candidate.assignment.assignmentId !== draft.sourceRejectedAssignmentId
        )
          throw new Error('补招只能使用当前候选自身的拒单来源。');
        if (sources.has(draft.sourceRejectedAssignmentId))
          throw new Error('同一拒单来源不能在一批中重复补招。');
        sources.add(draft.sourceRejectedAssignmentId);
      }
      return {
        subjectType: draft.candidate.subjectType,
        subjectId: draft.candidate.subjectId,
        productionRequirement: numeric,
        operatorHeadcount: count(draft.operators, `${name}作业人数`),
        ...(draft.inspectors.trim()
          ? { inspectorHeadcount: count(draft.inspectors, `${name}质检人数`) }
          : {}),
        ...(draft.sourceRejectedAssignmentId !== null
          ? { sourceRejectedAssignmentId: draft.sourceRejectedAssignmentId }
          : {}),
      };
    }),
  };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16 * 1024)
    throw new Error('本次下发数据超过16 KiB，请减少单次条目后再提交。');
  return input;
}
