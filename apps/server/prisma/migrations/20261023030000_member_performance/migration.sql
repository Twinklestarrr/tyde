CREATE UNIQUE INDEX "ProjectMember_id_projectId_userId_key" ON "ProjectMember"("id", "projectId", "userId");
CREATE TABLE "ProjectMemberPerformance" (
 "id" SERIAL PRIMARY KEY, "projectId" INTEGER NOT NULL, "memberId" INTEGER NOT NULL,
 "userId" UUID NOT NULL, "recordDate" DATE NOT NULL, "content" VARCHAR(2000) NOT NULL,
 "attachmentIds" UUID[] NOT NULL, "recordedBy" VARCHAR(36) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProjectMemberPerformance_memberId_projectId_userId_fkey" FOREIGN KEY ("memberId", "projectId", "userId") REFERENCES "ProjectMember"("id", "projectId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectMemberPerformance_content_check" CHECK (length(btrim("content")) BETWEEN 1 AND 2000 AND cardinality("attachmentIds") <= 10)
);
CREATE INDEX "ProjectMemberPerformance_projectId_memberId_recordDate_id_idx" ON "ProjectMemberPerformance"("projectId", "memberId", "recordDate", "id");
