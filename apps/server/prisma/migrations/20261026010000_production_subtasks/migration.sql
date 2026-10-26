CREATE TABLE "ProjectSubtask" (
 "id" SERIAL PRIMARY KEY, "projectId" INTEGER NOT NULL, "subtaskNo" VARCHAR(64) NOT NULL,
 "subtaskName" VARCHAR(128) NOT NULL, "expectedDeliveryDate" DATE NOT NULL,
 "expectedQuantity" DECIMAL(30,4) NOT NULL, "quantityUnit" VARCHAR(30) NOT NULL,
 "distributionMode" VARCHAR(16) NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'IN_PROGRESS',
 "createdBy" VARCHAR(36) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "ProjectSubtask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectSubtask_valid" CHECK (length(btrim("subtaskName")) > 0 AND "expectedQuantity" > 0 AND length(btrim("quantityUnit")) > 0 AND "distributionMode" IN ('POOL','DESIGNATED') AND "status" IN ('IN_PROGRESS','PENDING_ACCEPTANCE','REWORK_REQUIRED','ACCEPTED'))
);
CREATE UNIQUE INDEX "ProjectSubtask_subtaskNo_key" ON "ProjectSubtask"("subtaskNo");
CREATE UNIQUE INDEX "ProjectSubtask_projectId_subtaskName_key" ON "ProjectSubtask"("projectId","subtaskName");
CREATE UNIQUE INDEX "ProjectSubtask_id_projectId_key" ON "ProjectSubtask"("id","projectId");
CREATE INDEX "ProjectSubtask_projectId_status_id_idx" ON "ProjectSubtask"("projectId","status","id");
CREATE TABLE "ProjectSubtaskAssignee" (
 "id" SERIAL PRIMARY KEY, "projectId" INTEGER NOT NULL, "subtaskId" INTEGER NOT NULL,
 "memberId" INTEGER NOT NULL, "userId" UUID NOT NULL, "assignmentType" VARCHAR(16) NOT NULL,
 "assignedBy" VARCHAR(36) NOT NULL, "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProjectSubtaskAssignee_subtaskId_projectId_fkey" FOREIGN KEY ("subtaskId","projectId") REFERENCES "ProjectSubtask"("id","projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectSubtaskAssignee_memberId_projectId_userId_fkey" FOREIGN KEY ("memberId","projectId","userId") REFERENCES "ProjectMember"("id","projectId","userId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectSubtaskAssignee_type_check" CHECK ("assignmentType" IN ('DESIGNATED','CLAIMED'))
);
CREATE UNIQUE INDEX "ProjectSubtaskAssignee_subtaskId_memberId_key" ON "ProjectSubtaskAssignee"("subtaskId","memberId");
CREATE INDEX "ProjectSubtaskAssignee_projectId_memberId_subtaskId_idx" ON "ProjectSubtaskAssignee"("projectId","memberId","subtaskId");
