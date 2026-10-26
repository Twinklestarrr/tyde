import { ownerChangeBody } from './expert-owner.schema.js';
export const respondBody = {
  type: 'object',
  additionalProperties: false,
  description:
    '个人、组织主管或成员响应任务。assignmentId与movementId必须二选一；转项仅被调人本人在MEMBER_CONFIRM阶段可响应，拒绝终止并恢复来源成员；不允许指定负责人。组织首次接单指定1—20名负责人。',
  required: ['decision'],
  properties: {
    assignmentId: {
      ...ownerChangeBody.properties.assignmentId,
      nullable: true,
      description:
        '分配记录ID，32位正整数；与movementId二选一。兼容匹配本人、目标项目及同组织的唯一MEMBER_CONFIRM转项，同事务推进，多个匹配409；不匹配沿普通接单。',
    },
    movementId: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      nullable: true,
      description:
        '转项变动单ID；与assignmentId二选一。仅本人在当前接单阶段可响应，重复或已结束返回409。',
    },
    decision: {
      type: 'string',
      enum: ['ACCEPT', 'REJECT'],
      description:
        '必填决定：ACCEPT接单，REJECT拒绝。个人/组织主体重复处理409；普通成员相同决定幂等成功，相反决定或SELECTED状态409。',
    },
    projectOwnerUserId: {
      ...ownerChangeBody.properties.projectOwnerUserId,
      description:
        '组织首次接单的兼容单负责人ID；个人和组织成员响应禁止提供。与非空集合二选一，其他情形省略/null。',
    },
    projectOwnerUserIds: {
      ...ownerChangeBody.properties.projectOwnerUserIds,
      description:
        '组织首次接单的平级负责人集合，去重后1至20名有效成员；与单值二选一。个人/组织成员禁止提供非空集合，空数组/null表示未提供。',
    },
    rejectReason: {
      type: 'string',
      nullable: true,
      maxLength: 500,
      description:
        '拒绝时必填非空白原因，最多500字符，存储时去除首尾空白；接单时忽略，可省略/null。',
    },
  },
  examples: [
    { assignmentId: 1, decision: 'ACCEPT' },
    {
      assignmentId: 2,
      decision: 'ACCEPT',
      projectOwnerUserIds: ['00000000-0000-4000-8000-000000000001'],
    },
    { assignmentId: 3, decision: 'REJECT', rejectReason: '当前暂无可投入人员' },
  ],
};
export const respondExample = {
  assignmentId: 1,
  movementId: null,
  status: 'ACCEPTED',
  memberStatus: null,
  nextAction: 'WAIT_ENTRY_CONFIRMATION',
  notifiedMemberCount: 0,
};
export const respondResponse = {
  type: 'object',
  additionalProperties: false,
  description:
    '处理后的状态及建议动作。实际后续入口仍独立校验；不创建考试应试或调用真实Agent，不推进项目节点/版本。通知人数仅为可见范围人数，不表示已实际投递。',
  required: Object.keys(respondExample),
  properties: {
    assignmentId: {
      type: 'integer',
      nullable: true,
      description:
        '本次处理的分配记录ID，32位正整数；显式movementId响应为null，旧assignmentId兼容响应保留本ID。',
    },
    movementId: {
      type: 'integer',
      nullable: true,
      description: '关联转项单ID；招募分配响应为null。',
    },
    status: {
      type: 'string',
      enum: ['ACCEPTED', 'REJECTED'],
      description: '分配主体状态：ACCEPTED已接单，REJECTED已拒绝；成员拒绝仍保留主体ACCEPTED。',
    },
    memberStatus: {
      type: 'string',
      nullable: true,
      enum: ['ACCEPTED', 'REJECTED', null],
      description: '成员状态：ACCEPTED接单、REJECTED拒绝；个人或组织首次响应null。',
    },
    nextAction: {
      type: 'string',
      enum: [
        'NONE',
        'VIEW_RESULT',
        'MANAGE_PROJECT_MEMBERS',
        'TAKE_ENTRANCE_EXAM',
        'WAIT_ENTRY_CONFIRMATION',
      ],
      description:
        'NONE无动作、VIEW_RESULT查看结果、MANAGE_PROJECT_MEMBERS管理成员、TAKE_ENTRANCE_EXAM参加准入考试、WAIT_ENTRY_CONFIRMATION等待入项确认。后续写能力由08/10接入。',
    },
    notifiedMemberCount: {
      type: 'integer',
      minimum: 0,
      description:
        '组织首次接单后获得卡片的正常账号未离组成员数，单位人；个人、成员响应或拒绝为0。仅持久化PENDING事件，实际投递归14。',
    },
  },
  examples: [respondExample],
};
