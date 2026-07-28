import './env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const port = Number(process.env.API_PORT ?? 8790);

const app = await NestFactory.create(AppModule, {
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' },
});
await app.listen(port);
console.log(`API LP Monitor v2 jalan di http://localhost:${port}`);
