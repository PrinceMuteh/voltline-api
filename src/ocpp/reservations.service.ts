import {
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import type { ReservationStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import { ConnectionRegistry } from './connection-registry.js';

const TIMEOUT_MS = 30_000;

export interface ReservationView {
  id: string;
  evseId: number;
  idTag: string;
  driver: string | null;
  expiresAt: string;
  status: ReservationStatus;
  rejection: string | null;
}

/**
 * Holds a connector for one card (OC-10): ReserveNow and CancelReservation, then the charger
 * tells us when it expires (2.0.1 ReservationStatusUpdate) or when the card starts charging.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly realtime: RealtimeGateway,
  ) {}

  async active(
    auth: AuthContext,
    chargerId: string,
  ): Promise<ReservationView[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        chargerId,
        workspaceId: auth.workspaceId,
        status: { in: ['REQUESTED', 'ACTIVE'] },
        expiresAt: { gt: new Date() },
      },
      include: { idToken: { include: { driver: true, fleet: true } } },
      orderBy: { expiresAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      evseId: r.evseId,
      idTag: r.idTag,
      driver: r.idToken?.driver?.name ?? r.idToken?.fleet?.name ?? null,
      expiresAt: r.expiresAt.toISOString(),
      status: r.status,
      rejection: r.rejection,
    }));
  }

  async reserve(
    auth: AuthContext,
    chargerId: string,
    input: { evseId: number; idTokenId: string; minutes: number },
  ) {
    const charger = await this.prisma.charger.findFirst({
      where: { id: chargerId, workspaceId: auth.workspaceId },
      include: { evses: true },
    });
    if (!charger) throw new NotFoundException('Charger not found.');
    if (!charger.evses.some((e) => e.evseId === input.evseId)) {
      throw new NotFoundException(
        `${charger.chargePointId} has no EVSE ${input.evseId}.`,
      );
    }
    const card = await this.prisma.idToken.findFirst({
      where: {
        id: input.idTokenId,
        workspaceId: auth.workspaceId,
        active: true,
      },
    });
    if (!card)
      throw new NotFoundException('That card was not found or is blocked.');
    const client = this.registry.get(chargerId);
    if (!client) {
      throw new ConflictException(
        `${charger.chargePointId} is not connected, so it can’t hold a connector right now.`,
      );
    }

    const [{ next }] = await this.prisma.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(MAX("ocppId"), 0) + 1 AS next FROM "Reservation" WHERE "chargerId" = ${chargerId}`;
    const expiresAt = new Date(Date.now() + input.minutes * 60_000);
    const reservation = await this.prisma.reservation.create({
      data: {
        workspaceId: auth.workspaceId,
        chargerId,
        evseId: input.evseId,
        ocppId: next,
        idTag: card.uid,
        idTokenId: card.id,
        expiresAt,
        requestedBy: auth.memberId,
      },
    });

    const v201 = client.session.protocol === 'ocpp2.0.1';
    let status: string;
    try {
      const res = (await client.call(
        'ReserveNow',
        v201
          ? {
              id: next,
              expiryDateTime: expiresAt.toISOString(),
              idToken: { idToken: card.uid, type: 'ISO14443' },
              evseId: input.evseId,
            }
          : {
              connectorId: input.evseId,
              expiryDate: expiresAt.toISOString(),
              idTag: card.uid,
              reservationId: next,
            },
        { callTimeoutMs: TIMEOUT_MS },
      )) as { status: string };
      status = res.status;
    } catch (error) {
      await this.set(reservation.id, 'REJECTED', 'NoResponse');
      throw new BadGatewayException(
        `${charger.chargePointId} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const accepted = status === 'Accepted';
    await this.set(
      reservation.id,
      accepted ? 'ACTIVE' : 'REJECTED',
      accepted ? null : status,
    );
    this.changed(auth.workspaceId, chargerId);
    return {
      status: accepted ? 'ACTIVE' : 'REJECTED',
      title: accepted
        ? `EVSE ${input.evseId} reserved for ${card.uid}`
        : `${charger.chargePointId} refused the reservation`,
      detail: accepted
        ? `Held until ${expiresAt.toISOString()}. Only that card can start a session.`
        : `Charger replied ${status}.`,
    };
  }

  async cancel(auth: AuthContext, chargerId: string, reservationId: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, chargerId, workspaceId: auth.workspaceId },
      include: { charger: true },
    });
    if (!reservation || !['REQUESTED', 'ACTIVE'].includes(reservation.status)) {
      throw new NotFoundException('This reservation has already ended.');
    }
    const client = this.registry.get(chargerId);
    if (client) {
      const res = (await client
        .call(
          'CancelReservation',
          { reservationId: reservation.ocppId },
          { callTimeoutMs: TIMEOUT_MS },
        )
        .catch(() => ({ status: 'Rejected' }))) as { status: string };
      // Rejected usually means the charger had already dropped it; either way it is over here
      void res;
    }
    await this.set(reservation.id, 'CANCELLED', null);
    this.changed(auth.workspaceId, chargerId);
  }

  // ─── From the charger ─────────────────────────────────────────────────────

  /** 2.0.1 ReservationStatusUpdate: Expired or Removed. */
  async statusUpdate(
    chargerId: string,
    workspaceId: string,
    ocppId: number,
    update: string,
  ) {
    await this.prisma.reservation.updateMany({
      where: { chargerId, ocppId, status: { in: ['REQUESTED', 'ACTIVE'] } },
      data: { status: update === 'Expired' ? 'EXPIRED' : 'CANCELLED' },
    });
    this.changed(workspaceId, chargerId);
  }

  /** A transaction started with this reservation (2.0.1 reservationId, 1.6J StartTransaction). */
  async used(chargerId: string, workspaceId: string, ocppId: number) {
    await this.prisma.reservation.updateMany({
      where: { chargerId, ocppId },
      data: { status: 'USED' },
    });
    this.changed(workspaceId, chargerId);
  }

  /** Reservations past their time that the charger never reported (1.6J has no update message). */
  async expireOverdue() {
    await this.prisma.reservation.updateMany({
      where: {
        status: { in: ['REQUESTED', 'ACTIVE'] },
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
  }

  private set(id: string, status: ReservationStatus, rejection: string | null) {
    return this.prisma.reservation.update({
      where: { id },
      data: { status, rejection },
    });
  }

  private changed(workspaceId: string, chargerId: string) {
    this.realtime.toWorkspace(workspaceId, 'charger.status', { chargerId });
  }
}
