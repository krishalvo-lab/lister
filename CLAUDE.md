# lister (app)

Statisk app uten byggesteg: `index.html`, `style.css`, `app.js`, ikoner og `manifest.webmanifest`. Publiseres med GitHub Pages fra `main`, rotmappa.

- Dataformatet er definert i `krishalvo-lab/lister-data/CLAUDE.md`. Endrer du formatet, oppdater både `normalize()` i app.js, CLAUDE.md og `sjekk.py` i datarepoet.
- Lagring er op-basert. `mutate(desc, fn)` endrer lokalt og legger op i køen, og `flush()` gjør PUT med sha. Ved 409 hentes fersk fil og alle op-er spilles av på nytt. Nye endringer skal skrives som idempotente op-er som finner punkter via `id`.
- Stil: samme uttrykk som halvorsenogfjetland.no (Archivo/Inter, --ink #17191C, --ground #F4F2ED, --yellow #F5B800). Status-farger: Ja #C6EFCE, Usikker #FFEB9C, Nei #FFC7CE.
- Mobil først (iPhone, Safari), og trykkflater skal være minst 44 px.
- Test lokalt med Playwright mot en mock av api.github.com før push.
- Deling: `#del=<z|j><base64url>` inneholder hele lista (z = deflate-raw-komprimert JSON, j = rå JSON). Shared view (`S.view='shared'`) lagrer avkrysninger og tillegg i localStorage. «Send tilbake» lager ny lenke med `kilde`, og `mergeShared()` legger til nye punkter og tar med Ja/Usikker på punkter som står som Nei. `dellenke.py` i datarepoet lager samme format.
- Live-deling: `#d/<id>/<kode>` åpner lista via Cloudflare-Workeren (`worker/worker.js`, URL i `WORKER` i app.js). Workeren holder en egen GitHub-nøkkel (secret `GITHUB_TOKEN`) og slipper bare gjennom fila der `del_kode` = kode. Mottakeren kan ikke endre `del_kode`, `type` eller `arkivert`. «Stopp deling» fjerner `del_kode`.
- Git: Kristian vil alltid ha endringer merget. Lag PR, kjør testene, og merge PR-en selv når de er grønne (begge repoer). Ikke spør først.
