import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getBeautifulPage(): string {
    return `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>API Status</title>
          <style>
              body {
                  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                  background-color: #0f172a;
                  color: #e2e8f0;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  height: 100vh;
                  margin: 0;
              }
              .card {
                  background-color: #1e293b;
                  padding: 3rem;
                  border-radius: 1rem;
                  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
                  text-align: center;
                  border-top: 4px solid #38bdf8;
              }
              h1 { color: #38bdf8; margin-top: 0; }
              .status {
                  display: inline-block;
                  padding: 0.5rem 1rem;
                  background-color: #059669;
                  border-radius: 9999px;
                  font-weight: bold;
                  margin-top: 1rem;
              }
          </style>
      </head>
      <body>
          <div class="card">
              <h1>Backend NestJS</h1>
              <p>Tous les systèmes sont opérationnels niggas.</p>
              <div class="status">● Online</div>
          </div>
      </body>
      </html>
    `;
  }
}