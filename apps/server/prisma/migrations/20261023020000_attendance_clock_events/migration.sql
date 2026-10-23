ALTER TABLE "AttendanceEventOutbox" ALTER COLUMN "orgId" DROP NOT NULL;
CREATE TABLE "AttendanceClockEvent" (
 "id" SERIAL PRIMARY KEY, "eventNo" VARCHAR(64) NOT NULL UNIQUE,
 "scopeKey" VARCHAR(36) NOT NULL, "orgId" UUID, "userOrgRelId" UUID, "userId" UUID NOT NULL,
 "attendanceDate" DATE NOT NULL, "clockType" VARCHAR(16) NOT NULL,
 "clockAt" TIMESTAMP(3) NOT NULL, "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "timezone" VARCHAR(64) NOT NULL, "sourceType" VARCHAR(24) NOT NULL DEFAULT 'WORKBENCH_CLICK',
 "sourceRef" VARCHAR(128), "clientIp" VARCHAR(64), "extJson" JSONB,
 "createdBy" VARCHAR(36) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AttendanceClockEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AttendanceClockEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AttendanceClockEvent_userOrgRelId_userId_orgId_fkey" FOREIGN KEY ("userOrgRelId", "userId", "orgId") REFERENCES "UserOrgRel"("id", "userId", "orgId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AttendanceClockEvent_scope_check" CHECK (
  ("scopeKey" = 'PERSONAL' AND "orgId" IS NULL AND "userOrgRelId" IS NULL) OR
  ("orgId" IS NOT NULL AND "userOrgRelId" IS NOT NULL AND "scopeKey" = "orgId"::text)),
 CONSTRAINT "AttendanceClockEvent_values_check" CHECK ("clockType" IN ('CLOCK_IN','CLOCK_OUT') AND "sourceType" = 'WORKBENCH_CLICK' AND "attendanceDate" = "clockAt"::date)
);
CREATE INDEX "AttendanceClockEvent_scopeKey_userId_attendanceDate_idx" ON "AttendanceClockEvent"("scopeKey", "userId", "attendanceDate");
CREATE FUNCTION reject_attendance_clock_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AttendanceClockEvent is append-only'; END; $$;
CREATE TRIGGER "AttendanceClockEvent_immutable" BEFORE UPDATE OR DELETE ON "AttendanceClockEvent" FOR EACH ROW EXECUTE FUNCTION reject_attendance_clock_mutation();
