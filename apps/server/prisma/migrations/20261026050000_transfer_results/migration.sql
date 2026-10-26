ALTER TABLE "ProjectMemberMovement"
 ADD COLUMN "targetExamAttemptId" INTEGER,
 ADD COLUMN "rejectedAt" TIMESTAMPTZ(3),
 ADD COLUMN "withdrawnAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "ProjectMemberMovement_targetExamAttemptId_key" ON "ProjectMemberMovement"("targetExamAttemptId");
ALTER TABLE "ProjectMemberMovement" ADD CONSTRAINT "ProjectMemberMovement_targetExamAttemptId_fkey"
 FOREIGN KEY ("targetExamAttemptId") REFERENCES "EntranceExamAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "EntranceExamAttempt_transfer_source_key" ON "EntranceExamAttempt"("sourceBizId")
 WHERE "sourceBizType" = 'PROJECT_MEMBER_TRANSFER';
