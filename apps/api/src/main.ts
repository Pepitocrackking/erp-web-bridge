import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";
import { configureApp, setupDocs } from "./setup";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app, config);
  setupDocs(app, config);
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
