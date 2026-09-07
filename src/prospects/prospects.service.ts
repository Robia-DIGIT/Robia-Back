import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { N8nWebhookService } from '../integrations/n8n-webhook.service';
import { CreateProspectDto } from './dto/create-prospect.dto';

const ACCEPTED_RESPONSE = {
  message:
    'Votre demande a bien été reçue. Notre équipe vous répondra rapidement.',
};

interface RateWindow {
  count: number;
  resetAt: number;
}

@Injectable()
export class ProspectsService {
  private readonly attempts = new Map<string, RateWindow>();
  private readonly windowMs = 15 * 60 * 1000;
  private readonly maximumAttempts = 5;

  constructor(private readonly webhooks: N8nWebhookService) {}

  async submit(dto: CreateProspectDto, clientAddress: string) {
    if (dto.website?.trim()) {
      return ACCEPTED_RESPONSE;
    }

    this.consumeAttempt(clientAddress);

    const delivered = await this.webhooks.notifyProspectCreated({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      company: dto.company,
      message: dto.message,
    });

    if (!delivered) {
      throw new ServiceUnavailableException(
        'Le formulaire est temporairement indisponible. Réessayez dans quelques minutes.',
      );
    }

    return ACCEPTED_RESPONSE;
  }

  private consumeAttempt(clientAddress: string) {
    const now = Date.now();
    const current = this.attempts.get(clientAddress);

    if (!current || current.resetAt <= now) {
      this.attempts.set(clientAddress, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      this.removeExpiredWindows(now);
      return;
    }

    if (current.count >= this.maximumAttempts) {
      throw new HttpException(
        'Trop de demandes. Réessayez dans quelques minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    current.count += 1;
  }

  private removeExpiredWindows(now: number) {
    if (this.attempts.size < 1000) {
      return;
    }

    for (const [key, value] of this.attempts) {
      if (value.resetAt <= now) {
        this.attempts.delete(key);
      }
    }
  }
}
