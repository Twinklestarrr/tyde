CREATE TABLE "OrganizationScheduleReceipt" (
  "id" SERIAL NOT NULL,
  "orgId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationScheduleReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationScheduleReceipt_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrganizationScheduleReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrganizationScheduleReceipt_kind_check" CHECK ("kind" IN ('BATCH', 'DETAIL'))
);
CREATE UNIQUE INDEX "OrganizationScheduleReceipt_orgId_userId_kind_key_key" ON "OrganizationScheduleReceipt"("orgId", "userId", "kind", "key");
CREATE TABLE "AttendanceEventOutbox" (
  "id" SERIAL NOT NULL,
  "orgId" UUID NOT NULL,
  "eventType" VARCHAR(32) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttendanceEventOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AttendanceEventOutbox_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AttendanceEventOutbox_status_createdAt_idx" ON "AttendanceEventOutbox"("status", "createdAt");
