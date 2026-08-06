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

// app.enableCors({
//  origin: (origin, callback) => {
//    if (!origin) {
//      return callback(null, true);
//    }

//    if (allowedOrigins.includes(origin)) {
//      return callback(null, true);
//    }

//    callback(new Error('Not allowed by CORS'));
//  },
//  credentials: true,
//});

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    res.header('Vary', 'Origin'); 
    
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    
    next();
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
