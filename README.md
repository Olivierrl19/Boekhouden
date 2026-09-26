# Boekhouden

Boekhouding voor een studentendispuut: iedereen een eigen rekening, activiteiten verdelen,
maandelijkse debiteurenlijst, en de bank als bron van waarheid. Zie **PLAN.md** voor het
volledige ontwerp en **CLAUDE.md** voor de werkafspraken in de code.

## Lokaal starten

```bash
cp .env.example .env
docker compose up -d        # Postgres, Mailpit, MinIO
npm install
npm run db:migrate
npm run db:seed             # voorbeelddispuut (wist de database!)
npm run dev
```

Open http://localhost:3000 en log in met bijvoorbeeld `sanne@dispuut-demo.nl` (fiscus),
`daan@dispuut-demo.nl` (bestuur), `thijs@dispuut-demo.nl` (kascommissie) of
`koen@dispuut-demo.nl` (lid). De inloglink staat in Mailpit (http://localhost:8025), of in de
console als `EMAIL_SERVER` leeg is.

## Tests

```bash
npm test            # unit + database + property-based tests
npm run test:unit   # alleen de pure tests (geen database nodig)
```

## Status

Bouwstappen a (schema, auth, rollen, seed) en b (boekingsmotor met invarianten) zijn klaar.
Zie PLAN.md §14 voor de volgende stappen.
