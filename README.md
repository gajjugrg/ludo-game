Ludo — Simple Browser Game

## How to run
1) Open `index.html` directly in your browser (double-click) or serve the folder with any static server.
2) Click **New Game**, pick player count (2/3/4), and optionally toggle AI for Player 2.
3) Press **Roll**, then click a highlighted token to move. Status appears in the right panel.
4) Finished tokens land in the basket; home areas are highlighted for the active player.

Tip: For multiplayer, open via the server URL (below) so WebSockets work reliably.

## Online multiplayer (rooms)
This project includes a very small WebSocket relay server used only to sync game state between browsers.

Terminology:
- A **Session** is a shared game code that multiple browsers join.

### Run online mode locally (same Wi‑Fi / same machine)
1) Install dependencies: `npm install`
2) Start the relay server: `npm start`
	 - Default WebSocket port is `22002`.
   - If you get `EADDRINUSE` (port busy), run: `PORT=22003 npm start`
3) Open the game URL:
	- Same computer: `http://localhost:22002/` (or whatever port you used)
	- Other phone/laptop on your Wi‑Fi: `http://<YOUR-MAC-IP>:22002/` (or whatever port you used)
	  - Find your Mac IP (Wi‑Fi): `ipconfig getifaddr en0`
4) Open the game in 2+ browsers/devices:
	- Enter a **Session** code (any short text)
	- Enter your **Name**
	- Click **Join**
5) The **host** is whichever browser joins first:
	- Only the host can set **Players** and start **New Game**.
	- Everyone else simply joins the session; they do NOT answer “how many players”.

Notes:
- Each browser tab gets its own player seat (per-tab identity). If you previously tested and both tabs showed the same "I'm" player, reload both tabs after updating.
- The Players list and the “You” dropdown will show usernames in online sessions.

### Why it may not work “online” by default
- If you open the game on a different computer, `ws://localhost:22002` would point to *their own machine*, not yours.
- If you host the page on `https://...`, browsers will block `ws://...` (mixed content). You must use `wss://...`.

### Deploying for real internet play
- Host the WebSocket relay on a public server (Render/Fly/VPS/etc) and expose it via `wss://YOUR_DOMAIN`.
- Set `window.LUDO_WS_URL` before loading `script.js` (or edit the default in `script.js`). Example:
	- Add in `index.html` `<head>`:
		`window.LUDO_WS_URL = 'wss://YOUR_DOMAIN';`

## Debug tools
- Debug tools are intended for local development.
- Force rolls, move tokens, jump to finish, undo moves, pause AI, and force turn.
- Move log visible/copyable from the debug panel; also exposed as `window.moveLog` in the console.

Security note:
- This repo does not ship with a public debug password. If you host this publicly and still want debug tools, set `window.LUDO_DEBUG_PASSWORD` privately (not committed) before loading `script.js`.

## Notes and rules
- Exact rolls required to finish; triple-six forfeits the turn. Safe squares (shields/stars) cannot be captured.
- Start squares are colored; finished tokens stay in the external basket.
- Block rule is disabled (tokens don’t form blocking walls).
- AI currently available for Player 2 only.
- Sounds: dice rolls and finishing a token play lightweight synthesized sounds (Web Audio).
- UI: status is shown in the right panel, home highlight for active player, stacked tokens spread on safe tiles for easier selection.




Enjoy! 🎲
