import { Prisma } from '@prisma/client';
import { parseProjectTime } from '../projects/project-time.js';
import type { ImportAsset, ImportCell } from './exam-import-images.js';
import {
  buildExamImport,
  cell,
  importBad,
  questionHeaders,
  type ParsedExam,
} from './exam-import.domain.js';
const aliases: Record<string, string> = {
  格式版本: 'formatVersion',
  考试名称: 'examName',
  答题时限: 'durationMinutes',
  考试时长: 'durationMinutes',
  限时: 'durationMinutes',
  截止日期: 'registrationDeadline',
  截止时间: 'registrationDeadline',
  报名截止时间: 'registrationDeadline',
  试卷满分: 'fullScore',
  满分: 'fullScore',
  总分: 'fullScore',
  及格线分数: 'passScore',
  及格线: 'passScore',
  及格分数: 'passScore',
  通过分数: 'passScore',
};
const keys = new Set([
  'formatVersion',
  'examName',
  'durationMinutes',
  'registrationDeadline',
  'fullScore',
  'passScore',
]);
export const configKey = (name: string) => aliases[name] ?? name;
export function configValue(key: string, value: string): string {
  if (!value) return value;
  if (key === 'durationMinutes') {
    const match = /^(\d+(?:\.\d+)?)\s*(分钟|分|min|小时|时|h)?$/i.exec(value);
    if (!match) throw importBad('答题时限请填写分钟或小时数');
    const minutes = new Prisma.Decimal(match[1]!).mul(
      ['小时', '时', 'h'].includes(match[2]?.toLowerCase() ?? '') ? 60 : 1,
    );
    if (!minutes.isInteger() || minutes.gt(2147483647))
      throw importBad('答题时限必须能换算为32位整数分钟');
    return minutes.toString();
  }
  if (key === 'fullScore' || key === 'passScore') return value.replace(/\s*分$/, '');
  if (key === 'registrationDeadline') {
    value = value
      .replaceAll('年', '-')
      .replaceAll('月', '-')
      .replaceAll('日', '')
      .replaceAll('/', '-')
      .replaceAll('T', ' ');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) value += ' 23:59:59';
    else if (/ \d{2}:\d{2}$/.test(value)) value += ':00';
    parseProjectTime(value);
  }
  return value;
}
export function normalizeTable(rows: ImportCell[][]): ImportCell[][] | null {
  if (!rows.length) return null;
  const alternate: Record<string, string> = {
    题目: '题干',
    题目内容: '题干',
    答案: '参考答案',
    正确答案: '参考答案',
    正确选项: '参考答案',
    分数: '分值',
    每题分数: '分值',
    本题分数: '分值',
    选必答: '必答',
    是否必答: '必答',
    是否必填: '必答',
    试卷: '试卷名称',
    序号: '题号',
    参考答案附件: '答案附件',
  };
  const names = rows[0]!.map((c) => alternate[c.text.trim()] ?? c.text.trim());
  if (!names.includes('题干') || !names.includes('参考答案')) return null;
  if (names.some((n) => !questionHeaders.includes(n)) || new Set(names).size !== names.length)
    throw importBad('题目表存在未知或重复表头');
  return [
    questionHeaders.map((h) => cell(h)),
    ...rows.slice(1).map((row, index) => {
      if (row.length > names.length) throw importBad('题目表存在多余列');
      return questionHeaders.map(
        (header) => row[names.indexOf(header)] ?? cell(header === '题号' ? String(index + 1) : ''),
      );
    }),
  ];
}
const questionPattern =
  /^(?:第\s*(\d+)\s*题[：:.、]?|(?:题目|题干)\s*(\d*)\s*[：:.、]|(\d+)\s*[.．、)）](?!\d))\s*(.*)$/;
