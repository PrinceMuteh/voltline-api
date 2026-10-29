-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "billing" JSONB,
ADD COLUMN     "idTag" TEXT,
ADD COLUMN     "meterStartWh" INTEGER;

-- AlterTable
ALTER TABLE "Tariff" ADD COLUMN     "fleetId" TEXT,
ADD COLUMN     "previousId" TEXT;

-- AddForeignKey
ALTER TABLE "Tariff" ADD CONSTRAINT "Tariff_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "Fleet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
