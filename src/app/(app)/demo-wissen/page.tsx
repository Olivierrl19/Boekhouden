import { redirect } from "next/navigation";
import { requireCapability } from "@/server/auth/roles";
import { getSettings } from "@/server/services/setup";
import { getDb } from "@/server/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/submit-button";
import { wipeDemoAction } from "../../setup/actions";

export default async function WipeDemoPage({ searchParams }: PageProps<"/demo-wissen">) {
  await requireCapability("admin");
  const settings = await getSettings(getDb());
  if (!settings?.isDemo) redirect("/");
  const { fout } = await searchParams;
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Voorbeelddispuut wissen</CardTitle>
        <CardDescription>
          Alle voorbeeldgegevens worden verwijderd en je gaat naar de installatiewizard om je eigen dispuut in te richten.
          Dit kan alleen bij het voorbeelddispuut; een echte boekhouding kan nooit gewist worden.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={wipeDemoAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">Installatiecode</Label>
            <Input id="code" name="code" type="password" required />
          </div>
          {typeof fout === "string" && <p className="text-sm text-red-600">{fout}</p>}
          <SubmitButton variant="destructive" pendingText="Bezig met wissen…">Wis alles en begin opnieuw</SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
