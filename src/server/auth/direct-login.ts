import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getDb, schema } from "../db";

/**
 * Start an Auth.js database session for a user without an e-mail round trip. Used exactly once:
 * right after the setup wizard, so the new fiscus is logged in even before e-mail is configured.
 * Cookie name and flags match Auth.js defaults.
 */
export async function startSessionFor(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await getDb().insert(schema.sessions).values({ sessionToken: token, userId, expires });
  const h = await headers();
  const secure = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
  (await cookies()).set(secure ? "__Secure-authjs.session-token" : "authjs.session-token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires,
  });
}
