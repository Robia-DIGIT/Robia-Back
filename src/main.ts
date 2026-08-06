import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Origines autorisées à accéder à l'API depuis un navigateur.
  // IMPORTANT :
  // - localhost:5173 n'est PAS autorisé
  // - localhost:3000 n'est PAS autorisé
  // - seul le frontend officiel est autorisé
  const allowedOrigins = [
    'https://app.robia.digital',
  ];

  app.enableCors({
    origin: (origin, callback) => {
      // Autoriser les requêtes sans Origin
      // (ex: Postman, curl, requêtes serveur-à-serveur).
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Refuse les autres origines.
      return callback(new Error('Not allowed by CORS'), false);
    },

    credentials: true,

    methods: [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
    ],

    exposedHeaders: [],

    optionsSuccessStatus: 204,
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
