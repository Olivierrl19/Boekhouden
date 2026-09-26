import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function CheckEmailPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Check je mail</CardTitle>
          <CardDescription>
            Als je e-mailadres bekend is, staat er nu een inloglink in je inbox. De link is een uur geldig.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className="text-sm underline underline-offset-4">
            Terug
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
