import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getServerStatus() {
    return {
      status: 'success',
      message: 'Le serveur backend est parfaitement opérationnel niggas',
      timestamp: new Date().toISOString(),
    };
  }
}