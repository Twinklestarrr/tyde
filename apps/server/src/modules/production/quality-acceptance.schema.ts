import {
  id,
  text,
  choice,
  day,
  quantity,
  stamp,
  object,
  array,
  base,
  page,
  createBody,
} from './production.schema.js';
const bool = (description: string) => ({ type: 'boolean', description });
const amount = createBody.properties.expectedQuantity;
const source = (nullable = false) => ({
  ...choice('MANUAL=人工、WORK_SYSTEM=作业系统；当前未接作业系统采集。', ['MANUAL', 'WORK_SYSTEM']),
  nullable,
});
const exampleKey = { projectId: 1, memberId: 1, reportDate: '2026-10-26' };
export const qualityContextBody = {
  ...object('指定单人单日质量历史；当前PM及招募协作可读，有效组织主管/负责人仅限职责组织。', {
    projectId: base.projectId,
    memberId: id('项目成员ID，非用户ID。'),
    reportDate: day('生产日期，YYYY-MM-DD。'),
  }),
  examples: [exampleKey],
};
export const qualitySaveBody = {
  ...object(
    '单人单日追加人工质量历史，1至100项可重复同一报量；任一非法来源整批回滚。协作只读；已验收或最新质量为作业系统来源时禁止写入。',
    {
      ...qualityContextBody.properties,
      items: {
        ...array(
          '逐项追加质量记录，不覆盖历史。',
          object(
            '单条质量记录。',
            {
              outputReportId: id('日报量ID；须匹配项目、成员和日期。'),
              inspectedQuantity: {
                ...amount,
                description: '必填正抽检数量，数字或十进制字符串，最多26位整数4位小数。',
              },
              qualifiedQuantity: {
                description: '必填非负合格数，不能超过抽检数量；最多26位整数4位小数。',
                anyOf: [
                  { type: 'number', minimum: 0, description: '非负JSON数字。' },
                  {
                    type: 'string',
                    pattern: '^\\d{1,26}(\\.\\d{1,4})?$',
                    description: '精确非负十进制字符串。',
                  },
                ],
              },
              unqualifiedReason: {
                ...text('不合格原因；省略/null/空白保存为null，最多1000字。', true),
                maxLength: 1000,
              },
            },
            ['outputReportId', 'inspectedQuantity', 'qualifiedQuantity'],
          ),
        ),
        minItems: 1,
        maxItems: 100,
      },
    },
  ),
  examples: [
    {
      ...exampleKey,
      items: [
        {
          outputReportId: 1,
          inspectedQuantity: 10,
          qualifiedQuantity: 9,
          unqualifiedReason: '标注偏差',
        },
      ],
    },
  ],
};
export const productionListBody = {
  ...object(
    '人员日生产分页；默认上海当天，首尾在内最多31天。按成员及日期聚合全部核查状态的报量，各报量只计最新质量；职责组织与请求筛选取交集。',
    {
      ...base,
      reportDateStart: day('开始日期YYYY-MM-DD，省略/null默认上海当天。', true),
      reportDateEnd: day('结束日期YYYY-MM-DD，省略/null默认上海当天；不得早于开始。', true),
      accountTypes: {
        ...array(
          '账户类型；省略/null/空数组不筛选。',
          choice('INDIVIDUAL=个人来源、ORGANIZATION=组织来源。', ['INDIVIDUAL', 'ORGANIZATION']),
        ),
        maxItems: 2,
        nullable: true,
      },
      organizationIds: {
        ...array('组织UUID筛选；省略/null/空数组不筛选。', {
          ...text('组织UUID。'),
          format: 'uuid',
        }),
        maxItems: 100,
        nullable: true,
      },
      dataSources: {
        ...array(
          '产量来源筛选；省略/null/空数组不筛选；7日CPD、备注及历史计数不受此过滤。',
          source(),
        ),
        maxItems: 2,
        nullable: true,
      },
    },
    ['projectId'],
  ),
  examples: [
    {
      projectId: 1,
      reportDateStart: '2026-10-01',
      reportDateEnd: '2026-10-26',
      accountTypes: ['INDIVIDUAL'],
      current: 1,
      size: 20,
    },
  ],
};
const productionRow = object('单人单日生产聚合。', {
  memberId: id('项目成员ID。'),
  userId: { ...text('用户UUID。'), format: 'uuid' },
  uid: text('平台UID。'),
  displayName: text('昵称(真实姓名)，缺失回退已有名称或UID。'),
  accountType: choice('INDIVIDUAL=个人、ORGANIZATION=组织来源。', ['INDIVIDUAL', 'ORGANIZATION']),
  organizationId: { ...text('来源组织UUID，个人null。', true), format: 'uuid' },
  organizationName: text('组织名称，个人或已删除组织为null。', true),
  reportDate: day('生产日期YYYY-MM-DD。'),
  quantity: quantity('当日匹配来源报量之和，所有核查状态均计入。'),
  quantityUnit: text('报量单位快照；多值按文本最大值兼容旧接口。'),
  recent7DayCpd: quantity('当日及之前6天全部来源报量总和/7，保留2位小数。'),
  inspectedQuantity: quantity('各报量最新质量抽检数量之和，无质量为0。'),
  qualifiedQuantity: quantity('各报量最新质量合格数量之和，无质量为0。'),
  unqualifiedQuantity: quantity('抽检数量减合格数量。'),
  accuracyRate: quantity('合格率0至100，2位小数；抽检数量0时null。', true),
  dataSources: array('匹配产量来源，去重排序。', source()),
  remarks: text('当日全部报量备注去空去重，按报量ID换行合并；无则null。', true),
  qualityRecordCount: {
    type: 'integer',
    minimum: 0,
    description: '当日全部报量关联的质量历史总条数。',
  },
  hasManualQualityEntry: bool('是否存在人工质量历史。'),
  allowedActions: array(
    '协作只读为空；其他当前管理身份可执行动作。',
    choice('SAVE_QUALITY=质量填报、CREATE_PERFORMANCE=创建表现记录。', [
      'SAVE_QUALITY',
      'CREATE_PERFORMANCE',
    ]),
  ),
});
const productionExample = {
  memberId: 1,
  userId: '11111111-1111-4111-8111-111111111111',
  uid: '123456',
  displayName: '小张(张三)',
  accountType: 'INDIVIDUAL',
  organizationId: null,
  organizationName: null,
  reportDate: '2026-10-26',
  quantity: 10,
  quantityUnit: '条',
  recent7DayCpd: 1.43,
  inspectedQuantity: 10,
  qualifiedQuantity: 9,
  unqualifiedQuantity: 1,
  accuracyRate: 90,
  dataSources: ['MANUAL'],
  remarks: null,
  qualityRecordCount: 1,
  hasManualQualityEntry: true,
  allowedActions: ['SAVE_QUALITY', 'CREATE_PERFORMANCE'],
};
export const productionListResponse = {
  ...page(productionRow),
  examples: [{ current: 1, size: 20, total: 1, pages: 1, records: [productionExample] }],
};
const qualityItem = object('一条报量的一次质量记录；无历史保留一条质量字段为null的明细。', {
  outputReportId: id('日报量ID。'),
  subtaskId: { ...id('子任务ID；项目级null。'), nullable: true },
  subtaskName: text('子任务名称；项目级null。', true),
  quantity: quantity('原报量数量。'),
  quantityUnit: text('原报量单位快照。'),
  reportDataSource: source(),
  qualityId: { ...id('质量历史ID；无质量为null。'), nullable: true },
  inspectedQuantity: quantity('该次抽检数；无质量为null。', true),
  qualifiedQuantity: quantity('该次合格数；无质量为null。', true),
  unqualifiedReason: text('该次不合格原因；无则null。', true),
  operatorName: text('该次记录人昵称(姓名)，缺失回退UID；无质量null。', true),
  operationTime: stamp('该次记录上海时间；无质量null。'),
  qualityDataSource: source(true),
  editable: bool('当前身份可追加质量；协作、已验收或最新质量为WORK_SYSTEM时false。'),
});
export const qualityContextResponse = {
  ...object('单人单日完整质量历史；报量ID升序、质量ID倒序。', {
    memberId: id('成员ID。'),
    displayName: text('成员显示名称。'),
    reportDate: day('生产日期YYYY-MM-DD。'),
    items: array('全部质量历史或空质量占位。', qualityItem),
  }),
  examples: [
    {
      memberId: 1,
      displayName: '小张(张三)',
      reportDate: '2026-10-26',
      items: [
        {
          outputReportId: 1,
          subtaskId: null,
          subtaskName: null,
          quantity: 10,
          quantityUnit: '条',
          reportDataSource: 'MANUAL',
          qualityId: 1,
          inspectedQuantity: 10,
          qualifiedQuantity: 9,
          unqualifiedReason: '标注偏差',
          operatorName: '小王',
          operationTime: '2026-10-26 10:00:00',
          qualityDataSource: 'MANUAL',
          editable: true,
        },
      ],
    },
  ],
};
export const acceptanceContextBody = {
  ...object(
    '仅当前主策略官或招募协作读取，协作canSubmit固定false；不向执行专家或领航员开放此弹窗。',
    { projectId: base.projectId, subtaskId: id('项目内子任务ID。') },
  ),
  examples: [{ projectId: 1, subtaskId: 1 }],
};
export const acceptanceSubmitBody = {
  ...object(
    '仅当前主策略官提交；至少一条核准且没有待核查/退回；锁内重算总量，重复提交409。返修重新提交递增验收轮次；不解锁核准报量。',
    {
      ...acceptanceContextBody.properties,
      actualQuantity: {
        ...amount,
        description: '必填实际正交付量，最多26位整数4位小数；数字或十进制字符串。',
      },
      actualDeliveryDate: day('必填实际交付日期，不得早于上海当天。'),
      quantityAdjustmentRemark: {
        ...text(
          '实际交付量与核准合计不等时非空白必填；相等时强制清空。最多1000字，省略/null表示无。',
          true,
        ),
        maxLength: 1000,
      },
    },
    ['projectId', 'subtaskId', 'actualQuantity', 'actualDeliveryDate'],
  ),
  examples: [
    {
      projectId: 1,
      subtaskId: 1,
      actualQuantity: '10.1234',
      actualDeliveryDate: '2099-12-31',
      quantityAdjustmentRemark: '调整交付量',
    },
  ],
};
export const acceptanceReviewBody = {
  ...object(
    '仅项目创建人以NAVIGATOR角色审核PENDING_ACCEPTANCE；ACCEPT进入终态，REJECT进入返修。重复/竞争后状态不符409。',
    {
      ...acceptanceContextBody.properties,
      decision: choice('ACCEPT=通过、REJECT=驳回。', ['ACCEPT', 'REJECT']),
      rejectReason: {
        ...text('驳回时非空白必填；通过时禁止非空原因。省略/null/空白为无，最多500字。', true),
        maxLength: 500,
      },
    },
    ['projectId', 'subtaskId', 'decision'],
  ),
  examples: [{ projectId: 1, subtaskId: 1, decision: 'REJECT', rejectReason: '需要复核交付物' }],
};
export const acceptanceContextResponse = {
  ...object('实时验收汇总，不暴露内部verifiedCount。', {
    subtaskId: id('子任务ID。'),
    subtaskName: text('子任务名称。'),
    expectedDeliveryDate: day('预期交付日期YYYY-MM-DD。'),
    expectedQuantity: quantity('预期交付量。'),
    quantityUnit: text('子任务单位快照。'),
    reportedQuantity: quantity('当前已核准报量精确合计，响应为JSON数字。'),
    pendingCount: { type: 'integer', minimum: 0, description: '待核查报量数。' },
    returnedCount: { type: 'integer', minimum: 0, description: '退回待修正报量数。' },
    defaultActualQuantity: quantity('默认实际量，等于已核准合计。'),
    defaultActualDeliveryDate: day('默认实际日期，上海当天YYYY-MM-DD。'),
    canSubmit: bool(
      '当前主策略官、项目未结项、任务进行中或返修且至少一条核准、无待核查及退回时true。',
    ),
  }),
  examples: [
    {
      subtaskId: 1,
      subtaskName: '首批生产',
      expectedDeliveryDate: '2099-12-31',
      expectedQuantity: 10,
      quantityUnit: '条',
      reportedQuantity: 10,
      pendingCount: 0,
      returnedCount: 0,
      defaultActualQuantity: 10,
      defaultActualDeliveryDate: '2026-10-26',
      canSubmit: true,
    },
  ],
};
export const nullQualityAcceptance = {
  type: 'null',
  description: '成功data为null；质量追加或验收状态/本域轮次/快照/PENDING事件同事务。',
  examples: [null],
};
