import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { getCurrentUser } from "@/server/auth/roles";
import { getSettings } from "@/server/services/setup";
import { getDb } from "@/server/db";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function requestLink(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) redirect("/login?error=missing");
  try {
    await signIn("nodemailer", { email, redirectTo: "/" });
  } catch (err) {
    // signIn throws a redirect on success. An unknown address is refused by the signIn
    // callback; we still show "check je mail" so the login page doesn't reveal who is a member.
    if (err instanceof AuthError) redirect("/login/check");
    throw err;
  }
}

const MESSAGES: Record<string, string> = {
  AccessDenied: "Inloggen is niet gelukt. Vraag de fiscus of je e-mailadres goed in de ledenlijst staat.",
  Verification: "Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.",
  missing: "Vul je e-mailadres in.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const settings = await getSettings(getDb());
  if (!settings?.setupCompleted) redirect("/setup");
  if (await getCurrentUser()) redirect("/");
  const { error } = await searchParams;
  const message = typeof error === "string" ? (MESSAGES[error] ?? "Inloggen is niet gelukt. Probeer het opnieuw.") : null;
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Inloggen</CardTitle>
          <CardDescription>Je krijgt een inloglink per e-mail. Geen wachtwoord nodig.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={requestLink} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">E-mailadres</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required placeholder="naam@voorbeeld.nl" />
            </div>
            {message && <p className="text-sm text-red-600">{message}</p>}
            <Button type="submit">Stuur inloglink</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
