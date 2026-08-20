import nodemailer, { type Transporter } from "nodemailer";
import { Config } from "../config/index.js";
import logger from "../config/logger.js";
import { withSpan } from "../config/telemetry.js";

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

/**
 * The outbox is a debugging aid, not storage, and it used to grow without
 * limit - one entry per mail for the lifetime of the process, each holding the
 * full body including a live password-reset link. Keeping the most recent
 * messages is all the tests or a developer ever look at.
 */
const OUTBOX_LIMIT = 100;

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

  // Said once, at the point the first mail is actually attempted. The default
  // transport delivers nothing, which means password reset and email
  // verification silently do not work in the default configuration - fine for
  // local work and a broken security flow anywhere else.
  if (Config.MAIL_TRANSPORT === "json" && !Config.IS_TEST) {
    logger.warn(
      "MAIL_TRANSPORT=json: mail is logged, not delivered. Password reset and " +
        "email verification links will not reach anyone. Set MAIL_TRANSPORT to " +
        "ethereal or smtp to send for real.",
    );
  }

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
    // Traced because both callers wrap it in a try/catch that swallows the
    // failure - registration must not fail because the mail server is down.
    // The span is then the only surviving evidence that a verification email
    // was never sent, and the recipient address is deliberately NOT an
    // attribute: telemetry leaves the box, and "who registered" is not a
    // question the trace backend needs to be able to answer.
    const info = await withSpan(
      "mail.send",
      { "mail.transport": Config.MAIL_TRANSPORT },
      async () => {
        const mailer = await getTransporter();
        return mailer.sendMail({ from: Config.MAIL_FROM, to, subject, text });
      },
    );

    if (Config.MAIL_TRANSPORT === "json") {
      outbox.push({ to, subject, text });
      if (outbox.length > OUTBOX_LIMIT) outbox.shift();
      logger.info("Mail captured by json transport - not delivered", {
        to,
        subject,
      });
    }
    if (Config.MAIL_TRANSPORT === "ethereal") {
      // The preview URL opens the message itself, so for a password reset it is
      // a working reset link sitting in the log. Ethereal is a local-only
      // convenience, so the URL is logged only where that is what it is for.
      logger.info("Mail sent", {
        to,
        subject,
        ...(Config.IS_LOCAL
          ? { preview: nodemailer.getTestMessageUrl(info) }
          : {}),
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
