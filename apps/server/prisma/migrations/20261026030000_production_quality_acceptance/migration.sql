ALTER TABLE "ProjectSubtask"
 ADD COLUMN "acceptanceRound" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "reportedQuantity" DECIMAL(30,4),
 ADD COLUMN "actualQuantity" DECIMAL(30,4),
 ADD COLUMN "quantityAdjustmentRemark" VARCHAR(1000),
 ADD COLUMN "actualDeliveryDate" DATE,
 ADD COLUMN "submittedBy" VARCHAR(36),
 ADD COLUMN "submittedAt" TIMESTAMPTZ(3),
 ADD COLUMN "reviewedBy" VARCHAR(36),
 ADD COLUMN "reviewedAt" TIMESTAMPTZ(3),
 ADD COLUMN "rejectReason" VARCHAR(500),
 ADD CONSTRAINT "ProjectSubtask_acceptance_valid" CHECK (
 "acceptanceRound" >= 1 AND ("actualQuantity" IS NULL OR "actualQuantity" > 0)
 AND ("reportedQuantity" IS NULL OR "reportedQuantity" >= 0)
 AND ("status" NOT IN ('PENDING_ACCEPTANCE','REWORK_REQUIRED','ACCEPTED') OR
  ("actualQuantity" IS NOT NULL AND "reportedQuantity" IS NOT NULL AND "actualDeliveryDate" IS NOT NULL
   AND "submittedBy" IS NOT NULL AND "submittedAt" IS NOT NULL))
 AND ("status" <> 'REWORK_REQUIRED' OR ("reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "rejectReason" IS NOT NULL AND length(trim("rejectReason")) > 0))
 AND ("status" <> 'ACCEPTED' OR ("reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "rejectReason" IS NULL)));
CREATE TABLE "ProjectOutputQuality" (
 "id" SERIAL PRIMARY KEY,
 "outputReportId" INTEGER NOT NULL,
 "dataSource" VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
 "inspectedQuantity" DECIMAL(30,4) NOT NULL,
 "qualifiedQuantity" DECIMAL(30,4) NOT NULL,
 "unqualifiedReason" VARCHAR(1000),
 "recordedBy" VARCHAR(36) NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ProjectOutputQuality_outputReportId_fkey" FOREIGN KEY ("outputReportId") REFERENCES "ProjectOutputReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ProjectOutputQuality_valid" CHECK ("dataSource" IN ('MANUAL','WORK_SYSTEM') AND "inspectedQuantity" > 0 AND "qualifiedQuantity" >= 0 AND "qualifiedQuantity" <= "inspectedQuantity")
);
CREATE INDEX "ProjectOutputQuality_outputReportId_id_idx" ON "ProjectOutputQuality"("outputReportId","id");
