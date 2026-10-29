-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'USED', 'CANCELLED', 'EXPIRED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ChargerStatus" ADD VALUE 'RESERVED';

-- AlterTable
ALTER TABLE "Charger" ADD COLUMN     "localListSyncedAt" TIMESTAMP(3),
ADD COLUMN     "localListVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "gridLimitKw" INTEGER;

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "evseId" INTEGER NOT NULL,
    "ocppId" INTEGER NOT NULL,
    "idTag" TEXT NOT NULL,
    "idTokenId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'REQUESTED',
    "rejection" TEXT,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reservation_workspaceId_status_idx" ON "Reservation"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_chargerId_ocppId_key" ON "Reservation"("chargerId", "ocppId");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_idTokenId_fkey" FOREIGN KEY ("idTokenId") REFERENCES "IdToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
