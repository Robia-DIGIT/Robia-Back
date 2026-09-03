import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';

@Injectable()
export class PasswordResetMailService {
  private readonly logger = new Logger(PasswordResetMailService.name);

  constructor(private readonly config: ConfigService) {}

  async sendPasswordReset(email: string, token: string) {
    const host = this.required('SMTP_HOST');
    const port = Number(this.config.get<string>('SMTP_PORT', '465'));
    const secure = this.config.get<string>('SMTP_SECURE', 'true') === 'true';
    const username = this.required('SMTP_USERNAME');
    const password = this.required('SMTP_PASSWORD');
    const from = this.config.get<string>('SMTP_FROM', username);
    const resetUrl = this.required('PASSWORD_RESET_URL');

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InternalServerErrorException('Configuration SMTP invalide');
    }

    const link = new URL(resetUrl);
    link.searchParams.set('token', token);

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user: username, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    await transporter.sendMail({
      from: `ROBIA Copilot <${from}>`,
      to: email,
      subject: 'Réinitialisation de votre mot de passe ROBIA',
      text: [
        'Une demande de réinitialisation de votre mot de passe ROBIA a été reçue.',
        '',
        `Choisissez un nouveau mot de passe : ${link.toString()}`,
        '',
        'Ce lien expire dans 15 minutes et ne peut être utilisé qu’une seule fois.',
        'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.',
      ].join('\n'),
      html: `<p>Une demande de réinitialisation de votre mot de passe ROBIA a été reçue.</p><p><a href="${link.toString()}">Choisir un nouveau mot de passe</a></p><p>Ce lien expire dans 15 minutes et ne peut être utilisé qu’une seule fois.</p><p>Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.</p>`,
    });

    this.logger.log('Password reset email accepted by SMTP');
  }

  private required(name: string) {
    const value = this.config.get<string>(name)?.trim();
    if (!value) {
      throw new InternalServerErrorException('Configuration SMTP incomplète');
    }
    return value;
  }
}
