# Lister

Handlelister, huskelister, pakkelister og ønskelister for husstanden: https://krishalvo-lab.github.io/lister/

- Statisk side (HTML/CSS/JS uten byggesteg) på GitHub Pages.
- Dataene ligger i det private repoet `krishalvo-lab/lister-data`, én JSON-fil per liste.
- Hver telefon kobler til med en fine-grained token (*Contents: Read and write* på `lister-data`), som lagres lokalt på enheten.
- Endringer lagres som commits. Siden ser etter endringer fra andre hvert 12. sekund og slår sammen samtidige endringer.

Legg til på hjemskjermen: åpne siden i Safari → Del → «Legg til på Hjem-skjerm».
