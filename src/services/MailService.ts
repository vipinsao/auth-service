import nodemailer, { type Transporter } from "nodemailer";
import { Config } from "../config/index.js";
import logger from "../config/logger.js";

export interface SentMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Messages captured by the JSON transport. This is the outbox used by local
 * development and by the integration tests, which assert on the reset link
 * without needing an SMTP server. It stays empty for the smtp/ethereal
 * transports.
 */
const outbox: SentMessage[] = [];
export const getOutbox = (): readonly SentMessage[] => outbox;
export const clearOutbox = () => {
  outbox.length = 0;
};

let transporter: Transporter | undefined;

/**
 * Three transports, all free:
 *  - `json`     (default) writes the message to the log and the in-memory outbox
 *  - `ethereal` creates a throwaway Ethereal inbox and logs a preview URL
 *  - `smtp`     any real SMTP server, configured through SMTP_* env vars
 */
const getTransporter = async (): Promise<Transporter> => {
  if (transporter) return transporter;

  if (Config.MAIL_TRANSPORT === "smtp") {
    transporter = nodemailer.createTransport({
      host: Config.SMTP_HOST,
      port: Config.SMTP_PORT,
      secure: Config.SMTP_SECURE,
      auth:
        Config.SMTP_USER && Config.SMTP_PASSWORD
          ? { user: Config.SMTP_USER, pass: Config.SMTP_PASSWORD }
          : undefined,
    });
  } else if (Config.MAIL_TRANSPORT === "ethereal") {
    const account = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    logger.info("Ethereal test mailbox created", { user: account.user });
  } else {
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }

  return transporter;
};

export class MailService {
  async send(to: string, subject: string, text: string): Promise<void> {
    const mailer = await getTransporter();
    const info = await mailer.sendMail({
      from: Config.MAIL_FROM,
      to,
      subject,
      text,
    });

    if (Config.MAIL_TRANSPORT === "json") {
      outbox.push({ to, subject, text });
      logger.info("Mail captured by json transport", { to, subject });
    }
    if (Config.MAIL_TRANSPORT === "ethereal") {
      logger.info("Mail sent", {
        to,
        subject,
        preview: nodemailer.getTestMessageUrl(info),
      });
    }
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const url = `${Config.APP_BASE_URL}/reset-password?token=${token}`;
    await this.send(
      to,
      "Reset your password",
      `Use this link within ${Config.VERIFICATION_TOKEN_TTL_MINUTES} minutes to choose a new password:\n\n${url}\n\nIf you did not ask for this, ignore this email.`,
    );
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    const url = `${Config.APP_BASE_URL}/verify-email?token=${token}`;
    await this.send(
      to,
      "Verify your email address",
      `Confirm your email address within ${Config.VERIFICATION_TOKEN_TTL_MINUTES} minutes:\n\n${url}`,
    );
  }
}
