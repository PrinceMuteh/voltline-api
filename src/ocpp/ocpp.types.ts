import type { RPCClient } from 'ocpp-rpc';
import type { ChargerStatus, OcppProtocol } from '../generated/prisma/enums.js';

/** WebSocket subprotocols we speak, in order of preference. */
export const SUBPROTOCOLS = ['ocpp2.0.1', 'ocpp1.6'] as const;
export type Subprotocol = (typeof SUBPROTOCOLS)[number];

export const PROTOCOL_OF: Record<Subprotocol, OcppProtocol> = {
  'ocpp2.0.1': 'OCPP201',
  'ocpp1.6': 'OCPP16J',
};

/** Who is on the other end of a socket, fixed at the handshake. */
export interface ChargerSession {
  chargerId: string;
  workspaceId: string;
  chargePointId: string;
  siteName: string;
  protocol: Subprotocol;
  /** "Basic Auth · TLS 1.3", shown in the Add a charger checklist. */
  authDetail: string;
}

export type ChargerClient = RPCClient & { session: ChargerSession };

/**
 * The idTag remote starts from the console are sent with. Chargers echo it back in
 * StartTransaction / TransactionEvent, where it is always authorized.
 */
export const OPERATOR_ID_TAG = 'VOLTLINE-OPS';

/** A connector status, already translated out of either protocol. */
export interface ConnectorReport {
  evseId: number;
  connectorId: number;
  status: ChargerStatus;
  /** OCPP 1.6 errorCode or 2.0.1 techCode, e.g. GroundFailure. */
  errorCode?: string;
}
