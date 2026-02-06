# Discord ELO Bot - Copilot Instructions

## System Overview
This is a **Discord.js-based tournament and ELO rating system** for competitive gaming. The entire bot is a single Node.js file (`bot.js`) that manages player ratings, match submissions, tournament brackets, and admin roles.

**Key architecture**: Slash commands → command handlers → database operations (SQLite) → Discord embeds.

## Critical Design Patterns

### Database & Data Layer
- **SQLite with WAL mode** (Write-Ahead Logging) for concurrent access. Key tables:
  - `players`: ID, username, `mmr_data` (JSON with per-mode ratings like `{"1v1": 1500, "2v2": 1200}`)
  - `matches`: Stores pending/approved results; `winner_team` and `loser_team` are JSON arrays of Discord user IDs
  - `tournaments` / `tournament_participants` / `tournament_matches`: Tournament bracket state
  - `verifiers` / `tournament_hosts` / `blacklist`: Permission levels
- **No Promises for DB calls**—uses callback-based sqlite3 API. Example:
  ```javascript
  db.get('SELECT * FROM players WHERE id = ?', [userId], (err, row) => {
    if (err) handle(err);
    else process(row);
  });
  ```
- **Wrap in Promises when needed**: `ensurePlayer(playerId, username)` returns a Promise via queue pattern.

### Match Verification Workflow (Essential Pattern)
1. **Submit** → `/submit_match` writes to `matches` table with `approved = 0`
2. **Pending** → Verifiers list unapproved matches via `/pending`
3. **Approve** → `/approve_match` updates `mmr_data` for all players AND marks match approved
   - MMR change calculated by `calculateMMRChange(winnerMMR, loserMMR)`: rewards scale with opponent gap
   - Applies to **both winners and losers** in multi-player modes (sum of mode MMRs)

### Authorization Tiers
- **BOT_OWNER_ID**: Full access; can reset, undo, register all
- **Verifiers** (`verifiers` table): Can approve matches
- **Tournament Hosts** (`tournament_hosts` table): Can create tournaments
- **Blacklist** (`blacklist` table): Prevents match participation
- Check via: `isAuthorized(userId)`, `isTournamentHost(userId)`, `isBlacklisted(userId)`

### MMR System
- Each player has MMR per mode: `player.mmr_data[mode]` (default 100)
- **Rank tiers** defined in `getRankName(mode, elo)` — differs for 1v1 vs 2v2
- **MMR change formula**: `calculateMMRChange(winnerMax, loserMax)` returns 0–50 ELO based on skill gap
  - Larger gaps = smaller rewards (anti-smurf design)
  - Uses randomness: `Math.floor(Math.random() * N) + base`

### Embed & Response Helpers
All Discord responses use helper functions for consistency:
- `createSuccessEmbed(title, description)` → green (0x2ecc71)
- `createErrorEmbed(title, description)` → red (0xe74c3c)  
- `createInfoEmbed(title, description, color)` → custom color
- Always include `.setTimestamp()` and `.setFooter({ text: 'Tournament System' })`
- Use `respondToInteraction(interaction, payload)` to handle deferred replies automatically

### Command Handler Pattern
Commands are registered as Slash Commands, stored in `commandHandlers` object mapping command name → async function. Handler signature:
```javascript
async function commandName(interaction) {
  // interaction.options.getUser/getInteger/getString/getChoices()
  // respondToInteraction(interaction, { embeds: [...], ephemeral: true })
}
```

## Key Files & Their Roles

| File | Purpose |
|------|---------|
| [bot.js](bot.js) | Entire bot logic: database setup, helpers, 40+ command handlers, event listeners |
| [package.json](package.json) | `discord.js` ^14.25.1, `sqlite3` ^5.1.7, `dotenv` ^17.2.3 |
| [tournament.db](tournament.db) | SQLite database (auto-created) |

## Developer Workflows

### Running the Bot
```bash
npm install
# Set .env: BOT_TOKEN, APPLICATION_ID, BOT_OWNER_ID
npm start  # Starts bot and deploys slash commands
```

### Common Tasks
- **Add a new command**: Define function, add to `commands` array (lines ~1626–1683), add to `commandHandlers` object
- **Modify MMR logic**: Edit `calculateMMRChange()` or `getRankName()` at top of file
- **Add table**: Execute `db.run()` in database initialization (lines ~31–38)
- **Fix permissions**: Check `isAuthorized()`, `isTournamentHost()` conditions at start of handler
- **Debug DB**: Use `logAction(userId, username, action, details)` → stored in `logs` table

### Critical Environment Variables
- `BOT_TOKEN`: Discord bot token (from Developer Portal)
- `APPLICATION_ID`: Bot's app ID (for slash command deployment)
- `BOT_OWNER_ID`: Owner Discord user ID (for owner-only commands)
- Missing any = bot exits immediately

## Project-Specific Conventions

1. **JSON in Database**: Team data stored as JSON strings, parsed with `JSON.parse()`. Always validate before use.
2. **Tournament Bracket Types**: `single_elimination` removes on first loss; `double_elimination` requires two losses (see `TOURNAMENT_TYPES` object, line ~20).
3. **Authorization Pattern**: **Always check authorization at function start**, not mid-execution.
4. **Timestamp Format**: ISO 8601 for dates; parse with `new Date()`. Tournament start dates are YYYY-MM-DD strings.
5. **Role Assignment**: Bot creates/assigns Discord roles like `Tournament-{id}` when players join tournaments via `assignTournamentRole()`.
6. **User Existence**: Call `ensurePlayer(userId, username)` before any MMR operation to guarantee player exists and has current mode data.
7. **Logging**: Every admin action logged via `logAction()` for audit trail.

## Pitfalls to Avoid

- ❌ **Forget to parse JSON**: `JSON.parse(row.winner_team)` is essential for team matching
- ❌ **Assume modes exist**: Always fall back to 100 ELO for missing modes in `mmr_data`
- ❌ **Skip blacklist check** in `ensurePlayer()` or match submission—use `isBlacklisted()`
- ❌ **Use `db.run()` thinking it's synchronous**: Wrap in Promise or use callbacks
- ❌ **Skip `ensurePlayer()` before tournament match approval**: Guarantees MMR data exists
- ❌ **Send multiple replies**: Use `deferReply()` for long operations, then `editReply()`
- ❌ **Forget to log actions**: Critical for debugging and audits

---

**Last Updated**: Feb 6, 2026 | **Bot Version**: 1.0.0 | **Single File**: 1831 lines
