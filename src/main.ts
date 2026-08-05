import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // app.enableCors({
  //   origin: process.env.FRONTEND_URL ?? 'http://localhost:3000', 'https://app.robia.digital',
  //   credentials: true,
  // });
  
  //const allowedOrigins = [
  //  'http://localhost:3000',
  //  'https://app.robia.digital',
  // ];

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://app.robia.digital',
];

app.enableCors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
});

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
