import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors.js';

// 旧审批Service是查询/持久化内核，不包含通用条件表达式或多审批人执行器。
export class ApprovalService {
  constructor(readonly db: PrismaClient) {}
  enabledProcess(processCode: string | null) {
    if (!processCode?.trim()) return Promise.resolve(null);
    return this.db.approvalProcess.findFirst({
      where: { processCode: processCode.trim(), status: 'ENABLED', deleted: false },
      orderBy: { version: 'desc' },
    });
  }
  configs(processId: string | null) {
    if (!processId) return Promise.resolve([]);
    return this.db.approvalConfig.findMany({
      where: { processId, deleted: false },
      orderBy: { nodeSeq: 'asc' },
    });
  }
  flow(flowNo: string | null) {
    if (!flowNo?.trim()) return Promise.resolve(null);
    return this.db.approvalFlow.findUnique({ where: { flowNo: flowNo.trim() } });
  }
  activeBusiness(businessType: string | null, businessId: string | null) {
    if (!businessType?.trim() || !businessId?.trim()) return Promise.resolve(null);
    return this.db.approvalFlow.findFirst({
      where: {
        businessType: businessType.trim(),
        businessId: businessId.trim(),
        status: 'PENDING',
      },
    });
  }
  pendingNodes(approverId: string | null) {
    if (!approverId) return Promise.resolve([]);
    return this.db.approvalNode.findMany({
      where: { approverId, nodeStatus: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  nodes(flowId: string | null, nodeSeq: number | null) {
    if (!flowId || nodeSeq == null) return Promise.resolve([]);
    return this.db.approvalNode.findMany({ where: { flowId, nodeSeq }, orderBy: { id: 'asc' } });
  }
  actions(flowId: string | null) {
    if (!flowId) return Promise.resolve([]);
    return this.db.approvalActionLog.findMany({
      where: { flowId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
export const approvalConflict = () => new AppError(409, 'DUPLICATE', '审批已被处理，请刷新后重试');
export async function lockFlow(tx: Prisma.TransactionClient, flowNo: string) {
  await tx.$queryRaw`SELECT "id" FROM "ApprovalFlow" WHERE "flowNo" = ${flowNo} FOR UPDATE`;
  const flow = await tx.approvalFlow.findUnique({ where: { flowNo } });
  if (!flow) throw new AppError(404, 'NOT_FOUND', '审批流程不存在');
  return flow;
}
// 只暴露追加入口；业务不得更新历史动作。顺序以内部自增id保证。
export function appendAction(
  tx: Prisma.TransactionClient,
  data: Prisma.ApprovalActionLogUncheckedCreateInput,
) {
  return tx.approvalActionLog.create({ data });
}
export async function finishPending(
  tx: Prisma.TransactionClient,
  flowId: string,
  versionNo: number,
  status: 'APPROVED' | 'REJECTED',
  uid: string,
  now: Date,
) {
  const result = await tx.approvalFlow.updateMany({
    where: { id: flowId, status: 'PENDING', versionNo },
    data: {
      status,
      currentNode: null,
      currentNodeCode: null,
      finishedAt: now,
      versionNo: { increment: 1 },
      updatedBy: uid,
      updatedAt: now,
    },
  });
  if (result.count !== 1) throw approvalConflict();
}
