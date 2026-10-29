import type {
  EntranceExamConfigInput,
  EntranceExamConfiguration,
  EntranceExamFileInput,
  ProjectJsonValue,
} from '@tyde/shared';

export interface ExamDraftFile {
  key: string;
  name: string;
  size: number;
  reference?: EntranceExamFileInput;
  file?: File;
  status: 'uploading' | 'ready' | 'failed';
  error?: string;
}
export interface ExamDraftQuestion {
  key: string;
  questionContent: string;
  questionFiles: ExamDraftFile[];
  requiredFlag: boolean;
  scoreSource: 'AUTO' | 'MANUAL';
  score: string;
  referenceAnswer: string;
  referenceFiles: ExamDraftFile[];
}
export interface ExamDraftPaper {
  key: string;
  paperName: string;
  questions: ExamDraftQuestion[];
}
export interface ExamDraftRound {
  key: string;
  gradingMode: 'MANUAL' | 'AUTO';
  reviewerUserIds: string[];
  toolCode: string;
  toolName: string;
  toolConfigText: string;
  toolFiles: ExamDraftFile[];
}
export interface EntranceExamFormValues {
  examName: string;
  durationMode: 'LIMITED' | 'UNLIMITED';
  durationMinutes: string;
  registrationDeadline: string;
  fullScore: string;
  passScore: string;
  decisionRule: 'MAJORITY' | 'MANUAL_PRIORITY';
  tieBreakRule: 'STRICT' | 'LENIENT';
  papers: ExamDraftPaper[];
  gradingRounds: ExamDraftRound[];
}
export type EntranceExamFormErrors = Record<string, string>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const examDraftKey = () => crypto.randomUUID();
export function newExamQuestion(): ExamDraftQuestion {
  return {
    key: examDraftKey(),
    questionContent: '',
    questionFiles: [],
    requiredFlag: true,
    scoreSource: 'AUTO',
    score: '',
    referenceAnswer: '',
    referenceFiles: [],
  };
}
export function newExamPaper(): ExamDraftPaper {
  return { key: examDraftKey(), paperName: '', questions: [newExamQuestion()] };
}
export function newExamRound(): ExamDraftRound {
  return {
    key: examDraftKey(),
    gradingMode: 'MANUAL',
    reviewerUserIds: [],
    toolCode: '',
    toolName: '',
    toolConfigText: '',
    toolFiles: [],
  };
}
export function newEntranceExam(projectName: string): EntranceExamFormValues {
  return {
    examName: `${projectName.trim() || '项目'}准入考试`.slice(0, 128),
    durationMode: 'LIMITED',
    durationMinutes: '',
    registrationDeadline: '',
    fullScore: '100',
    passScore: '60',
    decisionRule: 'MAJORITY',
    tieBreakRule: 'STRICT',
    papers: [newExamPaper()],
    gradingRounds: [newExamRound()],
  };
}

