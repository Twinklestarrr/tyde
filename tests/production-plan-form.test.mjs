import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyProductionStage,
  productionPlanInput,
  productionPlanToday,
  productionPlanValues,
  productionStageEstimate,
  productionWorkdays,
} from '../apps/web/src/modules/projects/production-plan-form.ts';

/** 确认用例只测试纯表单模型，不连接 API 或数据库。 */
function values() {
  return {
    operatorHeadcount: '4',
    operatorCpd: '10.25',
    inspectorHeadcount: '',
    inspectorCpd: '',
    needWrittenExam: false,
    maxActiveExamCount: '2',
    needInterview: true,
    crowds: [{ crowdName: ' 熟练组 ', profileRequirement: ' 完成培训 ' }],
    stages: [
      {
        ...emptyProductionStage('爬坡期'),
        startDate: '2099-01-05',
        endDate: '2099-01-09',
        operatorHeadcount: '2',
        accuracyRate: '98.5',
      },
      {
        ...emptyProductionStage('稳定生产期'),
        startDate: '2099-01-05',
        endDate: '2099-01-09',
        workdayCountSource: 'MANUAL',
        workdayCount: '7',
        operatorHeadcount: '3',
        operatorCpd: '20.5',
      },
    ],
  };
}

test('Shanghai confirmation date changes at UTC 16:00 independently of browser timezone', () => {
  assert.equal(productionPlanToday(new Date('2026-10-26T15:59:59Z')), '2026-10-26');
  assert.equal(productionPlanToday(new Date('2026-10-26T16:00:00Z')), '2026-10-27');
});

test('AUTO counts inclusive Monday–Friday without subtracting public holidays', () => {
  assert.deepEqual(productionWorkdays('2099-01-05', '2099-01-09'), { naturalDays: 5, workdays: 5 });
  assert.deepEqual(productionWorkdays('2026-10-01', '2026-10-02'), { naturalDays: 2, workdays: 2 });
  assert.deepEqual(productionWorkdays('2099-01-10', '2099-01-11'), { naturalDays: 2, workdays: 0 });
  assert.equal(productionWorkdays('2099-02-30', '2099-03-01'), null);
  assert.equal(productionWorkdays('0000-01-01', '0000-01-02'), null);
});

test('confirmation snapshot keeps inherited CPD null and permits overlapping stages/manual days above natural days', () => {
  const { input, errors } = productionPlanInput(values(), '2026-10-27');
  assert.deepEqual(errors, {});
  assert.deepEqual(input.crowds, [{ crowdName: '熟练组', profileRequirement: '完成培训' }]);
  assert.equal(input.stages[0].operatorCpd, null);
  assert.equal(input.stages[0].accuracyRate, 98.5);
  assert.equal(input.stages[0].workdayCountSource, 'AUTO');
  assert.equal(Object.hasOwn(input.stages[0], 'workdayCount'), false);
  assert.equal(input.stages[1].workdayCount, 7);
  assert.equal(input.needWrittenExam, false);
  assert.equal(input.maxActiveExamCount, 2);
  assert.equal(input.needInterview, true);
  assert.equal(input.inspectorHeadcount, null);
  assert.equal(input.inspectorCpd, null);
  assert.equal(productionStageEstimate(values().stages[0], '10.25').expectedOutput, 102.5);
  assert.equal(productionStageEstimate(values().stages[1], '10.25').expectedOutput, 430.5);
});

test('pairing, 32-bit integers, CPD scale/range and percentage limits cannot reach the API', () => {
  const form = values();
  Object.assign(form, {
    inspectorHeadcount: '2',
    operatorHeadcount: '2147483648',
    operatorCpd: '10.12345',
    maxActiveExamCount: '0',
  });
  form.stages[0].accuracyRate = '100.0001';
  const result = productionPlanInput(form, '2026-10-27');
  assert.equal(result.input, null);
  for (const key of [
    'inspectorHeadcount',
    'inspectorCpd',
    'operatorHeadcount',
    'operatorCpd',
    'maxActiveExamCount',
    'stages.0.accuracyRate',
  ])
    assert.ok(result.errors[key]);
  for (const cpd of ['0', '-1', '1e16', '0.00001']) {
    form.operatorCpd = cpd;
    assert.ok(productionPlanInput(form, '2026-10-27').errors.operatorCpd);
  }
});

