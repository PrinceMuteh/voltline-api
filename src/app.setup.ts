import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookieParser from 'cookie-parser';
import type { ServerOptions } from 'socket.io';

/** Socket.IO with the web origin allowed, sharing the HTTP server with the OCPP endpoint. */
class ConsoleIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly origin: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: Partial<ServerOptions>) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origin, credentials: true },
      // Leave upgrades on other paths (/ocpp/…) alone instead of closing them
      destroyUpgrade: false,
    } as ServerOptions);
  }
}

/** Shared by main.ts and the e2e tests so both run the same pipeline. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);

  app.setGlobalPrefix('v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({
    origin: config.getOrThrow<string>('WEB_ORIGIN'),
    credentials: true,
  });
  app.useWebSocketAdapter(
    new ConsoleIoAdapter(app, config.getOrThrow<string>('WEB_ORIGIN')),
  );
  return app;
}