/** 与后端正分/两位小数边界一致，先按十进制分比较，避免浮点加总误差。 */
export function examScoreCents(text: string): number | null {
  const normalized = text.trim().replace(/^\+/, '').replace(/^\./, '0.');
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(normalized);
  if (!match) return null;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  let digits = `${match[1]}${match[2] ?? ''}`.replace(/^0+/, '') || '0';
  let scale = (match[2]?.length ?? 0) - exponent;
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1) || '0';
    scale--;
  }
  if (scale > 2 || digits.length > 110) return null;
  const cents = BigInt(digits) * 10n ** BigInt(2 - scale);
  return cents > 0n && cents <= 9999999999n ? Number(cents) : null;
}
/** AUTO 始终按整卷题数向下均分，最后一题承接尾差，混合手动题也不另行均摊。 */
export function examPaperScores(paper: ExamDraftPaper, fullScore: string) {
  const full = examScoreCents(fullScore);
  if (full === null || !paper.questions.length) return paper.questions.map(() => null);
  const base = Math.floor(full / paper.questions.length);
  return paper.questions.map((question, index) =>
    question.scoreSource === 'MANUAL'
      ? examScoreCents(question.score)
      : index === paper.questions.length - 1
        ? full - base * (paper.questions.length - 1)
        : base,
  );
}
export function examShanghaiTime(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}
function deadline(value: string) {
  const wall = value.replace('T', ' ');
  const completed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(wall) ? `${wall}:00` : wall;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(completed)) return null;
  const date = new Date(completed.replace(' ', 'T') + '+08:00');
  return Number.isFinite(date.getTime()) && examShanghaiTime(date) === completed ? completed : null;
}
function forbiddenConfig(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some((entry) => forbiddenConfig(entry, depth + 1));
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.entries(value).some(
      ([key, item]) =>
        ['secret', 'password', 'apikey', 'accesstoken', 'token'].includes(
          key.replaceAll('_', '').replaceAll('-', '').toLowerCase(),
        ) || forbiddenConfig(item, depth + 1),
    )
  );
}
/** 完整快照校验，名称包含已关闭考试；编辑时只豁免自己当前的原名称。 */
export function entranceExamInput(
  projectId: number,
  values: EntranceExamFormValues,
  options: { now?: Date; existingExamNames?: readonly string[]; originalExamName?: string } = {},
): { input: EntranceExamConfigInput | null; errors: EntranceExamFormErrors } {
  const errors: EntranceExamFormErrors = {};
  const name = values.examName.trim();
  if (!name || name.length > 128) errors.examName = '考试名称必填，最多128字';
  if (
    name !== options.originalExamName &&
    options.existingExamNames?.some((item) => item.trim() === name)
  )
    errors.examName = '项目内已有同名考试，请修改名称';
  const duration = values.durationMode === 'UNLIMITED' ? null : Number(values.durationMinutes);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 2147483647))
    errors.durationMinutes = '时限须为1–2147483647的整数分钟';
  const end = deadline(values.registrationDeadline);
  if (!end || end <= examShanghaiTime(options.now))
    errors.registrationDeadline = '请填写晚于当前时间的有效上海截止时间';
  const full = examScoreCents(values.fullScore),
    pass = examScoreCents(values.passScore);
  if (full === null) errors.fullScore = '满分须大于0、不超过99999999.99，最多两位小数';
  if (pass === null || (full !== null && pass > full))
    errors.passScore = '准入分数须大于0、不超过满分，最多两位小数';
  if (values.papers.length < 1 || values.papers.length > 20) errors.papers = '试卷须为1–20张';
  const usedKeys = new Set<string>();
  const files = (items: ExamDraftFile[], path: string, limit: number) => {
    if (items.length > limit) errors[path] = `附件最多${limit}个`;
    return items.flatMap((item) => {
      const ref = item.reference;
      if (
        item.status !== 'ready' ||
        !ref ||
        !ref.objectKey ||
        Boolean(ref.uploadedFileId) === Boolean(ref.uploadToken)
      ) {
        errors[path] = '请等待附件上传完成，或重试、移除失败的附件';
        return [];
      }
      if (usedKeys.has(ref.objectKey)) errors[path] = '同一考试版本不能重复引用同一附件';
      usedKeys.add(ref.objectKey);
      return [ref];
    });
  };
  const papers = values.papers.map((paper, p) => {
    const prefix = `papers.${p}`;
    if (paper.paperName.trim().length > 100) errors[`${prefix}.paperName`] = '试卷名称最多100字';
    if (!paper.questions.length || paper.questions.length > 200)
      errors[`${prefix}.questions`] = '每张试卷须为1–200题';
    const scores = examPaperScores(paper, values.fullScore);
    if (scores.some((score) => score === null || score < 1))
      errors[`${prefix}.questions`] = '题目分值须大于0，满分不足时请调整题数';
    if (full !== null && scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) !== full)
      errors[`${prefix}.questions`] = '本卷各题分值合计必须等于试卷满分';
    return {
      paperName: paper.paperName.trim() || null,
      questions: paper.questions.map((question, q) => {
        const path = `${prefix}.questions.${q}`;
        if (!question.questionContent.trim() && !question.questionFiles.length)
          errors[`${path}.questionContent`] = '题干文字或题干附件至少填写一项';
        if (question.scoreSource === 'MANUAL' && examScoreCents(question.score) === null)
          errors[`${path}.score`] = '题目分值须大于0且最多两位小数';
        return {
          questionContent: question.questionContent.trim() || null,
          questionFiles: files(question.questionFiles, `${path}.questionFiles`, 20),
          requiredFlag: question.requiredFlag,
          scoreSource: question.scoreSource,
          ...(question.scoreSource === 'MANUAL' ? { score: Number(question.score) } : {}),
          referenceAnswer: question.referenceAnswer.trim() || null,
          referenceFiles: files(question.referenceFiles, `${path}.referenceFiles`, 20),
        };
      }),
    };
  });
  if (!values.gradingRounds.length || values.gradingRounds.length > 20)
    errors.gradingRounds = '判卷轮次须为1–20轮';
  const gradingRounds = values.gradingRounds.map((round, index) => {
    const path = `gradingRounds.${index}`;
    if (round.gradingMode === 'MANUAL') {
      if (
        !round.reviewerUserIds.length ||
        round.reviewerUserIds.length > 100 ||
        new Set(round.reviewerUserIds).size !== round.reviewerUserIds.length ||
        round.reviewerUserIds.some((id) => !uuid.test(id))
      )
        errors[`${path}.reviewerUserIds`] = '请选择1–100名有效且不重复的阅卷人';
      return { gradingMode: 'MANUAL' as const, reviewerUserIds: round.reviewerUserIds };
    }
    if (!round.toolCode.trim() || round.toolCode.trim().length > 64)
      errors[`${path}.toolCode`] = '工具编码必填，最多64字';
    if (!round.toolName.trim() || round.toolName.trim().length > 128)
      errors[`${path}.toolName`] = '工具名称必填，最多128字';
    let config: ProjectJsonValue = null;
    try {
      config = round.toolConfigText.trim() ? JSON.parse(round.toolConfigText) : null;
      if (forbiddenConfig(config))
        errors[`${path}.toolConfigText`] = '工具配置不能包含密钥、非有限数或超过64层的嵌套';
    } catch {
      errors[`${path}.toolConfigText`] = '请填写有效JSON，或留空';
    }
    return {
      gradingMode: 'AUTO' as const,
      toolCode: round.toolCode.trim(),
      toolName: round.toolName.trim(),
      toolConfig: config,
      toolFiles: files(round.toolFiles, `${path}.toolFiles`, 10),
    };
  });
  if (
    values.decisionRule === 'MANUAL_PRIORITY' &&
    !values.gradingRounds.some((round) => round.gradingMode === 'MANUAL')
  )
    errors.decisionRule = '人工优先至少需要一轮人工阅卷';
  return {
    input: Object.keys(errors).length
      ? null
      : {
          projectId,
          examName: name,
          durationMinutes: duration,
          registrationDeadline: end,
          fullScore: Number(values.fullScore),
          passScore: Number(values.passScore),
          decisionRule: values.decisionRule,
          tieBreakRule:
            values.decisionRule === 'MAJORITY' && values.gradingRounds.length % 2 === 0
              ? values.tieBreakRule
              : null,
          papers,
          gradingRounds,
        },
    errors,
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** 历史快照异常时停止编辑，不能以空数组覆盖并丢失附件/阅卷人。 */
export function examSnapshotFiles(value: unknown): ExamDraftFile[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('考试附件快照格式异常，请重新读取或联系维护者');
  return value.map((item) => {
    if (
      !object(item) ||
      typeof item.objectKey !== 'string' ||
      typeof item.fileName !== 'string' ||
      typeof item.uploadedFileId !== 'string' ||
      !uuid.test(item.uploadedFileId)
    )
      throw new Error('考试附件快照缺少有效文件引用，不能安全编辑');
    return {
      key: examDraftKey(),
      name: item.fileName,
      size: typeof item.fileSize === 'number' ? item.fileSize : 0,
      status: 'ready',
      reference: { objectKey: item.objectKey, uploadedFileId: item.uploadedFileId },
    };
  });
}
function importedFiles(files?: EntranceExamFileInput[] | null): ExamDraftFile[] {
  return (files ?? []).map((file) => ({
    key: examDraftKey(),
    name: file.fileName || '导入附件',
    size: file.size ?? 0,
    reference: {
      objectKey: file.objectKey,
      ...(file.uploadToken
        ? { uploadToken: file.uploadToken }
        : { uploadedFileId: file.uploadedFileId }),
    },
    status: 'ready',
  }));
}
/** 解析仅替换当前内存配置，未包含的人工轮次必须由用户补齐，不伪造发布。 */
export function entranceExamImportedValues(
  config: EntranceExamConfigInput,
): EntranceExamFormValues {
  return {
    examName: config.examName ?? '',
    durationMode: config.durationMinutes == null ? 'UNLIMITED' : 'LIMITED',
    durationMinutes: config.durationMinutes == null ? '' : String(config.durationMinutes),
    registrationDeadline: config.registrationDeadline?.replace(' ', 'T') ?? '',
    fullScore: config.fullScore == null ? '' : String(config.fullScore),
    passScore: config.passScore == null ? '' : String(config.passScore),
    decisionRule: config.decisionRule ?? 'MAJORITY',
    tieBreakRule: config.tieBreakRule ?? 'STRICT',
    papers: config.papers.map((paper) => ({
      key: examDraftKey(),
      paperName: paper.paperName ?? '',
      questions: paper.questions.map((question) => ({
        key: examDraftKey(),
        questionContent: question.questionContent ?? '',
        questionFiles: importedFiles(question.questionFiles),
        requiredFlag: question.requiredFlag ?? true,
        score: question.score == null ? '' : String(question.score),
        scoreSource: question.scoreSource ?? (question.score == null ? 'AUTO' : 'MANUAL'),
        referenceAnswer: question.referenceAnswer ?? '',
        referenceFiles: importedFiles(question.referenceFiles),
      })),
    })),
    gradingRounds: config.gradingRounds.map((round) => ({
      key: examDraftKey(),
      gradingMode: round.gradingMode,
      reviewerUserIds: round.reviewerUserIds ?? [],
      toolCode: round.toolCode ?? '',
      toolName: round.toolName ?? '',
      toolConfigText: round.toolConfig == null ? '' : JSON.stringify(round.toolConfig, null, 2),
      toolFiles: importedFiles(round.toolFiles),
    })),
  };
}
export function entranceExamConfigurationValues(
  config: EntranceExamConfiguration,
): EntranceExamFormValues {
  return {
    ...entranceExamImportedValues({ ...config, papers: [], gradingRounds: [] }),
    papers: config.papers.map((paper) => ({
      key: examDraftKey(),
      paperName: paper.paperName ?? '',
      questions: paper.questions.map((question) => ({
        key: examDraftKey(),
        questionContent: question.questionContent ?? '',
        questionFiles: examSnapshotFiles(question.questionFiles),
        requiredFlag: question.requiredFlag,
        score: String(question.score),
        scoreSource: question.scoreSource,
        referenceAnswer: question.referenceAnswer ?? '',
        referenceFiles: examSnapshotFiles(question.referenceFiles),
      })),
    })),
    gradingRounds: config.gradingRounds.map((round) => {
      let ids: string[] = [];
      if (round.gradingMode === 'MANUAL') {
        if (
          !Array.isArray(round.reviewers) ||
          round.reviewers.some(
            (item) => !object(item) || typeof item.userId !== 'string' || !uuid.test(item.userId),
          )
        )
          throw new Error('考试阅卷人快照异常，不能安全编辑');
        ids = round.reviewers.map((item) => (item as { userId: string }).userId);
      }
      return {
        key: examDraftKey(),
        gradingMode: round.gradingMode,
        reviewerUserIds: ids,
        toolCode: round.toolCode ?? '',
        toolName: round.toolName ?? '',
        toolConfigText: round.toolConfig == null ? '' : JSON.stringify(round.toolConfig, null, 2),
        toolFiles: examSnapshotFiles(round.toolFiles),
      };
    }),
  };
}
export function examAllFiles(values: EntranceExamFormValues) {
  return [
    ...values.papers.flatMap((paper) =>
      paper.questions.flatMap((question) => [
        ...question.questionFiles,
        ...question.referenceFiles,
      ]),
    ),
    ...values.gradingRounds.flatMap((round) => round.toolFiles),
  ];
}
