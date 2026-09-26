# Boekhouden

Boekhouding voor een studentendispuut: iedereen een eigen rekening, activiteiten verdelen,
maandelijkse debiteurenlijst, en de bank als bron van waarheid. Zie **PLAN.md** voor het
volledige ontwerp en **CLAUDE.md** voor de werkafspraken in de code.

## Prototype: direct proberen, zonder iets te installeren

Het prototype is **één HTML-bestand** (`docs/index.html`) dat alles in de browser doet: geen server,
geen database, geen account, niets te installeren, gratis. De gegevens blijven in de browser op je
eigen computer (met back-up/terugzetten als bestand).

**Openen, manier 1: als website via GitHub Pages (gratis, eenmalig instellen)**
1. Ga op GitHub naar de repository → **Settings** → **Pages**.
2. Bij *Build and deployment* kies je **Source: Deploy from a branch**.
3. Kies de branch `claude/student-association-accounting-5f775g` en de map **`/docs`**, en klik **Save**.
4. Na een minuut staat het prototype op **https://olivierrl19.github.io/Boekhouden/**. Die link kun je delen.

**Openen, manier 2: bestand downloaden**
Open op GitHub `docs/index.html`, klik op **Download raw file** (het pijltje) en dubbelklik het bestand.

Kies dan **Start voorbeelddispuut** om rond te kijken, of maak je eigen dispuut aan. Wissel linksonder
van rol (fiscus, bestuur, kascommissie of een lid) om te zien wat iedereen ziet en mag.

Wat werkt in het prototype:

