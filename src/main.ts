import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  // bodyParser is off on purpose: the proxy streams request bodies to the
  // target untouched, so Nest must not consume them first.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);
  await app.listen(process.env.PORT ?? 3100);
}
await bootstrap();
