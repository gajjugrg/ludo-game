Ludo — Simple Browser Game

## How to run
1) Open `index.html` directly in your browser (double-click) or serve the folder with any static server.
2) Click **New Game**, pick player count (2/3/4), and optionally toggle AI for Player 2.
3) Press **Roll**, then click a highlighted token to move. Status appears in the right panel.
4) Finished tokens land in the basket; home areas are highlighted for the active player.

Tip: For online multiplayer, run the included relay server and open the game from a URL (not just `index.html` from disk).

## Online multiplayer
This project supports online multiplayer by syncing game state through a small Node.js WebSocket relay server.

High level:
- Players join the same **Session** code.
- The first player to join becomes the **host** and controls the player count and game start.
- Other players join with their **Name** and are assigned a seat automatically.

Implementation note:
- Online play requires a server + WebSockets (a static `file://` page can’t be used for real multi-device play).

Developer note:
- Detailed local run/deploy/debug instructions are intentionally not included in this public README.

## Notes and rules
- Exact rolls required to finish; triple-six forfeits the turn. Safe squares (shields/stars) cannot be captured.
- Start squares are colored; finished tokens stay in the external basket.
- Block rule is disabled (tokens don’t form blocking walls).
- AI currently available for Player 2 only.
- Sounds: dice rolls and finishing a token play lightweight synthesized sounds (Web Audio).
- UI: status is shown in the right panel, home highlight for active player, stacked tokens spread on safe tiles for easier selection.




Enjoy! 🎲
