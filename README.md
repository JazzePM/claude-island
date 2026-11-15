# Claude Island

En Dynamic Island-inspirerad statusbar för Windows som visar hur mycket av dina Claude-gränser du har förbrukat.

- **Kompakt läge:** sessionsförbruk (5 h) och veckoförbruk med färgkodad ring, överst i mitten av skärmen.
- **Klicka** för att fälla ut: session, veckogräns för alla modeller och per modell (t.ex. Fable), med nedräkning till när de återställs.
- **Minimera till systemfältet:** ön försvinner och en liten färgad bricka med sessionsprocenten visas i systemfältet. Klicka på brickan för att visa ön igen.
- **Startar med Windows** (kan stängas av i högerklicksmenyn).

## Kom igång

Kräver Node.js och att du är inloggad i [Claude Code](https://claude.com/claude-code).

```
npm install
npm start
```

## Hur det fungerar

Appen läser Claude Codes inloggning i `~/.claude/.credentials.json` och hämtar förbrukningen från samma endpoint som `/usage` i Claude Code använder. Token skickas bara till Anthropic och sparas aldrig av appen. Om inloggningen har gått ut: starta Claude Code en gång så förnyas den.

Uppdateras varannan minut och när du fäller ut ön.

## Användning

| Åtgärd | Gör |
|---|---|
| Klick på ön | Fäll ut / fäll ihop |
| Esc eller klick utanför | Fäll ihop |
| Högerklick på ön eller brickan | Meny: minimera/visa, uppdatera, starta med Windows, avsluta |
| Klick på brickan i systemfältet | Visa / minimera ön |

Fel loggas till `island.log` i projektmappen.