- **Bank**: ING- of Rabobank-CSV importeren (dubbel importeren boekt niets dubbel, gaten in het saldo worden
  geweigerd), transacties met de hand toevoegen (een latere import herkent ze), toewijzen ("waar
  geboekt") met voorstellen op bekend IBAN, Tikkie en omschrijving, splitsen, ongedaan maken, en een
  lid of externe direct aanmaken vanuit een bankregel.
- **Contributie**: ledenplanning per lid per maand (jongerejaars, buitenland, ouderejaars, nieuwe
  lichting, afwezig), per maand opleggen, zien wie welke maand betaald heeft, alle contributiebetalingen
  in één keer toewijzen, vaste delen per soort lid (woonkamer, bier) en de rest naar een potje, het
  tarief berekenen uit de begroting, en een overschot (geld terug bier) teruggeven naar rato van de maanden.
- **Spaarplannen** per lid en spaardoel (bijv. lustrumreis): inleggen via de bank, zien wie op schema
  ligt, en spaargeld verrekenen met wat iemand moet betalen.
- **Debiteurenlijst** met rekening, contributie, totaal en spaargeld per persoon; maandmail per
  persoon (via je eigen mailprogramma).
- **Activiteiten** met vast nummer (A26-001) en "nog te verdelen"; afrekenen gelijk, naar streepjes, met
  vast bedrag (ook een nieuwe externe direct toevoegen) en dispuutsdeel; aantallen als 0,5 of 1,5; het deel
  van een ander dispuut berekenen (naar aantal, drank 60/40). Klik op een naam of rij om te selecteren.
- **Ledenrekeningen**: een kolom bedragen in één keer boeken (turflijst × prijs, maaltijd, extra bij/af).
- **Externen** met saldo, betaalverzoektekst voor Tikkie/WhatsApp en bedragen op hun rekening zetten.
- **Begroting** met eigen regels per potje, kolom vorig jaar, per regel wie meebetaalt, kopiëren van vorig jaar, verwachte contributie automatisch,
  eigen potjes; **donaties** van oud-leden met overzicht per gever.
- Declaraties met foto van de bon, kasboek, rapportages (balans, resultaat per potje vs begroting,
  vorig jaar), journaal, bestemmingsreserves, memoriaal, boekjaar afsluiten met controlelijst,
  zelfcontrole en logboek met hash-keten, export naar Excel/CSV en afdrukken als PDF.

Prototype opnieuw bouwen na codewijzigingen: `npm run prototype`.

## Volledige versie online zetten (later)

De volledige versie (met inloggen per e-mail en een echte database) staat in `src/app` en draait op Vercel + Neon.

Je hebt niets op je eigen computer nodig. Je gebruikt twee gratis diensten:
**Vercel** (hier draait de website) en **Neon** (hier staat de database). Reken op zo'n 15 minuten.

### 1. Vercel-account en project

1. Ga naar https://vercel.com/signup en kies **Continue with GitHub**. Kies het gratis **Hobby**-abonnement.
2. Klik op **Add New… → Project**, zoek de repository **Boekhouden** en klik op **Import**.
   (Zie je hem niet? Klik op *Adjust GitHub App Permissions* en geef Vercel toegang tot de repository.)
3. Klap **Environment Variables** open en voeg deze twee toe:

   | Name | Value |
   |---|---|
   | `AUTH_SECRET` | een lange willekeurige tekst, bijv. van https://generate-secret.vercel.app/32 |
   | `SETUP_CODE` | een zelfbedachte geheime code (die heb je zo nodig in de wizard) |

4. Klik op **Deploy**. De eerste keer werkt de site nog niet, want er is nog geen database. Dat is normaal.

### 2. Gratis database koppelen

1. Ga in je Vercel-project naar het tabblad **Storage** en klik op **Create Database**.
2. Kies **Neon** (Serverless Postgres), accepteer, kies het gratis plan (**Free**) en een regio
   in Europa (bijv. Frankfurt), en klik op **Create**.
3. Laat **Connect to project** aangevinkt voor alle omgevingen. Vercel zet dan zelf `DATABASE_URL` klaar.

### 3. Opnieuw deployen

Ga naar **Deployments**, klik bij de bovenste op **⋯ → Redeploy**. Tijdens het bouwen wordt de
database automatisch klaargezet.

### 4. Dispuut inrichten

1. Open je site (de link staat bovenaan in Vercel, iets als `https://boekhouden-xxx.vercel.app`).
2. Je komt vanzelf in de **installatiewizard**. Vul je installatiecode (`SETUP_CODE`) in, de naam van het
   dispuut, jouw gegevens als fiscus, de contributie en de saldi van de rekeningen op de startdatum.
3. Na **Dispuut inrichten** ben je meteen ingelogd als fiscus.

Eerst rondkijken? Kies in de wizard **Voorbeelddispuut laden** (duurt ongeveer een minuut). Je bent dan
ingelogd als de fiscus van het voorbeeld. Klaar met kijken? Bovenaan staat een link om het voorbeeld te
wissen en daarna je eigen dispuut in te richten.

### 5. E-mail instellen (nodig zodat leden kunnen inloggen)

Inloggen gaat met een link per e-mail. Gratis via Gmail:

1. Zet bij je Google-account **tweestapsverificatie** aan: https://myaccount.google.com/security
2. Maak een **app-wachtwoord** aan: https://myaccount.google.com/apppasswords (naam bijv. "Boekhouding").
   Je krijgt 16 letters.
3. Voeg in Vercel (**Settings → Environment Variables**) toe:

   | Name | Value |
   |---|---|
   | `EMAIL_SERVER` | `smtps://jouwnaam%40gmail.com:APPWACHTWOORD@smtp.gmail.com:465` (het `@` in je adres wordt `%40`, app-wachtwoord zonder spaties) |
   | `EMAIL_FROM` | `Fiscus Dispuut <jouwnaam@gmail.com>` |

4. **Redeploy** (zoals bij stap 3).

Zonder e-mail blijft de site werken voor jou (je bent ingelogd na de wizard, 30 dagen lang), maar kan
niemand anders inloggen.

### Updates

Elke keer dat er nieuwe code op GitHub komt, zet Vercel die automatisch online en werkt de database bij.

## Voor ontwikkelaars

Lokaal draaien kan met elke Postgres-database (bijv. een tweede gratis Neon-database):

```bash
cp .env.example .env        # vul DATABASE_URL, AUTH_SECRET en SETUP_CODE in
npm install
npm run db:migrate
npm run dev                 # http://localhost:3000 → wizard
npm test                    # heeft DATABASE_URL_TEST nodig (een aparte, lege database)
```

Op Windows geeft PowerShell soms "running scripts is disabled"; gebruik dan `npm.cmd` in plaats van `npm`,
of de gewone Opdrachtprompt (cmd).

## Status

- **Prototype** (`docs/index.html`): alle kernfuncties werkend in de browser, om te laten zien en te testen.
- **Volledige versie** (`src/app`): bouwstappen a (schema, inloggen, rollen) en b (boekingsmotor met
  databasecontroles) en de installatiewizard. De Rabobank-CSV-lezer en de voorstellen zijn gedeeld met
  het prototype. Zie PLAN.md §14 voor de rest.
