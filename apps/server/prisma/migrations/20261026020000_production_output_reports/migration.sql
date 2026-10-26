CREATE TABLE "ProjectOutputReport" (
 "id" SERIAL PRIMARY KEY, "projectId" INTEGER NOT NULL, "subtaskId" INTEGER,
 "memberId" INTEGER NOT NULL, "userId" UUID NOT NULL, "reportDate" DATE NOT NULL,
 "quantity" DECIMAL(30,4) NOT NULL, "quantityUnit" VARCHAR(30) NOT NULL,
 "remark" VARCHAR(1000), "dataSource" VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
 "reviewStatus" VARCHAR(16) NOT NULL DEFAULT 'PENDING', "returnReason" VARCHAR(500),
 "verifiedBy" VARCHAR(36), "returnedBy" VARCHAR(36), "verifiedAt" TIMESTAMPTZ(3),
 "returnedAt" TIMESTAMPTZ(3), "lockedAt" TIMESTAMPTZ(3),
 "createdBy" VARCHAR(36) NOT NULL, "updatedBy" VARCHAR(36),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "ProjectOutputReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectOutputReport_subtaskId_projectId_fkey" FOREIGN KEY ("subtaskId","projectId") REFERENCES "ProjectSubtask"("id","projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectOutputReport_memberId_projectId_userId_fkey" FOREIGN KEY ("memberId","projectId","userId") REFERENCES "ProjectMember"("id","projectId","userId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectOutputReport_valid" CHECK ("quantity" >= 0 AND length(btrim("quantityUnit")) > 0 AND "dataSource" = 'MANUAL' AND ("subtaskId" IS NULL OR "subtaskId" > 0)),
 CONSTRAINT "ProjectOutputReport_state" CHECK (
 ("reviewStatus" = 'PENDING' AND "lockedAt" IS NULL AND "verifiedAt" IS NULL AND "verifiedBy" IS NULL AND "returnReason" IS NULL AND "returnedBy" IS NULL AND "returnedAt" IS NULL) OR
 ("reviewStatus" = 'RETURNED' AND "lockedAt" IS NULL AND "verifiedAt" IS NULL AND "verifiedBy" IS NULL AND length(btrim("returnReason")) > 0 AND "returnReason" IS NOT NULL AND "returnedBy" IS NOT NULL AND "returnedAt" IS NOT NULL) OR
 ("reviewStatus" = 'VERIFIED' AND "lockedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "returnReason" IS NULL AND "returnedBy" IS NULL AND "returnedAt" IS NULL))
);
-- null代表项目级，必须与子任务级一样防并发重复。
CREATE UNIQUE INDEX "ProjectOutputReport_daily_key" ON "ProjectOutputReport"("projectId",COALESCE("subtaskId",0),"memberId","reportDate");
CREATE INDEX "ProjectOutputReport_projectId_subtaskId_reviewStatus_reportDate_id_idx" ON "ProjectOutputReport"("projectId","subtaskId","reviewStatus","reportDate","id");
CREATE INDEX "ProjectOutputReport_projectId_userId_subtaskId_idx" ON "ProjectOutputReport"("projectId","userId","subtaskId");
