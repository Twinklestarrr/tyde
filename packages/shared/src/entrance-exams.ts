import type { ProjectAttachmentUploadResult, ProjectJsonValue } from './projects.js';

/** 当前考试管理 HTTP 契约；账号/文件 ID 为 UUID，项目/考试/应试 ID 为 32 位整数。 */
export interface EntranceExamLocator {
  projectId: number;
  examId: number;
}
export interface EntranceExamFileInput {
  objectKey: string;
  uploadedFileId?: string | null;
  uploadToken?: string | null;
  fileName?: string;
  extension?: string;
  contentType?: string;
  size?: number;
  fileHash?: string | null;
  url?: string | null;
  sensitive?: boolean;
}
export interface EntranceExamQuestionInput {
  questionContent?: string | null;
  questionFiles?: EntranceExamFileInput[] | null;
  requiredFlag?: boolean | null;
  score?: number | null;
  scoreSource?: 'AUTO' | 'MANUAL' | null;
  referenceAnswer?: string | null;
  referenceFiles?: EntranceExamFileInput[] | null;
}
export interface EntranceExamPaperInput {
  paperName?: string | null;
  questions: EntranceExamQuestionInput[];
}
export interface EntranceExamRoundInput {
  gradingMode: 'AUTO' | 'MANUAL';
  toolCode?: string | null;
  toolName?: string | null;
  toolConfig?: ProjectJsonValue;
  toolFiles?: EntranceExamFileInput[] | null;
  reviewerUserIds?: string[] | null;
}
export interface EntranceExamConfigInput {
  projectId: number;
  examName?: string | null;
  durationMinutes?: number | null;
  registrationDeadline?: string | null;
  fullScore?: number | null;
  passScore?: number | null;
  decisionRule?: 'MAJORITY' | 'MANUAL_PRIORITY' | null;
  tieBreakRule?: 'STRICT' | 'LENIENT' | null;
  papers: EntranceExamPaperInput[];
  gradingRounds: EntranceExamRoundInput[];
}
export interface EntranceExamEditInput extends EntranceExamConfigInput {
  examId: number;
  expectedCurrentVersionId: number;
}
export interface EntranceExamReviewer {
  userId: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
}
export interface EntranceExamMutation extends EntranceExamLocator {
  examNo: string;
  examName: string;
  status: 'ACTIVE';
  currentVersionId: number;
  versionNo: number;
  publishedAt: string;
}
/** 快照按后端原值保留；调用方须安全识别数组，不能把未知历史数据静默替换成空值。 */
export interface EntranceExamFileSnapshot {
  uploadedFileId: string;
  objectKey: string;
  fileName: string;
  extension: string;
  contentType: string;
  fileSize: number;
  fileHash: string | null;
  [key: string]: unknown;
}
export interface EntranceExamQuestion {
  questionId: number;
  sequenceNo: number;
  questionContent: string | null;
  questionFiles: unknown;
  requiredFlag: boolean;
  score: number;
  scoreSource: 'AUTO' | 'MANUAL';
  referenceAnswer: string | null;
  referenceFiles: unknown;
}
export interface EntranceExamRound {
  gradingRoundId: number;
  roundNo: number;
  gradingMode: 'AUTO' | 'MANUAL';
  toolCode: string | null;
  toolName: string | null;
  toolConfig: unknown;
  toolFiles: unknown;
  reviewers: unknown;
}
export interface EntranceExamConfiguration extends EntranceExamLocator {
  examNo: string;
  status: 'ACTIVE';
  currentVersionId: number;
  versionNo: number;
  examName: string;
  durationMinutes: number | null;
  registrationDeadline: string;
  fullScore: number;
  passScore: number;
  decisionRule: 'MAJORITY' | 'MANUAL_PRIORITY';
  tieBreakRule: 'STRICT' | 'LENIENT' | null;
  papers: {
    paperId: number;
    sequenceNo: number;
    paperName: string | null;
    totalScore: number;
    questions: EntranceExamQuestion[];
  }[];
  gradingRounds: EntranceExamRound[];
}
export interface EntranceExamCard {
  examId: number;
  examNo: string;
  examName: string;
  status: 'ACTIVE' | 'CLOSED';
  examineeCount: number;
  admittedCount: number;
  admissionRate: number;
  currentVersionId: number | null;
  createdAt: string;
  closedAt: string | null;
}
export interface EntranceExamManagement {
  projectId: number;
  needWrittenExam: boolean;
  activeExamCount: number;
  maxActiveExamCount: number;
  canCreateExam: boolean;
  createDisabledReason: string | null;
  exams: EntranceExamCard[];
}
export interface EntranceExamCloseResult {
  examId: number;
  status: 'CLOSED';
  closedBy: string;
  closedAt: string;
}
export interface EntranceExamPage<T> {
  current: number;
  size: number;
  total: number;
  pages: number;
  records: T[];
}
export type EntranceExamFinalResult = 'PENDING' | 'ADMITTED' | 'ELIMINATED';
export interface EntranceExamRosterInput extends EntranceExamLocator {
  keyword?: string | null;
  finalResult?: EntranceExamFinalResult | null;
  current?: number | null;
  size?: number | null;
}
export interface EntranceExamRosterItem {
  attemptId: number;
  attemptNo: string;
  candidateUserId: string;
  candidateUid: string;
  candidateName: string;
  organizationId: string | null;
  organizationName: string | null;
  finalResult: EntranceExamFinalResult | null;
  roundScores: {
    roundNo: number;
    gradingMode: 'AUTO' | 'MANUAL';
    score: number | null;
    roundResult: 'ADMITTED' | 'ELIMINATED' | null;
  }[];
  enteredAt: string | null;
  submittedAt: string | null;
}
export type EntranceExamRosterPage = EntranceExamPage<EntranceExamRosterItem>;
export type EntranceExamAdmissionStatus =
  'PENDING' | 'PENDING_ENTRY' | 'ADMITTED' | 'ENTRY_DECLINED' | 'ELIMINATED';
