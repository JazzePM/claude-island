# Claude Island

En Dynamic Island-inspirerad statusbar för Windows som visar hur mycket av dina Claude-gränser du har förbrukat.

- **Kompakt läge:** sessionsförbruk (5 h) och veckoförbruk med färgkodad ring, överst i mitten av skärmen.
- **Klicka** för att fälla ut: session, veckogräns för alla modeller och per modell (t.ex. Fable), med nedräkning till när de återställs.
- **Minimera till systemfältet:** ön försvinner och en liten färgad bricka med sessionsprocenten visas i systemfältet. Klicka på brickan för att visa ön igen.
- **Projektdocka:** håll musen över ön så glider dina projekt (mappar i `~/Projects`) ut bredvid den. Klicka på ett projekt för att öppna det i VS Code med Claude Code igång.
- **Lossa ön:** högerklick → "Lossa ön" och dra den dit du vill, t.ex. bort från webbläsarens flikar.
- **Startar med Windows** (kan stängas av i högerklicksmenyn).

## Installera

Ladda ner `Claude Island Setup <version>.exe` från [Releases](../../releases/latest) och kör den.
Installeraren är inte signerad, så Windows SmartScreen kan varna: klicka **Mer info → Kör ändå**.

Kräver att [Claude Code](https://claude.com/claude-code) är installerat och inloggat på datorn.

## Projektdockan

- Projekt = undermappar i `%USERPROFILE%\Projects` med `.git`, `package.json` eller `pubspec.yaml`, sorterade efter senaste git-aktivitet.
- Ikonen hämtas från projektet (favicon, `icon.svg`, appikon m.m.), annars visas initialer.
- Har två projekt samma förled (t.ex. *LILO App* och *LILO Portal*) visas ett litet märke för typen: webb, app eller skrivbordsapp.
- Första gången ett projekt öppnas skapas `.vscode/tasks.json` som startar `claude` när mappen öppnas i VS Code. Filen läggs i `.git/info/exclude` och hamnar aldrig i repot.

Rekommenderade VS Code-inställningar för att Claude Code ska öppnas som en flik i redigeringsytan:

```json
"task.allowAutomaticTasks": "on",
"workbench.startupEditor": "none",
"workbench.secondarySideBar.defaultVisibility": "hidden",
"terminal.integrated.defaultLocation": "editor",
"terminal.integrated.enablePersistentSessions": false,
"terminal.integrated.hideOnStartup": "always"
```

## Kom igång

Kräver Node.js och att du är inloggad i [Claude Code](https://claude.com/claude-code).

```
npm install
npm start        # kör i utvecklingsläge
npm run dist     # bygger installeraren: dist/Claude Island Setup <version>.exe
```

Installeraren installerar appen per användare (ingen administratör behövs) under
`%LOCALAPPDATA%\Programs\claude-island` och lägger till den i Startmenyn.
Installeraren är inte signerad, så SmartScreen kan varna på andra datorer.

Appikonen ritas av `npm run icon` (`build/make-icon.js`).

> **Om bygget stoppar på "Cannot create symbolic link"**: packa upp
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<nummer>.7z` till mappen
> `winCodeSign-2.6.0` i samma katalog och hoppa över `darwin`-mappen, t.ex.
> `7za x <arkiv>.7z -owinCodeSign-2.6.0 -xr!darwin`.

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

Fel loggas till `%APPDATA%\Claude Island\island.log` (installerad app) eller `island.log` i projektmappen (utvecklingsläge).
