import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // app.enableCors({
  //   origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  //   credentials: true,
  // });
  
  //const allowedOrigins = [
  //  'http://localhost:3000',
  //  'https://robia-copilot-front.vercel.app',
  // ];

  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ??
    'http://localhost:3000,https://app.robia.digital'
  ).split(',');

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