const answerPattern = /^(?:参考答案|正确选项|正确答案|答案)\s*[：:]?\s*(.*)$/;
class NarrativeQuestion {
  stem = '';
  answer = '';
  score = '';
  required = '';
  answering = false;
  stemAssets: ImportAsset[] = [];
  answerAssets: ImportAsset[] = [];
  constructor(
    readonly paper: string,
    readonly number: string,
  ) {}
  accept(input: ImportCell) {
    let text = input.text.trim();
    const flag =
      /^(?:选必答|是否必答|是否必填|必答|必填)\s*[：:]\s*(是|否|true|false|1|0|必答|选答|必填|选填|非必答|非必填)$/i.exec(
        text,
      );
    if (flag) {
      this.required = flag[1]!;
      return;
    }
    const stemAttachment = /^(?:题干附件|题目附件)\s*[：:](.*)$/.exec(text);
    const answerAttachment = /^(?:答案附件|参考答案附件)\s*[：:](.*)$/.exec(text);
    if (stemAttachment || answerAttachment) {
      const target = stemAttachment ? this.stemAssets : this.answerAssets;
      target.push(
        ...input.assets,
        ...(stemAttachment ?? answerAttachment)![1]!
          .split(/[|、]/)
          .map((n) => n.trim())
          .filter(Boolean)
          .map((name) => ({ name })),
      );
      return;
    }
    const answer = answerPattern.exec(text);
    if (answer) {
      this.answering = true;
      text = answer[1]!;
    } else if (!this.answering) {
      const inline = /\s+(?:参考答案|正确选项|正确答案|答案)\s*[：:]\s*/.exec(text);
      if (inline) {
        this.accept(cell(text.slice(0, inline.index)));
        this.answering = true;
        text = text.slice(inline.index + inline[0].length);
      }
    }
    if (!this.answering) {
      text = text.replace(/^(?:题目|题干)\s*[：:]\s*/, '');
      const combined =
        /[（(【[]\s*(\d+(?:\.\d+)?)\s*分?\s*[,，、;；]\s*(非必答|非必填|选答|选填|必答|必填)\s*[）)】\]]$/.exec(
          text,
        );
      if (combined) {
        this.score = combined[1]!;
        this.required = combined[2]!;
        text = text.slice(0, combined.index).trimEnd();
      }
      for (let i = 0; i < 3; i++) {
        const required = /[（(【[]?\s*(非必答|非必填|选答|选填|必答|必填)\s*[）)】\]]?\s*$/.exec(
          text,
        );
        if (required) {
          this.required = required[1]!;
          text = text.slice(0, required.index).trimEnd();
          continue;
        }
        const points =
          /(?:[（(【[]\s*(?:分值\s*[：:]?\s*)?(\d+(?:\.\d+)?)\s*分?\s*[）)】\]]|(?:分值|每题分数|本题分数|分数)\s*[：:]\s*(\d+(?:\.\d+)?)\s*分?|(?<![\d.])(\d+(?:\.\d+)?)\s*分\s*)$/.exec(
            text,
          );
        if (points) {
          const parsed = points[1] ?? points[2] ?? points[3]!;
          if (this.score && !new Prisma.Decimal(this.score).equals(parsed))
            throw importBad('同一题目存在冲突分值');
          this.score = parsed;
          text = text.slice(0, points.index).trimEnd();
          continue;
        }
        break;
      }
    }
    if (this.answering) {
      if (text) this.answer += (this.answer ? '\n' : '') + text;
      this.answerAssets.push(...input.assets);
    } else {
      if (text) this.stem += (this.stem ? '\n' : '') + text;
      this.stemAssets.push(...input.assets);
    }
  }
  row(): ImportCell[] {
    if (!this.answer && !this.answerAssets.length) throw importBad('题目缺少参考答案或答案附件');
    return [
      cell(this.paper),
      cell(this.number),
      cell(this.stem, this.stemAssets),
      cell(this.answer, this.answerAssets),
      cell(this.score),
      cell(this.required),
      cell(),
      cell(),
    ];
  }
}
export function narrativeRows(input: ImportCell[]): ParsedExam {
  if (input.length > 20000) throw importBad('题目文本超过允许行数');
  const metadata = new Map<string, string>(),
    rows = [questionHeaders.map((h) => cell(h))];
  let paper = '试卷1',
    question: NarrativeQuestion | null = null,
    sequence = 0;
  for (const c of input) {
    const line = c.text.trim();
    if (!line && !c.assets.length) continue;
    const pair = /^([^：:]+)\s*[：:]\s*(.*)$/.exec(line);
    if (pair && keys.has(configKey(pair[1]!.trim()))) {
      const key = configKey(pair[1]!.trim()),
        value = configValue(key, pair[2]!.trim());
      if (metadata.has(key)) throw importBad('重复考试配置项');
      if (key === 'formatVersion' && value !== '1') throw importBad('格式版本必须为1');
      metadata.set(key, value);
      continue;
    }
    if (
      /^(?:试卷名称|试卷)\s*[：:]\s*.+$/.test(line) ||
      /^试卷\s*[A-Za-z0-9一二三四五六七八九十]+$/.test(line)
    ) {
      if (question) rows.push(question.row());
      question = null;
      sequence = 0;
      paper = line.replace(/^(?:试卷名称|试卷)\s*[：:]\s*/, '');
      continue;
    }
    const start = questionPattern.exec(line);
    const repeats =
      start &&
      start[2] === '' &&
      question &&
      !question.answering &&
      !question.stem &&
      !question.stemAssets.length;
    if (start && !repeats && !(question?.answering && /^\s/.test(c.text))) {
      if (question) rows.push(question.row());
      const number = start[1] ?? (start[2] || start[3]) ?? String(sequence + 1);
      sequence = Number(number);
      question = new NarrativeQuestion(paper, number);
      question.accept(cell(start[4]!, c.assets));
    } else {
      if (!question) {
        if (rows.length === 1 && line && !answerPattern.test(line))
          question = new NarrativeQuestion(paper, String(++sequence));
        else throw importBad('无法识别题目结构，请使用题号或题干、答案标记');
      }
      question.accept(c);
    }
  }
  if (question) rows.push(question.row());
  return buildExamImport(metadata, rows);
}
