-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'SUPPORT', 'FINANCE', 'SITE_HOST');

-- CreateEnum
CREATE TYPE "ChargerCountBand" AS ENUM ('ONE_TO_TEN', 'ELEVEN_TO_FIFTY', 'FIFTY_ONE_PLUS');

-- CreateEnum
CREATE TYPE "OcppProtocol" AS ENUM ('OCPP16J', 'OCPP201', 'OCPP21');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChargerStatus" AS ENUM ('AVAILABLE', 'CHARGING', 'FAULTED', 'OFFLINE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('CCS2', 'TYPE2', 'CHADEMO');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('QUEUED', 'SENT', 'ACCEPTED', 'REJECTED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'PAYMENT_OVERDUE');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'STOPPED_BY_FAULT', 'PAYMENT_FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PRE_AUTHORIZATION', 'CAPTURE', 'TOP_UP', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'WALLET', 'BANK_TRANSFER', 'USSD', 'FLEET_INVOICE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'CREDITED', 'FAILED', 'REFUNDED', 'RELEASED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('CHARGER_OFFLINE', 'CHARGER_FAULTED', 'FIRMWARE_AVAILABLE', 'PAYMENT_FAILED');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registeredCompanyName" TEXT,
    "country" TEXT NOT NULL DEFAULT 'NG',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "timeZone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "chargerCountBand" "ChargerCountBand",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteHost" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revenueShareBps" INTEGER NOT NULL,
    "payoutAccountName" TEXT,
    "payoutAccountNo" TEXT,
    "payoutBankCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "siteHostId" TEXT,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "openingHours" TEXT NOT NULL DEFAULT 'Open 24 hours',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "chargePointId" TEXT NOT NULL,
    "vendor" TEXT,
    "model" TEXT,
    "firmwareVersion" TEXT,
    "protocol" "OcppProtocol",
    "securityProfile" INTEGER NOT NULL DEFAULT 2,
    "approval" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "status" "ChargerStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evse" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "evseId" INTEGER NOT NULL,

    CONSTRAINT "Evse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "evseDbId" TEXT NOT NULL,
    "connectorId" INTEGER NOT NULL DEFAULT 1,
    "type" "ConnectorType" NOT NULL,
    "maxPowerW" INTEGER NOT NULL,
    "status" "ChargerStatus" NOT NULL DEFAULT 'OFFLINE',

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargerCredential" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ChargerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcppMessage" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemoteCommand" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'QUEUED',
    "response" JSONB,
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RemoteCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcppSettings" (
    "workspaceId" TEXT NOT NULL,
    "accept16J" BOOLEAN NOT NULL DEFAULT true,
    "accept201" BOOLEAN NOT NULL DEFAULT true,
    "accept21" BOOLEAN NOT NULL DEFAULT false,
    "autoApproveChargers" BOOLEAN NOT NULL DEFAULT false,
    "syncLocalLists" BOOLEAN NOT NULL DEFAULT true,
    "heartbeatIntervalSec" INTEGER NOT NULL DEFAULT 300,
    "meterValuesSampleSec" INTEGER NOT NULL DEFAULT 60,
    "offlineAlertAfterMin" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "OcppSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "plugTypes" "ConnectorType"[],
    "status" "DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "fleetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fleet" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invoiceDay" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fleet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "driverId" TEXT,
    "fleetId" TEXT,
    "dailyLimitKobo" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tariff" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "perKwhKobo" INTEGER NOT NULL,
    "perMinuteKobo" INTEGER NOT NULL DEFAULT 0,
    "sessionFeeKobo" INTEGER NOT NULL DEFAULT 0,
    "idleGraceMin" INTEGER,
    "idlePerMinuteKobo" INTEGER,
    "peakFrom" TEXT,
    "peakTo" TEXT,
    "peakSurchargeBps" INTEGER,
    "vatIncluded" BOOLEAN NOT NULL DEFAULT true,
    "vatBps" INTEGER NOT NULL DEFAULT 750,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffSite" (
    "tariffId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,

    CONSTRAINT "TariffSite_pkey" PRIMARY KEY ("tariffId","siteId")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "connectorId" TEXT,
    "transactionId" TEXT NOT NULL,
    "driverId" TEXT,
    "idTokenId" TEXT,
    "fleetId" TEXT,
    "tariffId" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "chargingEndedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "energyWh" INTEGER NOT NULL DEFAULT 0,
    "amountKobo" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeterSample" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "powerW" INTEGER,
    "energyWh" INTEGER NOT NULL,
    "socPct" INTEGER,

    CONSTRAINT "MeterSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amountKobo" INTEGER NOT NULL,
    "sessionId" TEXT,
    "driverId" TEXT,
    "cardLast4" TEXT,
    "gatewayRef" TEXT,
    "idempotencyKey" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAccount" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "balanceKobo" INTEGER NOT NULL DEFAULT 0,
    "reservedKobo" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentGatewayConfig" (
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT,
    "preAuthHoldKobo" INTEGER NOT NULL DEFAULT 500000,
    "minTopUpKobo" INTEGER NOT NULL DEFAULT 100000,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGatewayConfig_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "chargerId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "memberId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "interest" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_MemberSites" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_MemberSites_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Member_workspaceId_userId_key" ON "Member"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_idx" ON "Invite"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "SiteHost_workspaceId_idx" ON "SiteHost"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_workspaceId_name_key" ON "Site"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Charger_workspaceId_status_idx" ON "Charger"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Charger_chargePointId_key" ON "Charger"("chargePointId");

