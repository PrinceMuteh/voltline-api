import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Voltline API')
      .setDescription('Operator console, driver app and partner API')
      .setVersion('0.1.0')
      .addCookieAuth('vl_access')
      .addBearerAuth()
      .build(),
  );
  // Served at /docs and /openapi.json; voltline-web generates its client from the JSON
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'openapi.json',
  });

  await app.listen(app.get(ConfigService).get<number>('PORT') ?? 4000);
}
await bootstrap();
