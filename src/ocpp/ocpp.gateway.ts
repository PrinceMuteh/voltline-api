import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import * as argon2 from 'argon2';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { RPCServer } from 'ocpp-rpc';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionRecorder } from '../sessions/session-recorder.service.js';
import { ChargerStateService } from './charger-state.service.js';
import { CommandsService } from './commands.service.js';
import { ConnectionRegistry } from './connection-registry.js';
import { OcppMessagesService } from './ocpp-messages.service.js';
import { registerHandlers } from './ocpp.handlers.js';
import {
  SUBPROTOCOLS,
  type ChargerClient,
  type ChargerSession,
  type Subprotocol,
} from './ocpp.types.js';

const PATH_PREFIX = '/ocpp/';
/** Failed password attempts allowed per charge point per minute before refusing outright. */
const MAX_AUTH_FAILURES = 10;

type Accept = (
  session?: Record<string, unknown>,
  protocol?: string | false,
) => void;
type Reject = (code: number, message: string) => void;
interface Handshake {
  identity: string;
  protocols: Set<string>;
  password: Buffer | undefined;
  request: IncomingMessage;
}

/**
 * The OCPP endpoint: chargers dial ws(s)://<host>/ocpp/{chargePointId}. It shares the API's
 * HTTP server and authenticates during the upgrade, before a single OCPP frame is read.
 */
