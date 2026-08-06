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
          <title>API status</title>
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
                  overflow: hidden;
                  position: relative;
              }
              
              /* L'engrenage géant en arrière-plan */
              .gear-background {
                  position: absolute;
                  top: 50%;
                  left: 50%;
                  width: 80vh;
                  height: 80vh;
                  color: #334155; /* Plus clair pour être visible ! */
                  z-index: 1; /* Au-dessus du fond de la page */
                  /* On combine le centrage et la rotation dans l'animation */
                  animation: spin 30s linear infinite; 
              }
              
              /* L'animation combine le centrage (translate) et la rotation (rotate) */
              @keyframes spin {
                  0% { transform: translate(-50%, -50%) rotate(0deg); }
                  100% { transform: translate(-50%, -50%) rotate(360deg); }
              }
              
              .card {
                  position: relative;
                  z-index: 10; /* S'assure que la carte est bien devant l'engrenage */
                  background-color: rgba(30, 41, 59, 0.75);
                  backdrop-filter: blur(8px);
                  -webkit-backdrop-filter: blur(8px); /* Pour la compatibilité Safari */
                  padding: 3rem;
                  border-radius: 1rem;
                  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
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
          <!-- Icône SVG de l'engrenage -->
          <svg class="gear-background" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
              <path d="M93.3,47.8 l-8.9-1.3c-0.5-2.6-1.3-5.1-2.4-7.4l5.4-7.2c0.8-1.1,0.7-2.6-0.3-3.6l-5.6-5.6 c-1-1-2.6-1.1-3.6-0.3l-7.2,5.4c-2.3-1.1-4.8-1.9-7.4-2.4l-1.3-8.9c-0.2-1.4-1.4-2.4-2.8-2.4h-7.9c-1.4,0-2.6,1-2.8,2.4l-1.3,8.9 c-2.6,0.5-5.1,1.3-7.4,2.4l-7.2-5.4c-1.1-0.8-2.6-0.7-3.6,0.3l-5.6,5.6c-1,1-1.1,2.6-0.3,3.6l5.4,7.2c-1.1,2.3-1.9,4.8-2.4,7.4 l-8.9,1.3c-1.4,0.2-2.4,1.4-2.4,2.8v7.9c0,1.4,1,2.6,2.4,2.8l8.9,1.3c0.5,2.6,1.3,5.1,2.4,7.4l-5.4,7.2c-0.8,1.1-0.7,2.6,0.3,3.6 l5.6,5.6c1,1,2.6,1.1,3.6,0.3l7.2-5.4c2.3,1.1,4.8,1.9,7.4,2.4l1.3,8.9c0.2,1.4,1.4,2.4,2.8,2.4h7.9c1.4,0,2.6-1,2.8-2.4l1.3-8.9 c2.6-0.5,5.1-1.3,7.4-2.4l7.2,5.4c1.1,0.8,2.6,0.7,3.6-0.3l5.6-5.6c1-1,1.1-2.6,0.3-3.6l-5.4-7.2c1.1-2.3,1.9-4.8,2.4-7.4l8.9-1.3 c1.4-0.2,2.4-1.4,2.4-2.8v-7.9C95.7,49.2,94.7,48,93.3,47.8z M50,67.5c-9.7,0-17.5-7.8-17.5-17.5S40.3,32.5,50,32.5 S67.5,42.3,67.5,50S59.7,67.5,50,67.5z"/>
          </svg>
          
          <div class="card">
              <h1>Backend NestJS</h1>
              <p>Tous les systèmes sont opérationnels.</p>
              <div class="status">● Online</div>
          </div>
      </body>
      </html>
    `;
  }
}