export interface EntranceExamAdmissionInput {
  projectId: number;
  keyword?: string;
  admissionStatus?: EntranceExamAdmissionStatus;
  current?: number;
  size?: number;
}
export interface EntranceExamAdmissionItem {
  attemptId: number;
  examId: number;
  examName: string;
  candidateUserId: string;
  candidateUid: string;
  candidateName: string;
  organizationId: string | null;
  organizationName: string | null;
  employmentType: 'FULL_TIME' | 'PART_TIME' | null;
  examDate: string;
  admissionStatus: EntranceExamAdmissionStatus;
}
export type EntranceExamAdmissionPage = EntranceExamPage<EntranceExamAdmissionItem>;
export type EntranceExamGradingStatus = 'NOT_STARTED' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
export interface EntranceExamRoundSummary {
  gradingRoundId: number;
  gradingRecordId: number | null;
  roundNo: number;
  gradingMode: 'AUTO' | 'MANUAL';
  status: 'WAITING' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | null;
  score: number | null;
  roundResult: 'ADMITTED' | 'ELIMINATED' | null;
  conclusionSummary: string | null;
  errorMessage: string | null;
}
export interface EntranceExamGradingDetail {
  examId: number;
  attemptId: number;
  candidateUid: string;
  candidateName: string;
  passScore: number;
  gradingStatus: EntranceExamGradingStatus;
  finalResult: EntranceExamFinalResult;
  rounds: EntranceExamRoundSummary[];
  selectedRound: EntranceExamRoundSummary;
  questions: {
    questionId: number;
    sequenceNo: number;
    questionContent: string | null;
    questionFiles: unknown;
    score: number;
    referenceAnswer: string | null;
    referenceFiles: unknown;
    answerId: number | null;
    answerContent: string | null;
    answerFiles: unknown;
    answeredFlag: boolean;
    correctness: 'PENDING' | 'CORRECT' | 'INCORRECT' | null;
    gradingOpinion: string | null;
  }[];
}
export interface EntranceExamGradingItemInput {
  questionId: number;
  correctness: 'CORRECT' | 'INCORRECT';
  gradingOpinion?: string | null;
}
export interface EntranceExamManualGradingInput extends EntranceExamLocator {
  attemptId: number;
  gradingRecordId: number;
  conclusionSummary?: string | null;
  items: EntranceExamGradingItemInput[];
}
export interface EntranceExamAutoRetryInput extends EntranceExamLocator {
  gradingRecordId: number;
}
export interface EntranceExamAutoCompensateInput extends EntranceExamAutoRetryInput {
  summary?: string | null;
  compensationReason?: string | null;
  items: EntranceExamGradingItemInput[];
}
export interface EntranceExamGradingSubmitResult {
  attemptId: number;
  gradingRecordId: number;
  recordStatus: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  score: number | null;
  roundResult: 'ADMITTED' | 'ELIMINATED' | null;
  gradingStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
  finalResult: EntranceExamFinalResult;
}
export type EntranceExamTemplateType = 'EXCEL' | 'TXT' | 'REDOC';
export interface EntranceExamImportInput {
  projectId: number;
  file?: File;
  redocUrl?: string;
  attachmentRefs?: { name: string; objectKey: string; uploadToken: string }[];
}
export interface EntranceExamImportResult {
  formatVersion: '1';
  sourceType: 'EXCEL' | 'TXT';
  config: EntranceExamConfigInput;
}
export const ENTRANCE_EXAM_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const ENTRANCE_EXAM_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export interface EntranceExamApi {
  getEntranceExamManagement(projectId: number): Promise<EntranceExamManagement>;
  listEntranceExamReviewers(projectId: number, keyword?: string): Promise<EntranceExamReviewer[]>;
  getEntranceExamConfiguration(input: EntranceExamLocator): Promise<EntranceExamConfiguration>;
  publishEntranceExam(input: EntranceExamConfigInput): Promise<EntranceExamMutation>;
  editEntranceExam(input: EntranceExamEditInput): Promise<EntranceExamMutation>;
  closeEntranceExam(
    input: EntranceExamLocator & { closeReason?: string | null },
  ): Promise<EntranceExamCloseResult>;
  getEntranceExamRoster(input: EntranceExamRosterInput): Promise<EntranceExamRosterPage>;
  getEntranceExamAdmissions(input: EntranceExamAdmissionInput): Promise<EntranceExamAdmissionPage>;
  getEntranceExamGradingDetail(
    input: EntranceExamLocator & { attemptId: number; roundNo?: number | null },
  ): Promise<EntranceExamGradingDetail>;
  submitEntranceExamManualGrading(
    input: EntranceExamManualGradingInput,
  ): Promise<EntranceExamGradingSubmitResult>;
  retryEntranceExamAutoGrading(
    input: EntranceExamAutoRetryInput,
  ): Promise<EntranceExamGradingSubmitResult>;
  compensateEntranceExamAutoGrading(
    input: EntranceExamAutoCompensateInput,
  ): Promise<EntranceExamGradingSubmitResult>;
  downloadEntranceExamTemplate(
    type: EntranceExamTemplateType,
  ): Promise<{ fileName: string; blob: Blob }>;
  parseEntranceExamImport(input: EntranceExamImportInput): Promise<EntranceExamImportResult>;
  uploadEntranceExamAttachment(file: File): Promise<ProjectAttachmentUploadResult>;
  readEntranceExamAttachment(objectKey: string): Promise<Blob>;
}