test('confirmation revalidates Shanghai today and rejects invalid ranges or an AUTO-only weekend', () => {
  const form = values();
  form.stages[0].startDate = '2026-10-27';
  form.stages[0].endDate = '2026-10-28';
  assert.equal(productionPlanInput(form, '2026-10-27').errors['stages.0.startDate'], undefined);
  assert.ok(productionPlanInput(form, '2026-10-28').errors['stages.0.startDate']);
  form.stages[0].startDate = '2099-01-10';
  form.stages[0].endDate = '2099-01-11';
  assert.ok(productionPlanInput(form, '2026-10-27').errors['stages.0.workdayCount']);
  form.stages[0].endDate = '2099-01-09';
  assert.ok(productionPlanInput(form, '2026-10-27').errors['stages.0.endDate']);
});

test('crowds/stages remain 1–50 with required text and explicitly supplied stage headcount', () => {
  const form = values();
  form.crowds[0].profileRequirement = ' ';
  form.stages[0].operatorHeadcount = '';
  form.stages[1].stageName = 'a'.repeat(101);
  const errors = productionPlanInput(form, '2026-10-27').errors;
  assert.ok(errors['crowds.0.profileRequirement']);
  assert.ok(errors['stages.0.operatorHeadcount']);
  assert.ok(errors['stages.1.stageName']);
  form.crowds = [];
  assert.ok(productionPlanInput(form, '2026-10-27').errors.crowds);
  form.crowds = Array.from({ length: 51 }, () => ({
    crowdName: '人群',
    profileRequirement: '要求',
  }));
  form.stages = [];
  assert.ok(productionPlanInput(form, '2026-10-27').errors.crowds);
  assert.ok(productionPlanInput(form, '2026-10-27').errors.stages);
});

test('decimal input does not silently round before its JSON number is submitted', () => {
  const form = values();
  form.operatorCpd = '9007199254740991.1234';
  assert.match(productionPlanInput(form, '2026-10-27').errors.operatorCpd, /无法精确提交/);
  form.operatorCpd = '1.234500';
  assert.equal(productionPlanInput(form, '2026-10-27').input.operatorCpd, 1.2345);
  form.operatorCpd = '1.2345e2';
  assert.equal(productionPlanInput(form, '2026-10-27').input.operatorCpd, 123.45);
});

test('DECIMAL output overflow is checked for each stage and for their sum', () => {
  const form = values();
  form.operatorCpd = '5000000000000000';
  for (const stage of form.stages)
    Object.assign(stage, {
      workdayCountSource: 'MANUAL',
      workdayCount: '100000',
      operatorHeadcount: '100000',
      operatorCpd: '',
    });
  const total = productionPlanInput(form, '2026-10-27');
  assert.ok(total.errors.stages);
  assert.equal(total.errors['stages.0.operatorCpd'], undefined);
  form.stages[0].operatorHeadcount = '1000000';
  assert.ok(productionPlanInput(form, '2026-10-27').errors['stages.0.operatorCpd']);
});

test('initial values use server defaults and keep confirmed production results separate from estimates', () => {
  const plan = {
    hasPlan: true,
    operatorHeadcount: 4,
    operatorCpd: 10.25,
    inspectorHeadcount: null,
    inspectorCpd: null,
    needWrittenExam: false,
    maxActiveExamCount: 2,
    needInterview: true,
    projectReference: { requiredHeadcount: 99 },
    crowds: [{ crowdName: '现有组', profileRequirement: '现有要求' }],
    stages: [
      {
        stageName: '既有阶段',
        startDate: '2020-01-01',
        endDate: '2020-01-02',
        workdayCountSource: 'AUTO',
        workdayCount: 2,
        operatorHeadcount: 4,
        operatorCpd: 10.25,
        accuracyRate: null,
        expectedOutput: 900,
      },
    ],
  };
  const form = productionPlanValues(plan);
  assert.equal(form.operatorHeadcount, '4');
  assert.equal(form.stages[0].startDate, '2020-01-01');
  assert.equal(form.stages[0].operatorCpd, '10.25');
  assert.equal(plan.stages[0].expectedOutput, 900);
});
