import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors.js';
import { parseProjectTime } from '../projects/project-time.js';
import type {
  ExamConfigInput,
  ExamFileInput,
  ExamPaperInput,
  ExamQuestionInput,
} from './exam-config.types.js';
import { type ImportAsset, type ImportCell } from './exam-import-images.js';
import { examQuestionRows } from './exam-import-template.js';

export const EXAM_SOURCE_LIMIT = 10 * 1024 * 1024;

export const EXAM_TEXT_LIMIT = 1_000_000;

export const questionHeaders = examQuestionRows[0]!;

export interface ImportBinding {
  target: ExamFileInput[];
  asset: ImportAsset;
  location: string;
}

export interface ParsedExam {
  config: ExamConfigInput;
  bindings: ImportBinding[];
}

export const importBad = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);

export const cell = (text = '', assets: ImportAsset[] = []): ImportCell => ({ text, assets });

export const blank = (c: ImportCell) => !c.text.trim() && !c.assets.length;

const optional = (value?: string) => value?.trim() || null;

export function importScore(text: string | undefined, label: string): number | null {
  if (!text?.trim()) return null;
  try {
    const number = new Prisma.Decimal(text.trim());
    if (
      !number.isFinite() ||
      number.lte(0) ||
      number.gt('99999999.99') ||
      number.decimalPlaces() > 2
    )
      throw Error();
    return number.toNumber();
  } catch {
    throw importBad(`${label}必须为最多两位小数的正数，且不超过99999999.99`);
  }
}

function positive(text: string, label: string) {
  if (!/^[+]?\d+$/.test(text) || Number(text) < 1 || Number(text) > 2147483647)
    throw importBad(`${label}必须为32位正整数`);
  return Number(text);
}

const richText = (value: string) =>
  optional(value)
    ?.replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', '<br/>') ?? null;

export function buildExamImport(values: Map<string, string>, rows: ImportCell[][]): ParsedExam {
  if (rows[0]?.map((c) => c.text.trim()).join('\0') !== questionHeaders.join('\0'))
    throw importBad('题目表头不符合导入格式');
  const examName = optional(values.get('examName')!);
  if ((examName?.length ?? 0) > 128) throw importBad('考试名称超过128字符');
  const deadline = optional(values.get('registrationDeadline')!);
  if (deadline) parseProjectTime(deadline);
  const duration = optional(values.get('durationMinutes')!);
  const config: ExamConfigInput = {
    projectId: 0,
    examName,
    durationMinutes: duration ? positive(duration, '答题时限') : null,
    registrationDeadline: deadline,
    fullScore: importScore(values.get('fullScore'), '试卷满分'),
    passScore: importScore(values.get('passScore'), '及格分数'),
    decisionRule: null,
    tieBreakRule: null,
    papers: [],
    gradingRounds: [],
  };
  const papers = new Map<string, ExamPaperInput>(),
    numbers = new Set<string>();
  const bindings: ImportBinding[] = [];
  let textLength = 0;
  const bind = (target: ExamFileInput[], asset: ImportAsset, location: string) => {
    if (bindings.length >= 100 || bindings.filter((b) => b.target === target).length >= 20)
      throw importBad('每道题每类附件最多20个，一次解析最多100个附件');
    bindings.push({ target, asset, location });
  };
  for (const row of rows.slice(1)) {
    if (row.every(blank)) continue;
    if (row.length > 8) throw importBad('题目存在多余列');
    const cells = Array.from({ length: 8 }, (_, index) => row[index] ?? cell());
    textLength += cells.reduce((sum, c) => sum + c.text.length, 0);
    if (textLength > EXAM_TEXT_LIMIT) throw importBad('题目总文本超过限制');
    const name = optional(cells[0]!.text) ?? '试卷1',
      number = positive(cells[1]!.text.trim(), '题号');
    if (name.length > 100) throw importBad('试卷名称超过100字符');
    const key = `${name}\0${number}`;
    if (numbers.has(key)) throw importBad('同一试卷的题号重复');
    numbers.add(key);
    const paper = papers.get(name) ?? { paperName: name, questions: [] };
    papers.set(name, paper);
    if (papers.size > 20 || paper.questions.length >= 200)
      throw importBad('最多20张试卷，每张最多200道题');
    if ([0, 1, 4, 5].some((i) => cells[i]!.assets.length))
      throw importBad('附件只能放在题干、答案或对应附件列');
    const required = cells[5]!.text.trim().toLowerCase();
    if (
      ![
        '',
        '是',
        '必答',
        '必填',
        'true',
        '1',
        '否',
        '选答',
        '选填',
        '非必答',
        '非必填',
        'false',
        '0',
      ].includes(required)
    )
      throw importBad('必答列取值无效');
    const score = importScore(cells[4]!.text, '题目分值');
    const question: ExamQuestionInput = {
      questionContent: richText(cells[2]!.text),
      questionFiles: [],
      referenceAnswer: richText(cells[3]!.text),
      referenceFiles: [],
      score,
      scoreSource: score == null ? 'AUTO' : 'MANUAL',
      requiredFlag: !['否', '选答', '选填', '非必答', '非必填', 'false', '0'].includes(required),
    };
    const location = `${name}第${number}题`;
    for (const [index, target] of [
      [2, question.questionFiles!],
      [3, question.referenceFiles!],
      [6, question.questionFiles!],
      [7, question.referenceFiles!],
    ] as const) {
      for (const asset of cells[index]!.assets) bind(target, asset, location);
      if (index >= 6)
        for (const name of cells[index]!.text.split('|')
          .map((n) => n.trim())
          .filter(Boolean))
          bind(target, { name }, location);
    }
    if (!question.questionContent && !bindings.some((b) => b.target === question.questionFiles))
      throw importBad(`${location}题干和附件至少填写一项`);
    if (!question.referenceAnswer && !bindings.some((b) => b.target === question.referenceFiles))
      throw importBad(`${location}参考答案和附件至少填写一项`);
    paper.questions.push(question);
  }
  if (!papers.size) throw importBad('至少需要一道题目');
  config.papers = [...papers.values()];
  if (config.papers.every((p) => p.questions.every((q) => q.score != null))) {
    const totals = config.papers.map((p) =>
      p.questions.reduce((sum, q) => sum.add(q.score!), new Prisma.Decimal(0)),
    );
    if (totals.every((t) => t.equals(totals[0]!))) config.fullScore = totals[0]!.toNumber();
  }
  if (config.passScore != null && config.fullScore != null && config.passScore > config.fullScore)
    throw importBad('及格分数不能高于满分');
  return { config, bindings };
}
