import {
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConnectionRegistry } from './connection-registry.js';
import type { ChargerClient } from './ocpp.types.js';

export interface ConfigItem {
  /** 2.0.1 component, e.g. OCPPCommCtrlr; null for 1.6J keys. */
  component: string | null;
  key: string;
  value: string | null;
  readonly: boolean;
  /** Why there is no value: UnknownVariable, Rejected… (2.0.1), or null. */
  note: string | null;
}

/**
 * The 2.0.1 variables the console shows and edits (standard device-model names from the
 * OCPP 2.0.1 spec, part 2 appendix). 1.6J returns its whole configuration in one call.
 */
const VARIABLES_201: { component: string; variable: string }[] = [
  { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' },
  { component: 'OCPPCommCtrlr', variable: 'WebSocketPingInterval' },
  { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval' },
  { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands' },
  { component: 'AuthCtrlr', variable: 'AuthorizeRemoteStart' },
  { component: 'AuthCtrlr', variable: 'LocalPreAuthorize' },
  { component: 'AuthCacheCtrlr', variable: 'Enabled' },
  { component: 'LocalAuthListCtrlr', variable: 'Enabled' },
  { component: 'TxCtrlr', variable: 'EVConnectionTimeOut' },
  { component: 'TxCtrlr', variable: 'StopTxOnEVSideDisconnect' },
];

const TIMEOUT_MS = 30_000;

/** Reads and changes a connected charger's settings; nothing is queued, so it must be online. */
@Injectable()
export class ConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
  ) {}

  async read(auth: AuthContext, chargerId: string): Promise<ConfigItem[]> {
    const client = await this.client(auth, chargerId);
    try {
      if (client.session.protocol === 'ocpp1.6') {
        const res = (await client.call(
          'GetConfiguration',
          {},
          { callTimeoutMs: TIMEOUT_MS },
        )) as {
          configurationKey?: {
            key: string;
            readonly: boolean;
            value?: string;
          }[];
        };
        return (res.configurationKey ?? [])
          .map((k) => ({
            component: null,
            key: k.key,
            value: k.value ?? null,
            readonly: k.readonly,
            note: null,
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
      }
      const res = (await client.call(
        'GetVariables',
        {
          getVariableData: VARIABLES_201.map((v) => ({
            component: { name: v.component },
            variable: { name: v.variable },
          })),
        },
        { callTimeoutMs: TIMEOUT_MS },
      )) as {
        getVariableResult: {
          attributeStatus: string;
          attributeValue?: string;
          component: { name: string };
          variable: { name: string };
        }[];
      };
      return res.getVariableResult.map((r) => ({
        component: r.component.name,
        key: r.variable.name,
        value: r.attributeValue ?? null,
        // The spec has no read-only flag in GetVariables; a rejected write tells us later
        readonly: false,
        note: r.attributeStatus === 'Accepted' ? null : r.attributeStatus,
      }));
    } catch (error) {
      throw new BadGatewayException(
        `The charger did not return its settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Returns the charger's answer: Accepted, Rejected, RebootRequired, NotSupported… */
  async write(
    auth: AuthContext,
    chargerId: string,
    item: { component?: string | null; key: string; value: string },
  ): Promise<{ status: string }> {
    const client = await this.client(auth, chargerId);
    try {
      if (client.session.protocol === 'ocpp1.6') {
        const res = (await client.call(
          'ChangeConfiguration',
          { key: item.key, value: item.value },
          { callTimeoutMs: TIMEOUT_MS },
        )) as { status: string };
        return { status: res.status };
      }
      if (!item.component) {
        throw new ConflictException(
          'OCPP 2.0.1 settings need their component.',
        );
      }
      const res = (await client.call(
        'SetVariables',
        {
          setVariableData: [
            {
              component: { name: item.component },
              variable: { name: item.key },
              attributeValue: item.value,
            },
          ],
        },
        { callTimeoutMs: TIMEOUT_MS },
      )) as { setVariableResult: { attributeStatus: string }[] };
      return {
        status: res.setVariableResult[0]?.attributeStatus ?? 'Rejected',
      };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new BadGatewayException(
        `The charger did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async client(
    auth: AuthContext,
    chargerId: string,
  ): Promise<ChargerClient> {
    const charger = await this.prisma.charger.findFirst({
      where: { id: chargerId, workspaceId: auth.workspaceId },
    });
    if (!charger) {
      throw new NotFoundException('Charger not found.');
    }
    const client = this.registry.get(chargerId);
    if (!client) {
      throw new ConflictException(
        `${charger.chargePointId} is not connected. Its settings can be read once it is back online.`,
      );
    }
    return client;
  }
}
