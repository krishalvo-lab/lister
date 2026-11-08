# Lister – overlevering til Claude Code

Kristians egen app for handlelister, huskelister, pakkelister og ønskelister. Den er bygget 3. nov. 2026 i en Claude-økt.
Brukere: Kristian, kjæresten Iris og alle de deler lister med. Alle har iPhone. Kristian bruker også en Windows-PC (MSI).

## Arkitektur

```
 iPhone/PC (app)                       Mottaker av delelenke (ingen nøkkel)
     │ GitHub API + egen token              │ #d/<id>/<kode>
     ▼                                      ▼
 ┌────────────────────┐            ┌──────────────────────────────┐
 │ krishalvo-lab/     │◀───────────│ Cloudflare Worker            │
 │ lister-data (priv) │  token i   │ lister-del.krishalvo.        │
 │ lister/<id>.json   │  secret    │ workers.dev                  │
 └────────────────────┘            └──────────────────────────────┘
     ▲
     │ git (Claude leser/skriver direkte)
 Claude
```

| Del | Hvor | Merknad |
|---|---|---|
| App (statisk, uten byggesteg) | `krishalvo-lab/lister` (public) → https://krishalvo-lab.github.io/lister/ | GitHub Pages fra `main`, rot. `index.html`, `style.css`, `app.js`, `manifest.webmanifest`, ikoner |
| Data | `krishalvo-lab/lister-data` (privat) | Én JSON-fil per liste i `lister/`. Format og regler står i `lister-data/CLAUDE.md` |
| Delings-Worker | Cloudflare, Worker `lister-del`, kode i `lister/worker/worker.js` | Secret `GITHUB_TOKEN` (fine-grained, kun lister-data, Contents RW). Gratisplan: 100 000 kall/døgn |
| Validering | `lister-data/sjekk.py` | Kjøres før hver commit i datarepoet |
| Delelenker fra CLI | `lister-data/dellenke.py <id>` (kopi) / `--live <id>` | Samme format som appen |

## Funksjoner (alle testet med Playwright)

- **Listetyper:** handleliste (avdelinger i rekkefølge gjennom butikken, felt for butikk), huskeliste, pakkeliste og ønskeliste (prioritet som gruppe, lenke i merknad blir «Åpne ↗»-knapp).
- **Punkt:** status Nei/Ja/Usikker (trykk for å bytte), vare, mengde, brukes i, merknad og butikk. Punktene grupperes etter avdeling, og oppsummeringen nederst viser totalt, ferdig, mangler og usikker.
- **Endringshistorikk:** hvert punkt lagrer `endret_av` og `endret` og viser «Navn · tid siden».
- **Legge til:** hurtigfelt med avdeling, eller fullt skjema. Punkter kan endres og fjernes.
- **Menyen ⋯:** del live, del kopi, stopp deling, nytt navn, kopier som tekst (SMS), alt tilbake til Nei, fjern alt som er Ja, lag kopi, arkiver, slett.
- **Sortering:** i handlelister med butikk kan du gruppere etter avdeling eller butikk og filtrere på én butikk (chips, lagres per enhet). Oppsummeringen følger filteret. Lister har `kategori` (Mat, Bygg, Hjem, Reise, Annet), og forsiden kan filtreres på kategori.
- **Synk:** polling hvert 12. sekund (30 s på forsiden) med ETag. Lagring er op-basert: `mutate()` legger op i kø, og `flush()` gjør PUT med sha. Ved 409 hentes fersk fil og op-ene spilles av på nytt, så samtidige endringer slås sammen.
- **Innlogging:** fine-grained GitHub-token per enhet, lagret i localStorage. Oppsettsiden forklarer hvordan nøkkelen lages.
- **Live-deling** `#d/<id>/<kode>`: lista får `del_kode`. Mottakeren redigerer samme fil via Workeren, oppgir et navn (gjestenavn) og ser endringer fra andre. Workeren slipper bare gjennom fila med riktig kode, og mottakeren kan ikke endre `del_kode`, `type` eller `arkivert`. «Stopp deling» fjerner koden, og lenken dør med en gang.
- **Kopi-deling** `#del=<z|j><base64url>`: hele lista ligger komprimert i lenken (deflate-raw). Mottakerens endringer lagres lokalt. «Send tilbake» lager en ny lenke med `kilde`, og eieren kan slå den inn med `mergeShared()` eller lagre den som ny liste.
- **Hjemskjerm:** PWA-manifest og apple-touch-icon. Legg siden til på hjemskjermen *før* du kobler til, fordi iOS kan gi hjemskjerm-appen egen lagring.

## Stil

Samme uttrykk som halvorsenogfjetland.no: Archivo/Inter, `--ink #17191C`, `--ground #F4F2ED`, `--yellow #F5B800`. Status-farger: Ja `#C6EFCE`, Usikker `#FFEB9C`, Nei `#FFC7CE`. Avdelingsrader `#D9E1F2`. Siden er laget for mobil først, med trykkflater på minst 44 px.

## Test

```bash
cd lister && python3 -m http.server 8765 &
node tests/app.test.cjs      # oppsett, liste, hurtigtillegg, konflikt-sammenslåing, kopi-deling + merge
node tests/live.test.mjs     # live-deling med den ekte worker.js mot mock-GitHub
```
Begge mocker `api.github.com` i minnet (Playwright route). `live.test.mjs` kjører den ekte `worker/worker.js` og overstyrer Worker-URL med `window.LISTER_WORKER`.
Bump `?v=N` på `app.js`/`style.css` i `index.html` ved hver endring, siden GitHub Pages cacher i 10 min.

## Regler for innhold (fra Kristian)

Bare det han ber om, ingen ekstra verktøy eller utstyr. Ukjent mengde skrives som `"?"` med merknaden «Sjekk». Pris bare når den er slått opp. Nye punkter får status Nei. Detaljer står i `lister-data/CLAUDE.md`. Lister lages alltid i appen (ikke xlsx eller artifact), og svaret skal inneholde lenken `https://krishalvo-lab.github.io/lister/#/<id>`.

## Kjente begrensninger / mulige neste steg

- **Sortering:** i handlelister med butikk kan du gruppere etter avdeling eller butikk og filtrere på én butikk (chips, lagres per enhet). Oppsummeringen følger filteret. Lister har `kategori` (Mat, Bygg, Hjem, Reise, Annet), og forsiden kan filtreres på kategori.
- **Synk:** polling med ca. 12 s forsinkelse, ikke ekte push. Ekte sanntid krever Durable Objects/WebSocket i Workeren.
- **Kopi-deling** synker ikke. Den er ment for de som bare skal ha en egen kopi.
- **Nøkler:** hver enhet trenger sin egen token. Det finnes ingen brukerkontoer.
- **Offline:** ingen offline-støtte (ingen service worker). Uten nett lagres ingenting.
- **Workeren** bruker én felles token. Roterer du den, må den inn på nytt som secret i Cloudflare.
- **Dataopprydding:** `lister-data/lister/1.json` er en testliste Kristian laget. Slett den bare hvis han ber om det.
- **Ikke laget ennå:** endre rekkefølge på avdelinger og punkter, angre siste endring, egne avdelingslister per butikk, varsler.