@Injectable()
export class OcppGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OcppGateway.name);
  private server?: RPCServer;
  private readonly authFailures = new Map<string, number[]>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly state: ChargerStateService,
    private readonly commands: CommandsService,
    private readonly messages: OcppMessagesService,
    private readonly recorder: SessionRecorder,
  ) {}

  onApplicationBootstrap() {
    const server = new RPCServer({
      protocols: [...SUBPROTOCOLS],
      strictMode: true,
      callTimeoutMs: 30_000,
      pingIntervalMs: 30_000,
      respondWithDetailedErrors: true,
    });
    server.auth((accept, reject, handshake) => {
      void this.authenticate(accept, reject, handshake).catch(
        (error: unknown) => {
          this.logger.error(`Handshake failed: ${String(error)}`);
          reject(500, 'Internal error');
        },
      );
    });
    server.on('client', (client: ChargerClient) => {
      void this.attach(client).catch((error: unknown) =>
        this.logger.error(
          `Could not attach ${client.identity}: ${String(error)}`,
        ),
      );
    });
    this.server = server;

    const http = this.adapterHost.httpAdapter.getHttpServer() as Server;
    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Socket.IO handles its own path; everything under /ocpp/ is a charger
      if (req.url?.startsWith(PATH_PREFIX)) {
        void server.handleUpgrade(req, socket as never, head);
      }
    });
  }

  async onModuleDestroy() {
    await this.server?.close({ force: true });
  }

  private async authenticate(
    accept: Accept,
    reject: Reject,
    handshake: Handshake,
  ) {
    const charger = await this.prisma.charger.findUnique({
      where: { chargePointId: handshake.identity },
      include: {
        credentials: { where: { revokedAt: null } },
        workspace: { include: { ocppConfig: true } },
        site: { select: { name: true } },
      },
    });
    if (!charger) {
      return reject(404, 'Unknown charge point');
    }

    const settings = charger.workspace.ocppConfig;
    const allowed = SUBPROTOCOLS.filter((p) =>
      p === 'ocpp2.0.1'
        ? (settings?.accept201 ?? true)
        : (settings?.accept16J ?? true),
    );
    const protocol = allowed.find((p) => handshake.protocols.has(p));
    if (!protocol) {
      const offered = [...handshake.protocols].join(', ') || 'no OCPP version';
      this.state.failed(
        charger,
        'socket',
        `The charger offered ${offered}. This workspace accepts ${allowed.join(' and ') || 'no OCPP version'} (Settings › OCPP).`,
      );
      return reject(400, 'Unsupported subprotocol');
    }

    const tls = tlsOf(handshake.request);
    if (!tls && this.config.get('NODE_ENV') === 'production') {
      this.state.failed(
        charger,
        'credentials',
        'The charger connected without TLS. Use the wss:// URL.',
      );
      return reject(400, 'Security Profile 2 requires TLS');
    }

    if (this.tooManyFailures(charger.id)) {
      return reject(429, 'Too many failed attempts');
    }
    const password = handshake.password?.toString('utf8');
    if (!password) {
      this.noteFailure(charger.id);
      this.state.failed(
        charger,
        'credentials',
        'No password was sent. Enter the password from step 2 in the charger.',
      );
      return reject(401, 'Unauthorized');
    }
    const matches = await Promise.all(
      charger.credentials.map((c) => argon2.verify(c.passwordHash, password)),
    );
    if (!matches.includes(true)) {
      this.noteFailure(charger.id);
      this.state.failed(
        charger,
        'credentials',
        'The password did not match. Copy it again, or rotate it and enter the new one.',
      );
      return reject(401, 'Unauthorized');
    }

    const session: ChargerSession = {
      chargerId: charger.id,
      workspaceId: charger.workspaceId,
      chargePointId: charger.chargePointId,
      siteName: charger.site.name,
      protocol: protocol as Subprotocol,
      authDetail: `Basic Auth · ${tls ?? 'no TLS (development)'}`,
    };
    accept({ ...session }, protocol);
  }

  private async attach(client: ChargerClient) {
    const s = client.session;

    // One socket per charger: a reconnect replaces a half-open old one
    const previous = this.registry.get(s.chargerId);
    this.registry.set(s.chargerId, client);
    if (previous) {
      void previous.close({
        code: 1000,
        reason: 'Replaced by a new connection',
      });
    }

    const record = this.messages.recorder(s);
    client.on(
      'message',
      ({ message, outbound }: { message: unknown; outbound: boolean }) => {
        record(message, outbound);
        if (!outbound) {
          void this.state.touch(s).catch(() => undefined);
        }
      },
    );
    client.on('close', () => {
      this.registry.delete(s.chargerId, client);
      if (!this.registry.has(s.chargerId)) {
        this.state.disconnected(s);
      }
      this.logger.log(`${s.chargePointId} disconnected`);
    });

    registerHandlers(client, this.state, this.recorder, () => {
      // While Pending, the charger only talks when asked; ask it for its connectors
      setTimeout(() => void this.requestStatus(client), 500);
    });

    await this.state.connected(s);
    this.logger.log(`${s.chargePointId} connected over ${s.protocol}`);

    const charger = await this.prisma.charger.findUnique({
      where: { id: s.chargerId },
      select: { approval: true },
    });
    if (charger?.approval === 'ACCEPTED') {
      setTimeout(() => void this.commands.flush(s.chargerId), 2_000);
    }
  }

  /** After approval: ask a connected charger to boot again so it gets Accepted now. */
  async requestBoot(chargerId: string) {
    const client = this.registry.get(chargerId);
    if (client) {
      await client
        .call('TriggerMessage', { requestedMessage: 'BootNotification' })
        .catch((error: unknown) =>
          this.logger.warn(`TriggerMessage BootNotification: ${String(error)}`),
        );
    }
  }

  private async requestStatus(client: ChargerClient) {
    const s = client.session;
    try {
      if (s.protocol === 'ocpp1.6') {
        await client.call('TriggerMessage', {
          requestedMessage: 'StatusNotification',
        });
        return;
      }
      const evses = await this.prisma.evse.findMany({
        where: { chargerId: s.chargerId },
        include: { connectors: true },
      });
      for (const evse of evses) {
        for (const c of evse.connectors) {
          await client.call('TriggerMessage', {
            requestedMessage: 'StatusNotification',
            evse: { id: evse.evseId, connectorId: c.connectorId },
          });
        }
      }
    } catch (error) {
      this.logger.warn(`TriggerMessage StatusNotification: ${String(error)}`);
    }
  }

  private tooManyFailures(chargerId: string) {
    const recent = (this.authFailures.get(chargerId) ?? []).filter(
      (t) => Date.now() - t < 60_000,
    );
    this.authFailures.set(chargerId, recent);
    return recent.length >= MAX_AUTH_FAILURES;
  }

  private noteFailure(chargerId: string) {
    this.authFailures.set(chargerId, [
      ...(this.authFailures.get(chargerId) ?? []),
      Date.now(),
    ]);
  }
}

/** "TLS 1.3" when TLS ends here, "TLS" when a proxy in front did it, undefined for plain ws://. */
function tlsOf(req: IncomingMessage): string | undefined {
  if (req.socket instanceof TLSSocket) {
    return req.socket.getProtocol()?.replace('TLSv', 'TLS ') ?? 'TLS';
  }
  return req.headers['x-forwarded-proto'] === 'https' ? 'TLS' : undefined;
}