-- CreateIndex
CREATE UNIQUE INDEX "Evse_chargerId_evseId_key" ON "Evse"("chargerId", "evseId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_evseDbId_connectorId_key" ON "Connector"("evseDbId", "connectorId");

-- CreateIndex
CREATE INDEX "ChargerCredential_chargerId_idx" ON "ChargerCredential"("chargerId");

-- CreateIndex
CREATE INDEX "OcppMessage_chargerId_at_idx" ON "OcppMessage"("chargerId", "at");

-- CreateIndex
CREATE INDEX "RemoteCommand_chargerId_status_idx" ON "RemoteCommand"("chargerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_workspaceId_phone_key" ON "Driver"("workspaceId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "IdToken_workspaceId_uid_key" ON "IdToken"("workspaceId", "uid");

-- CreateIndex
CREATE INDEX "Tariff_workspaceId_idx" ON "Tariff"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_reference_key" ON "Session"("reference");

-- CreateIndex
CREATE INDEX "Session_workspaceId_startedAt_idx" ON "Session"("workspaceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_chargerId_transactionId_key" ON "Session"("chargerId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "MeterSample_sessionId_at_key" ON "MeterSample"("sessionId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "SessionEvent_sessionId_idempotencyKey_key" ON "SessionEvent"("sessionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_reference_key" ON "Transaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_createdAt_idx" ON "Transaction"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletAccount_driverId_key" ON "WalletAccount"("driverId");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_workspaceId_resolvedAt_idx" ON "Alert"("workspaceId", "resolvedAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_at_idx" ON "AuditLog"("workspaceId", "at");

-- CreateIndex
CREATE INDEX "_MemberSites_B_index" ON "_MemberSites"("B");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteHost" ADD CONSTRAINT "SiteHost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_siteHostId_fkey" FOREIGN KEY ("siteHostId") REFERENCES "SiteHost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charger" ADD CONSTRAINT "Charger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charger" ADD CONSTRAINT "Charger_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evse" ADD CONSTRAINT "Evse_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_evseDbId_fkey" FOREIGN KEY ("evseDbId") REFERENCES "Evse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargerCredential" ADD CONSTRAINT "ChargerCredential_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcppMessage" ADD CONSTRAINT "OcppMessage_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemoteCommand" ADD CONSTRAINT "RemoteCommand_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcppSettings" ADD CONSTRAINT "OcppSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "Fleet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fleet" ADD CONSTRAINT "Fleet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdToken" ADD CONSTRAINT "IdToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdToken" ADD CONSTRAINT "IdToken_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdToken" ADD CONSTRAINT "IdToken_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "Fleet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tariff" ADD CONSTRAINT "Tariff_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffSite" ADD CONSTRAINT "TariffSite_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffSite" ADD CONSTRAINT "TariffSite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_idTokenId_fkey" FOREIGN KEY ("idTokenId") REFERENCES "IdToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "Fleet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeterSample" ADD CONSTRAINT "MeterSample_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAccount" ADD CONSTRAINT "WalletAccount_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WalletAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentGatewayConfig" ADD CONSTRAINT "PaymentGatewayConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MemberSites" ADD CONSTRAINT "_MemberSites_A_fkey" FOREIGN KEY ("A") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_MemberSites" ADD CONSTRAINT "_MemberSites_B_fkey" FOREIGN KEY ("B") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
