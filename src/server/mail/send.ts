import { createTransport } from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an e-mail through any SMTP server (EMAIL_SERVER, e.g. smtp://user:pass@smtp.gmail.com:587,
 * Brevo free tier, or Mailpit locally on smtp://localhost:1025). Without EMAIL_SERVER the message
 * is printed to the server console, which is enough for local development.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  const server = process.env.EMAIL_SERVER;
  const from = process.env.EMAIL_FROM ?? "Boekhouding <no-reply@localhost>";
  if (!server) {
    console.log(`\n[mail] Aan: ${message.to}\n[mail] Onderwerp: ${message.subject}\n${message.text}\n`);
    return;
  }
  const transport = createTransport(server);
  const result = await transport.sendMail({ from, ...message });
  const failed = [...(result.rejected ?? []), ...(result.pending ?? [])];
  if (failed.length) throw new Error(`E-mail kon niet worden verstuurd naar ${failed.join(", ")}`);
}
