import type { EntranceExamConfiguration } from '@tyde/shared';
import { EntranceExamFiles } from './EntranceExamFiles';
import { EntranceExamText } from './EntranceExamText';

export function EntranceExamConfigurationView({ config }: { config: EntranceExamConfiguration }) {
  return (
    <section aria-label="考试配置内容" className="space-y-5">
      <dl className="grid gap-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        {[
          ['考试名称', config.examName],
          ['版本', `第 ${config.versionNo} 版`],
          [
            '答题时限',
            config.durationMinutes === null ? '不限时' : `${config.durationMinutes} 分钟`,
          ],
          ['报名截止（上海时间）', config.registrationDeadline],
          ['试卷满分', config.fullScore],
          ['准入分数线', config.passScore],
          ['裁决规则', config.decisionRule === 'MANUAL_PRIORITY' ? '人工优先' : '多数轮次'],
          [
            '平票处理',
            config.tieBreakRule === 'STRICT'
              ? '严格：不通过'
              : config.tieBreakRule === 'LENIENT'
                ? '宽松：通过'
                : '无需配置',
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[13px] text-muted-foreground">
        此处为当前版本。考生的历史卷与成绩在考试名单中查看。
      </p>
      {config.papers.map((paper) => (
        <section
          key={paper.paperId}
          aria-label={`试卷${paper.sequenceNo}配置`}
          className="space-y-4 rounded-xl border p-4"
        >
          <h3 className="text-base font-semibold">
            {paper.paperName || `试卷${paper.sequenceNo}`} · 满分 {paper.totalScore}
          </h3>
          {paper.questions.map((question) => (
            <article key={question.questionId} className="space-y-3 border-t pt-4">
              <h4 className="text-sm font-medium">
                题目 {question.sequenceNo} · {question.requiredFlag ? '必答' : '选答'} ·{' '}
                {question.score} 分
              </h4>
              <EntranceExamText value={question.questionContent} empty="附件题" />
              <EntranceExamFiles
                value={question.questionFiles}
                label={`题目${question.sequenceNo}题干附件`}
              />
              <p className="text-xs text-muted-foreground">参考答案</p>
              <EntranceExamText value={question.referenceAnswer} />
              <EntranceExamFiles
                value={question.referenceFiles}
                label={`题目${question.sequenceNo}参考附件`}
              />
            </article>
          ))}
        </section>
      ))}
      <section aria-label="配置判卷轮次" className="space-y-3">
        <h3 className="text-base font-semibold">判卷轮次</h3>
        {config.gradingRounds.map((round) => (
          <article
            key={round.gradingRoundId}
            className="space-y-2 rounded-xl border p-4 text-[13px]"
          >
            <h4 className="font-medium">
              第 {round.roundNo} 轮 · {round.gradingMode === 'AUTO' ? '模拟自动阅卷' : '人工阅卷'}
            </h4>
            {round.gradingMode === 'AUTO' ? (
              <>
                <p>
                  {round.toolName}（{round.toolCode}）
                </p>
                <EntranceExamFiles value={round.toolFiles} label={`第${round.roundNo}轮工具附件`} />
              </>
            ) : (
              <p>
                {Array.isArray(round.reviewers)
                  ? round.reviewers
                      .map((reviewer) =>
                        reviewer && typeof reviewer === 'object'
                          ? String(reviewer.name ?? reviewer.uid ?? '历史阅卷人')
                          : '历史阅卷人',
                      )
                      .join('、') || '未配置'
                  : '历史阅卷人快照未展开'}
              </p>
            )}
          </article>
        ))}
      </section>
    </section>
  );
}
