import NextAuth from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { sendMail } from "@/server/mail/send";

/**
 * E-mail magic link login. Only addresses that already exist as a user (created for every
 * member with an e-mail address, or added by the fiscus) can sign in.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: schema.users,
    accountsTable: schema.authAccounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  session: { strategy: "database", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login", verifyRequest: "/login/check", error: "/login" },
  providers: [
    Nodemailer({
      server: process.env.EMAIL_SERVER || "smtp://localhost:1025",
      from: process.env.EMAIL_FROM ?? "Boekhouding <no-reply@localhost>",
      maxAge: 60 * 60,
      async sendVerificationRequest({ identifier, url }) {
        await sendMail({
          to: identifier,
          subject: "Inloggen bij de boekhouding",
          text: `Klik op de link om in te loggen (1 uur geldig):\n\n${url}\n\nHeb je dit niet aangevraagd? Dan kun je deze mail negeren.`,
          html: `<p>Klik op de knop om in te loggen (1 uur geldig):</p><p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#18181b;color:#fff;border-radius:6px;text-decoration:none">Inloggen</a></p><p style="color:#71717a;font-size:12px">Heb je dit niet aangevraagd? Dan kun je deze mail negeren.</p>`,
        });
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.trim().toLowerCase();
      if (!email) return false;
      const [existing] = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
      return !!existing;
    },
    async session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
}));
