CREATE TABLE "ProjectMemberMovement" (
 "id" SERIAL PRIMARY KEY,
 "movementNo" VARCHAR(64) NOT NULL,
 "memberId" INTEGER NOT NULL,
 "userId" UUID NOT NULL,
 "sourceProjectId" INTEGER NOT NULL,
 "targetProjectId" INTEGER,
 "movementType" VARCHAR(16) NOT NULL,
 "reason" VARCHAR(500) NOT NULL,
 "plannedEffectiveDate" DATE NOT NULL,
 "status" VARCHAR(24) NOT NULL,
 "initiatedBy" UUID NOT NULL,
 "flowId" UUID,
 "versionNo" INTEGER NOT NULL DEFAULT 0,
 "effectiveAt" TIMESTAMPTZ(3),
 "createdBy" VARCHAR(36) NOT NULL,
 "updatedBy" VARCHAR(36),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "ProjectMemberMovement_memberId_sourceProjectId_userId_fkey" FOREIGN KEY ("memberId","sourceProjectId","userId") REFERENCES "ProjectMember"("id","projectId","userId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectMemberMovement_targetProjectId_fkey" FOREIGN KEY ("targetProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectMemberMovement_initiatedBy_fkey" FOREIGN KEY ("initiatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectMemberMovement_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "ApprovalFlow"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectMemberMovement_valid" CHECK (
  "versionNo" >= 0 AND length(trim("reason")) > 0 AND
  "status" IN ('PROCESSING','WAITING_EFFECTIVE','EFFECTIVE','REJECTED','WITHDRAWN') AND
  (("movementType" = 'REMOVAL' AND "targetProjectId" IS NULL AND "flowId" IS NULL AND "status" <> 'PROCESSING') OR
   ("movementType" = 'TRANSFER' AND "targetProjectId" IS NOT NULL AND "targetProjectId" <> "sourceProjectId")) AND
  (("status" = 'EFFECTIVE') = ("effectiveAt" IS NOT NULL))
 )
);
CREATE UNIQUE INDEX "ProjectMemberMovement_movementNo_key" ON "ProjectMemberMovement"("movementNo");
CREATE UNIQUE INDEX "ProjectMemberMovement_flowId_key" ON "ProjectMemberMovement"("flowId");
CREATE UNIQUE INDEX "ProjectMemberMovement_open_member_key" ON "ProjectMemberMovement"("memberId") WHERE "status" IN ('PROCESSING','WAITING_EFFECTIVE');
CREATE INDEX "ProjectMemberMovement_sourceProjectId_status_createdAt_idx" ON "ProjectMemberMovement"("sourceProjectId","status","createdAt");
CREATE INDEX "ProjectMemberMovement_targetProjectId_status_idx" ON "ProjectMemberMovement"("targetProjectId","status");
CREATE INDEX "ProjectMemberMovement_status_plannedEffectiveDate_idx" ON "ProjectMemberMovement"("status","plannedEffectiveDate");
