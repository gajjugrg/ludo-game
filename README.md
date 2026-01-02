Ludo — Simple Browser Game

## How to run
1) Open `index.html` directly in your browser (double-click) or serve the folder with any static server.
2) Click **New Game**, pick player count (2/3/4), and optionally toggle AI for Player 2.
3) Press **Roll**, then click a highlighted token to move. Status prompts show in the center overlay.
4) Finished tokens land in the basket; home areas are highlighted for the active player.

## Debug tools
- Unlock with password `admin` (button or press Enter in the password box).
- Force rolls, move tokens, jump to finish, undo moves, pause AI, and force turn.
- Move log visible/copyable from the debug panel; also exposed as `window.moveLog` in the console.

## Notes and rules
- Exact rolls required to finish; triple-six forfeits the turn. Safe squares (shields/stars) cannot be captured.
- Start squares are colored; finished tokens stay in the external basket.
- Block rule is disabled (tokens don’t form blocking walls).
- AI currently available for Player 2 only.
- Sounds: dice rolls and finishing a token play lightweight synthesized sounds (Web Audio).
- UI: center overlay for status, home highlight for active player, stacked tokens spread on safe tiles for easier selection.




Enjoy! 🎲
