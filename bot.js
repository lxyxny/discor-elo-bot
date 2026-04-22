require('dotenv').config();

const {
  Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cron = require('node-cron');

// ======================
// ENVIRONMENT & CONFIG
// ======================

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPLICATION_ID = process.env.APPLICATION_ID;
const GAME_ROOM_CHANNEL_ID = '1496461396546814032';

if (!BOT_TOKEN || !APPLICATION_ID || !BOT_OWNER_ID) {
  console.error('❌ Missing required environment variables. Check your .env file.');
  process.exit(1);
}

const MODES = ['1v1', '2v2'];

const TOURNAMENT_TYPES = {
  'single_elimination': { name: 'Single Elimination', description: 'Players are paired in matches. The loser of each match is eliminated. Winners advance to the next round. The tournament ends when one undefeated player remains.', elimination_logic: 'single_elimination', bracket_type: 'knockout', color: 0x3498db },
  'double_elimination': { name: 'Double Elimination', description: 'Players are eliminated only after losing two matches. All players start in the winners bracket. A first loss moves a player to the losers bracket. A second loss eliminates the player. The final winner may need to defeat the winners bracket finalist twice, depending on rules.', elimination_logic: 'double_elimination', bracket_type: 'double_bracket', color: 0xe74c3c },
  'round_robin': { name: 'Round Robin', description: 'Each player competes against every other player a fixed number of times. No eliminations occur during play. Final rankings are determined by total wins, points, or tiebreakers.', elimination_logic: 'round_robin', bracket_type: 'league', color: 0x2ecc71 },
  'swiss_system': { name: 'Swiss System', description: 'Players are not eliminated. All players compete for a fixed number of rounds. In each round, players with similar scores are paired. Final rankings are based on total score and tiebreakers.', elimination_logic: 'swiss_system', bracket_type: 'swiss', color: 0xf39c12 },
  'group_stage': { name: 'Group Stage (Pools)', description: 'Players are divided into groups. Each group uses round robin or similar play. Top-ranked players from each group advance to a later elimination stage.', elimination_logic: 'group_stage', bracket_type: 'hybrid', color: 0x9b59b6 },
  'league': { name: 'League', description: 'Players compete in a long-term schedule, often home and away. Each matchup awards points. Final standings are based on total points across the season.', elimination_logic: 'league', bracket_type: 'league', color: 0x1abc9c },
  'knockout_seeding': { name: 'Knockout with Seeding', description: 'Players are ranked before the tournament. Higher-ranked players face lower-ranked players in early rounds. Losers are eliminated after one loss.', elimination_logic: 'single_elimination', bracket_type: 'seeded_knockout', color: 0xe67e22 },
  'playoffs': { name: 'Playoffs', description: 'A final elimination phase following a league, group stage, or regular season. Qualified players compete in single or multi-match elimination to determine the champion.', elimination_logic: 'playoffs', bracket_type: 'knockout', color: 0x34495e },
  'best_of_series': { name: 'Best-of Series', description: 'Each matchup consists of multiple games. A player wins the match by winning more than half of the games. The series winner advances or earns points.', elimination_logic: 'best_of_series', bracket_type: 'series', color: 0xd35400 }
};

// ======================
// RANK SYSTEM
// ======================

const RANK_TIERS = [
  { name: 'Beginner',     min: 0    },
  { name: 'Amateur',      min: 500  },
  { name: 'Challenge',    min: 800  },
  { name: 'Semi-Pro',     min: 1000 },
  { name: 'Professional', min: 1250 },
  { name: 'Ascendant',    min: 1500 },
  { name: 'Godlike',      min: 2000 },
];

const DIVISION_NAMES = ['IV', 'III', 'II', 'I'];

const RANK_COLORS = {
  'Beginner':     0x808080,
  'Amateur':      0x2ecc71,
  'Challenge':    0x3498db,
  'Semi-Pro':     0x9b59b6,
  'Professional': 0xe67e22,
  'Ascendant':    0xe74c3c,
  'Godlike':      0xf1c40f,
};

/**
 * Returns { tier, division, divisionNum, display, color, nextTierMin }
 */
function getRankAndDivision(mmr) {
  mmr = Math.max(0, mmr);

  let tierIndex = 0;
  for (let i = RANK_TIERS.length - 1; i >= 0; i--) {
    if (mmr >= RANK_TIERS[i].min) { tierIndex = i; break; }
  }

  const tier = RANK_TIERS[tierIndex];
  const nextTier = RANK_TIERS[tierIndex + 1];
  const color = RANK_COLORS[tier.name] || 0x808080;

  if (tier.name === 'Godlike') {
    return { tier: tier.name, division: '', divisionNum: 0, display: 'Godlike', color, nextTierMin: null };
  }

  const rangeMin = tier.min;
  const rangeMax = nextTier ? nextTier.min : rangeMin + 500;
  const rangeSize = rangeMax - rangeMin;
  const segmentSize = rangeSize / 4;
  const posInTier = mmr - rangeMin;
  const divisionIndex = Math.min(3, Math.floor(posInTier / segmentSize));
  const division = DIVISION_NAMES[divisionIndex];

  return {
    tier: tier.name, division, divisionNum: divisionIndex + 1,
    display: `${tier.name} ${division}`, color, nextTierMin: nextTier ? nextTier.min : null,
  };
}

// ======================
// DATABASE
// ======================

const dbPath = path.join(__dirname, 'tournament.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA synchronous=NORMAL;");

  db.run(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, username TEXT, mmr_data TEXT DEFAULT '{}',
    equipped_title TEXT DEFAULT '', wins_data TEXT DEFAULT '{}', peak_mmr_data TEXT DEFAULT '{}'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, winner_team TEXT NOT NULL,
    loser_team TEXT NOT NULL, winner_mmr_before TEXT, loser_mmr_before TEXT,
    winner_mmr_after TEXT, loser_mmr_after TEXT, mmr_change INTEGER NOT NULL,
    approved BOOLEAN DEFAULT 0, approved_by TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS verifiers (id TEXT PRIMARY KEY, username TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS blacklist (id TEXT PRIMARY KEY, username TEXT, reason TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS tournament_hosts (id TEXT PRIMARY KEY, username TEXT)`);

  db.run(`CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mode TEXT NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'upcoming', min_mmr INTEGER DEFAULT 0, max_mmr INTEGER DEFAULT 5000,
    mmr_range INTEGER DEFAULT 0, host_id TEXT NOT NULL, start_date TEXT, total_rounds INTEGER DEFAULT 0,
    current_round INTEGER DEFAULT 0, best_of INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournament_participants (
    tournament_id INTEGER, player_id TEXT, eliminated BOOLEAN DEFAULT 0,
    wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, draws INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0, rank INTEGER, bracket_position TEXT, seed INTEGER,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id), FOREIGN KEY (player_id) REFERENCES players(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tournament_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, match_id INTEGER, round INTEGER,
    match_type TEXT, player1_id TEXT, player2_id TEXT, winner_id TEXT, games_won_p1 INTEGER DEFAULT 0,
    games_won_p2 INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', bracket_position TEXT,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS player_titles (
    player_id TEXT, title TEXT, tournament_id INTEGER, awarded_by TEXT,
    source TEXT DEFAULT 'tournament', awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES players(id), FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, action TEXT,
    details TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Season tracking config table
  db.run(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);

  db.get("SELECT value FROM config WHERE key = 'season_number'", (err, row) => {
    if (!row) db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('season_number', '1')");
  });

  // Safe migrations for existing databases
  db.run(`ALTER TABLE players ADD COLUMN wins_data TEXT DEFAULT '{}'`, () => {});
  db.run(`ALTER TABLE players ADD COLUMN peak_mmr_data TEXT DEFAULT '{}'`, () => {});
  db.run(`ALTER TABLE matches ADD COLUMN winner_mmr_after TEXT`, () => {});
  db.run(`ALTER TABLE matches ADD COLUMN loser_mmr_after TEXT`, () => {});
  db.run(`ALTER TABLE player_titles ADD COLUMN source TEXT DEFAULT 'tournament'`, () => {});
});

// ======================
// UTILITIES
// ======================

function getDefaultMMRData() {
  const d = {}; MODES.forEach(m => d[m] = 100); return d;
}
function getDefaultWinsData() {
  const d = {}; MODES.forEach(m => d[m] = 0); return d;
}

function getConfigValue(key) {
  return new Promise((resolve) => {
    db.get("SELECT value FROM config WHERE key = ?", [key], (err, row) => resolve(row ? row.value : null));
  });
}
function setConfigValue(key, value) {
  return new Promise((resolve) => {
    db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, String(value)], () => resolve());
  });
}

function getNextSeasonResetTimestamp() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.floor(next.getTime() / 1000);
}

function isAuthorized(userId) {
  return new Promise((resolve) => {
    if (userId === BOT_OWNER_ID) return resolve(true);
    db.get('SELECT 1 FROM verifiers WHERE id = ?', [userId], (err, row) => resolve(!!row));
  });
}
function isBlacklisted(userId) {
  return new Promise((resolve) => {
    db.get('SELECT 1 FROM blacklist WHERE id = ?', [userId], (err, row) => resolve(!!row));
  });
}
function isTournamentHost(userId) {
  return new Promise((resolve) => {
    if (userId === BOT_OWNER_ID) return resolve(true);
    db.get('SELECT 1 FROM verifiers WHERE id = ?', [userId], (err, row) => {
      if (row) return resolve(true);
      db.get('SELECT 1 FROM tournament_hosts WHERE id = ?', [userId], (err, row2) => resolve(!!row2));
    });
  });
}

function ensurePlayer(playerId, username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM players WHERE id = ?', [playerId], (err, row) => {
      if (err) return reject(err);
      if (!row) {
        const def = getDefaultMMRData(), defW = getDefaultWinsData();
        db.run('INSERT INTO players (id, username, mmr_data, wins_data, peak_mmr_data) VALUES (?, ?, ?, ?, ?)',
          [playerId, username, JSON.stringify(def), JSON.stringify(defW), JSON.stringify(def)],
          (err) => err ? reject(err) : resolve({ id: playerId, username, mmr_data: def, wins_data: defW, peak_mmr_data: def }));
      } else {
        try {
          const mmrData = JSON.parse(row.mmr_data || '{}');
          const winsData = JSON.parse(row.wins_data || '{}');
          const peakData = JSON.parse(row.peak_mmr_data || '{}');
          let updated = false;
          MODES.forEach(mode => {
            if (mmrData[mode] === undefined) { mmrData[mode] = 100; updated = true; }
            if (winsData[mode] === undefined) { winsData[mode] = 0; updated = true; }
            if (peakData[mode] === undefined) { peakData[mode] = mmrData[mode]; updated = true; }
          });
          if (updated) db.run('UPDATE players SET mmr_data=?,wins_data=?,peak_mmr_data=? WHERE id=?',
            [JSON.stringify(mmrData), JSON.stringify(winsData), JSON.stringify(peakData), playerId]);
          resolve({ id: playerId, username: row.username, mmr_data: mmrData, wins_data: winsData, peak_mmr_data: peakData, equipped_title: row.equipped_title });
        } catch (e) { reject(e); }
      }
    });
  });
}

function logAction(userId, username, action, details = '') {
  db.run('INSERT INTO logs (user_id, username, action, details) VALUES (?, ?, ?, ?)', [userId, username, action, details]);
}

// ======================
// COMPETITIVE ENGINE
// ======================

/**
 * Anti-boost weighted team MMR.
 * Standard: 80% highest + 20% lowest.
 * Elite override (any player >= 1250): equals the highest MMR.
 */
function getTeamMMR(players, mode) {
  const mmrs = players.map(p => p.mmr_data[mode] || 100).sort((a, b) => b - a);
  if (mmrs.length === 1) return mmrs[0];
  if (mmrs[0] >= 1250) return mmrs[0];
  return Math.round(mmrs[0] * 0.8 + mmrs[mmrs.length - 1] * 0.2);
}

/** K-Factor: 80 during placement (<20 wins), 32 standard */
function getKFactor(player, mode) {
  return ((player.wins_data && player.wins_data[mode]) || 0) < 20 ? 80 : 32;
}

/**
 * Deterministic Elo/TrueSkill hybrid.
 * Returns a map of { playerId: { change, isWinner } }
 */
function calculateMMRChanges(winnerPlayers, loserPlayers, mode) {
  const winnerTeamMMR = getTeamMMR(winnerPlayers, mode);
  const loserTeamMMR = getTeamMMR(loserPlayers, mode);
  const expectedWin = 1 / (1 + Math.pow(10, (loserTeamMMR - winnerTeamMMR) / 400));
  const expectedLoss = 1 - expectedWin;

  const changes = {};
  for (const p of winnerPlayers) {
    const K = getKFactor(p, mode);
    changes[p.id] = { change: Math.max(1, Math.round(K * (1 - expectedWin))), isWinner: true };
  }
  for (const p of loserPlayers) {
    const K = getKFactor(p, mode);
    changes[p.id] = { change: Math.max(1, Math.round(K * (1 - expectedLoss))), isWinner: false };
  }
  return changes;
}

// ======================
// AUTO-ROLE SYNC
// ======================

const TIER_ROLE_NAMES = RANK_TIERS.map(t => t.name);

async function syncPlayerRoles(guild, userId, mmr) {
  if (!guild) return;
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    const { tier } = getRankAndDivision(mmr);

    for (const tierName of TIER_ROLE_NAMES) {
      const role = guild.roles.cache.find(r => r.name === `🏅 ${tierName}`);
      if (role && member.roles.cache.has(role.id)) await member.roles.remove(role).catch(() => {});
    }

    let targetRole = guild.roles.cache.find(r => r.name === `🏅 ${tier}`);
    if (!targetRole) {
      targetRole = await guild.roles.create({ name: `🏅 ${tier}`, color: RANK_COLORS[tier] || 0x808080, reason: 'Auto-created rank role' }).catch(() => null);
    }
    if (targetRole) await member.roles.add(targetRole).catch(() => {});
  } catch (e) { console.error('[ROLE SYNC ERROR]', e.message); }
}

// ======================
// PROMOTION DETECTION
// ======================

function checkPromotion(oldMMR, newMMR) {
  const oldRank = getRankAndDivision(oldMMR);
  const newRank = getRankAndDivision(newMMR);
  const tiered = oldRank.tier !== newRank.tier;
  const promoted = (tiered || oldRank.division !== newRank.division) && newMMR > oldMMR;
  return { promoted, tiered, oldDisplay: oldRank.display, newDisplay: newRank.display, newColor: newRank.color };
}

async function sendPromotionAlert(channel, userId, mode, promo) {
  if (!channel || !promo.promoted) return;
  const embed = new EmbedBuilder()
    .setColor(promo.newColor)
    .setTitle(promo.tiered ? `🚀 TIER UP!` : `⬆️ RANK UP!`)
    .setDescription(
      `<@${userId}> has ranked up in **${mode}**!\n\n` +
      `**${promo.oldDisplay}** → **${promo.newDisplay}**\n\n` +
      (promo.tiered ? '🎊 **NEW TIER UNLOCKED!**' : '🎉 Division promotion!')
    )
    .setTimestamp()
    .setFooter({ text: 'Rocket League Competitive System' });
  await channel.send({ embeds: [embed] }).catch(() => {});
}

// ======================
// EMBED FACTORIES
// ======================

function createSuccessEmbed(title, description) {
  return new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ ${title}`).setDescription(description).setTimestamp().setFooter({ text: 'Tournament System' });
}
function createErrorEmbed(title, description) {
  return new EmbedBuilder().setColor(0xe74c3c).setTitle(`❌ ${title}`).setDescription(description).setTimestamp().setFooter({ text: 'Tournament System' });
}
function createInfoEmbed(title, description, color = 0x3498db) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp().setFooter({ text: 'Tournament System' });
}

// ======================
// TOURNAMENT LOGIC
// ======================

async function assignTournamentRole(guild, userId, roleName) {
  try {
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (role) { await member.roles.add(role); return true; }
    return false;
  } catch { return false; }
}

async function removeTournamentRole(guild, userId, roleName) {
  try {
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (role) { await member.roles.remove(role); return true; }
    return false;
  } catch { return false; }
}

async function processTournamentElimination(tournamentId, matchData, guild) {
  return new Promise((resolve) => {
    db.get('SELECT type, best_of FROM tournaments WHERE id = ?', [tournamentId], (err, tourney) => {
      if (err || !tourney) return resolve(false);
      const { type, best_of } = tourney;
      const logic = TOURNAMENT_TYPES[type]?.elimination_logic;
      if (type === 'best_of_series') { handleBestOfSeries(tournamentId, matchData, best_of, guild); return resolve(true); }
      switch (logic) {
        case 'single_elimination': handleSingleElimination(tournamentId, matchData.loser_id, guild); break;
        case 'double_elimination': handleDoubleElimination(tournamentId, matchData, guild); break;
        case 'round_robin': case 'swiss_system': case 'league':
          updatePlayerStats(tournamentId, matchData.winner_id, 'win');
          updatePlayerStats(tournamentId, matchData.loser_id, 'loss'); break;
        case 'group_stage': handleGroupStage(tournamentId, matchData); break;
        case 'playoffs': handleSingleElimination(tournamentId, matchData.loser_id, guild); break;
        default: handleSingleElimination(tournamentId, matchData.loser_id, guild);
      }
      resolve(true);
    });
  });
}

function handleSingleElimination(tournamentId, playerId, guild) {
  db.run(`UPDATE tournament_participants SET eliminated=1 WHERE tournament_id=? AND player_id=?`, [tournamentId, playerId], () => {
    removeTournamentRole(guild, playerId, `Tournament-${tournamentId}`);
  });
}

function handleDoubleElimination(tournamentId, matchData, guild) {
  const { winner_id, loser_id } = matchData;
  db.get(`SELECT bracket_position FROM tournament_participants WHERE tournament_id=? AND player_id=?`, [tournamentId, loser_id], (err, loser) => {
    if (err) return;
    if (!loser || loser.bracket_position === 'winners') {
      db.run(`UPDATE tournament_participants SET bracket_position='losers',losses=losses+1 WHERE tournament_id=? AND player_id=?`, [tournamentId, loser_id]);
    } else if (loser.bracket_position === 'losers') {
      db.run(`UPDATE tournament_participants SET eliminated=1,losses=losses+1 WHERE tournament_id=? AND player_id=?`, [tournamentId, loser_id], () => {
        removeTournamentRole(guild, loser_id, `Tournament-${tournamentId}`);
      });
    }
  });
  updatePlayerStats(tournamentId, winner_id, 'win');
}

function handleBestOfSeries(tournamentId, matchData, bestOf, guild) {
  const { match_id, player1_id, player2_id, winner_id } = matchData;
  const field = winner_id === player1_id ? 'games_won_p1' : 'games_won_p2';
  db.run(`UPDATE tournament_matches SET ${field}=${field}+1 WHERE id=?`, [match_id], () => {
    db.get(`SELECT games_won_p1,games_won_p2,player1_id,player2_id FROM tournament_matches WHERE id=?`, [match_id], (err, match) => {
      if (err) return;
      const needed = Math.floor(bestOf / 2) + 1;
      let winner = null;
      if (match.games_won_p1 >= needed) winner = match.player1_id;
      else if (match.games_won_p2 >= needed) winner = match.player2_id;
      if (winner) {
        const loser = winner === match.player1_id ? match.player2_id : match.player1_id;
        handleSingleElimination(tournamentId, loser, guild);
        updatePlayerStats(tournamentId, winner, 'win');
      }
    });
  });
}

function handleGroupStage(tournamentId, matchData) {
  updatePlayerStats(tournamentId, matchData.winner_id, 'win');
  updatePlayerStats(tournamentId, matchData.loser_id, 'loss');
}

function updatePlayerStats(tournamentId, playerId, result) {
  let points = 0, field = '';
  if (result === 'win') { points = 3; field = 'wins'; }
  else if (result === 'loss') { points = 0; field = 'losses'; }
  else { points = 1; field = 'draws'; }
  db.run(`UPDATE tournament_participants SET ${field}=${field}+1,points=points+? WHERE tournament_id=? AND player_id=?`, [points, tournamentId, playerId]);
}

// ======================
// RAINBOW ROLE
// ======================

async function setupRainbowRole(guild) {
  try {
    const existingRole = guild.roles.cache.find(r => r.name === '✨ Tournament Creator');
    if (existingRole) return existingRole;
    const rainbowRole = await guild.roles.create({ name: '✨ Tournament Creator', color: 0xff6b6b, hoist: true, reason: 'Bot owner identification' });
    const owner = await guild.members.fetch(BOT_OWNER_ID);
    if (owner) await owner.roles.add(rainbowRole);
    setInterval(async () => {
      const colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0x96ceb4, 0xfeeca9, 0xff9aa2];
      try { await rainbowRole.edit({ color: colors[Math.floor(Math.random() * colors.length)] }); } catch {}
    }, 1000);
    return rainbowRole;
  } catch (error) { console.error('Rainbow role setup failed:', error); return null; }
}

// ======================
// GAME ROOM STATE
// ======================

const gameRoomSignups = new Map(); // messageId -> Set<userId>

// ======================
// CRON JOBS
// ======================

function startCronJobs(client) {
  // Friday Game Room — Every Friday at 3:00 PM GMT
  cron.schedule('0 15 * * 5', async () => {
    console.log('[CRON] Firing Friday Game Room...');
    try {
      const channel = await client.channels.fetch(GAME_ROOM_CHANNEL_ID).catch(() => null);
      if (!channel) return console.error('[CRON] Game room channel not found:', GAME_ROOM_CHANNEL_ID);

      const embed = new EmbedBuilder()
        .setColor(0x4ecdc4)
        .setTitle('🎮 FRIDAY GAME ROOM IS OPEN!')
        .setDescription('**It\'s Friday — time to compete!**\n\nSign up below to join this week\'s 2v2 matches.\nOnce enough players sign up, the host will randomize teams.\n\n🕒 Matches start soon — don\'t miss out!')
        .setTimestamp()
        .setFooter({ text: 'Rocket League Competitive System' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gameroom_signup').setLabel('✅ Sign Up').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('gameroom_leave').setLabel('❌ Leave').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('gameroom_randomize').setLabel('🎲 Randomize Teams').setStyle(ButtonStyle.Primary),
      );

      const msg = await channel.send({ embeds: [embed], components: [row] });
      gameRoomSignups.set(msg.id, new Set());
      console.log('[CRON] Friday Game Room posted, message ID:', msg.id);
    } catch (e) { console.error('[CRON] Failed to post game room:', e); }
  }, { timezone: 'UTC' });

  // Monthly Season Reset — 1st of every month at midnight UTC
  cron.schedule('0 0 1 * *', async () => {
    console.log('[CRON] Running monthly season reset...');
    try {
      const seasonNum = parseInt(await getConfigValue('season_number') || '1', 10);
      const players = await new Promise((res) => db.all('SELECT * FROM players', [], (err, rows) => res(rows || [])));

      // Step 1: Award legacy titles based on peak MMR
      for (const player of players) {
        try {
          const peakData = JSON.parse(player.peak_mmr_data || player.mmr_data || '{}');
          for (const mode of MODES) {
            const peakMMR = peakData[mode] || 100;
            const { tier } = getRankAndDivision(peakMMR);
            if (tier !== 'Beginner') {
              db.run(`INSERT INTO player_titles (player_id, title, tournament_id, awarded_by, source) VALUES (?, ?, NULL, 'system', 'season_reset')`,
                [player.id, `S${seasonNum} ${tier}`]);
            }
          }
        } catch {}
      }

      // Step 2: Soft reset — NewMMR = (OldMMR * 0.6) + 240
      for (const player of players) {
        try {
          const mmrData = JSON.parse(player.mmr_data || '{}');
          const newMMR = {};
          MODES.forEach(mode => { newMMR[mode] = Math.round((mmrData[mode] || 100) * 0.6 + 240); });
          db.run('UPDATE players SET mmr_data=?,peak_mmr_data=? WHERE id=?',
            [JSON.stringify(newMMR), JSON.stringify(newMMR), player.id]);
        } catch {}
      }

      // Step 3: Advance season number
      await setConfigValue('season_number', String(seasonNum + 1));
      console.log(`[CRON] Season ${seasonNum} complete. Season ${seasonNum + 1} begins.`);
    } catch (e) { console.error('[CRON] Season reset failed:', e); }
  }, { timezone: 'UTC' });

  console.log('✅ Cron jobs scheduled (Friday Game Room + Monthly Season Reset).');
}

// ======================
// MATCH APPROVAL HELPER
// ======================

async function applyMatchResult(match, approverId, guild, channel) {
  const mode = match.mode;
  const winnerTeam = JSON.parse(match.winner_team);
  const loserTeam = JSON.parse(match.loser_team);

  const winnerPlayers = [];
  for (const id of winnerTeam) winnerPlayers.push(await ensurePlayer(id, ''));
  const loserPlayers = [];
  for (const id of loserTeam) loserPlayers.push(await ensurePlayer(id, ''));

  const playerChanges = calculateMMRChanges(winnerPlayers, loserPlayers, mode);
  const winnerMMRBefore = JSON.stringify(winnerPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
  const loserMMRBefore = JSON.stringify(loserPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
  const representativeChange = playerChanges[winnerPlayers[0].id]?.change || 0;

  const winnerMMRAfterArr = [], loserMMRAfterArr = [];

  for (const p of winnerPlayers) {
    const gain = playerChanges[p.id].change;
    const newMMR = p.mmr_data[mode] + gain;
    winnerMMRAfterArr.push({ id: p.id, mmr: newMMR });
    const newData = { ...p.mmr_data, [mode]: newMMR };
    const newWins = { ...p.wins_data, [mode]: (p.wins_data[mode] || 0) + 1 };
    const newPeak = { ...p.peak_mmr_data, [mode]: Math.max(p.peak_mmr_data[mode] || 0, newMMR) };
    db.run('UPDATE players SET mmr_data=?,wins_data=?,peak_mmr_data=? WHERE id=?',
      [JSON.stringify(newData), JSON.stringify(newWins), JSON.stringify(newPeak), p.id]);
    await syncPlayerRoles(guild, p.id, newMMR);
    const promo = checkPromotion(p.mmr_data[mode], newMMR);
    if (promo.promoted && channel) await sendPromotionAlert(channel, p.id, mode, promo);
  }
  for (const p of loserPlayers) {
    const loss = playerChanges[p.id].change;
    const newMMR = Math.max(0, p.mmr_data[mode] - loss);
    loserMMRAfterArr.push({ id: p.id, mmr: newMMR });
    const newData = { ...p.mmr_data, [mode]: newMMR };
    db.run('UPDATE players SET mmr_data=? WHERE id=?', [JSON.stringify(newData), p.id]);
    await syncPlayerRoles(guild, p.id, newMMR);
  }

  db.run('UPDATE matches SET approved=1,approved_by=?,mmr_change=?,winner_mmr_before=?,loser_mmr_before=?,winner_mmr_after=?,loser_mmr_after=? WHERE id=?',
    [approverId, representativeChange, winnerMMRBefore, loserMMRBefore,
      JSON.stringify(winnerMMRAfterArr), JSON.stringify(loserMMRAfterArr), match.id]);

  // Handle tournament elimination
  await new Promise((resolve) => {
    db.get('SELECT tm.tournament_id,tm.id as tmid,t.type,tm.player1_id,tm.player2_id FROM tournament_matches tm JOIN tournaments t ON tm.tournament_id=t.id WHERE tm.match_id=?',
      [match.id], async (err, tm) => {
        if (tm && tm.tournament_id) {
          await processTournamentElimination(tm.tournament_id, {
            match_id: tm.tmid, tournament_id: tm.tournament_id,
            winner_id: winnerTeam[0], loser_id: loserTeam[0],
            player1_id: tm.player1_id, player2_id: tm.player2_id
          }, guild);
        }
        resolve();
      });
  });

  return { winnerPlayers, loserPlayers, playerChanges, representativeChange, mode };
}

// ======================
// COMMAND HANDLERS
// ======================

async function registerPlayer(interaction) {
  try {
    await ensurePlayer(interaction.user.id, interaction.user.username);
    logAction(interaction.user.id, interaction.user.username, 'REGISTER', 'Player registered');
    await interaction.reply({ embeds: [createSuccessEmbed('Registration Complete', 'Your MMR has been initialized at **100** for all modes.\nUse `/stats` to view your full player card!')] });
  } catch {
    await interaction.reply({ embeds: [createErrorEmbed('Registration Failed', 'Please try again later.')], ephemeral: true });
  }
}

async function submitMatch(interaction) {
  if (await isBlacklisted(interaction.user.id))
    return interaction.reply({ embeds: [createErrorEmbed('Restricted', 'You are restricted from submitting results.')], ephemeral: true });

  const mode = interaction.options.getString('mode');
  const winner1 = interaction.options.getUser('winner1');
  const loser1 = interaction.options.getUser('loser1');
  let winnerTeam = [winner1.id], loserTeam = [loser1.id];

  if (mode === '2v2') {
    const w2 = interaction.options.getUser('winner2'), l2 = interaction.options.getUser('loser2');
    if (!w2 || !l2) return interaction.reply({ embeds: [createErrorEmbed('Invalid Team Size', '2v2 requires 2 players per team.')], ephemeral: true });
    winnerTeam.push(w2.id); loserTeam.push(l2.id);
  }

  const allPlayers = [...new Set([...winnerTeam, ...loserTeam])];
  if (allPlayers.length !== winnerTeam.length + loserTeam.length)
    return interaction.reply({ embeds: [createErrorEmbed('Invalid Submission', 'Players cannot be on both teams.')], ephemeral: true });

  for (const id of allPlayers)
    if (await isBlacklisted(id))
      return interaction.reply({ embeds: [createErrorEmbed('Restricted Player', 'A participant is restricted from tournament activity.')], ephemeral: true });

  try {
    const winnerPlayers = [], loserPlayers = [];
    for (const id of winnerTeam) winnerPlayers.push(await ensurePlayer(id, interaction.guild?.members.cache.get(id)?.displayName || 'Unknown'));
    for (const id of loserTeam) loserPlayers.push(await ensurePlayer(id, interaction.guild?.members.cache.get(id)?.displayName || 'Unknown'));

    const isAuth = await isAuthorized(interaction.user.id);

    if (isAuth) {
      const playerChanges = calculateMMRChanges(winnerPlayers, loserPlayers, mode);
      const winnerMMRBefore = JSON.stringify(winnerPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
      const loserMMRBefore = JSON.stringify(loserPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
      const repChange = playerChanges[winnerPlayers[0].id]?.change || 0;

      const winnerAfterArr = [], loserAfterArr = [];
      for (const p of winnerPlayers) {
        const gain = playerChanges[p.id].change, newMMR = p.mmr_data[mode] + gain;
        winnerAfterArr.push({ id: p.id, mmr: newMMR });
        db.run('UPDATE players SET mmr_data=?,wins_data=?,peak_mmr_data=? WHERE id=?', [
          JSON.stringify({ ...p.mmr_data, [mode]: newMMR }),
          JSON.stringify({ ...p.wins_data, [mode]: (p.wins_data[mode] || 0) + 1 }),
          JSON.stringify({ ...p.peak_mmr_data, [mode]: Math.max(p.peak_mmr_data[mode] || 0, newMMR) }),
          p.id]);
        await syncPlayerRoles(interaction.guild, p.id, newMMR);
        const promo = checkPromotion(p.mmr_data[mode], newMMR);
        if (promo.promoted && interaction.channel) await sendPromotionAlert(interaction.channel, p.id, mode, promo);
      }
      for (const p of loserPlayers) {
        const loss = playerChanges[p.id].change, newMMR = Math.max(0, p.mmr_data[mode] - loss);
        loserAfterArr.push({ id: p.id, mmr: newMMR });
        db.run('UPDATE players SET mmr_data=? WHERE id=?', [JSON.stringify({ ...p.mmr_data, [mode]: newMMR }), p.id]);
        await syncPlayerRoles(interaction.guild, p.id, newMMR);
      }

      db.run(`INSERT INTO matches (mode,winner_team,loser_team,winner_mmr_before,loser_mmr_before,winner_mmr_after,loser_mmr_after,mmr_change,approved,approved_by) VALUES (?,?,?,?,?,?,?,?,1,?)`,
        [mode, JSON.stringify(winnerTeam), JSON.stringify(loserTeam), winnerMMRBefore, loserMMRBefore,
          JSON.stringify(winnerAfterArr), JSON.stringify(loserAfterArr), repChange, interaction.user.id],
        function (err) {
          if (err) return (interaction.followUp || interaction.reply)?.({ embeds: [createErrorEmbed('Submission Failed', 'Database error.')], ephemeral: true });
          const wNames = winnerPlayers.map(p => p.username).join(', ');
          const lNames = loserPlayers.map(p => p.username).join(', ');
          const changeStr = winnerPlayers.map(p => `${p.username}: +${playerChanges[p.id].change}`).join(', ');
          logAction(interaction.user.id, interaction.user.username, 'SUBMIT_MATCH', `Match #${this.lastID}, Mode: ${mode}`);
          const embed = createSuccessEmbed('Match Recorded', `**Match #${this.lastID}** | **Mode:** ${mode}\n**Winners:** ${wNames} (${changeStr})\n**Losers:** ${lNames}`);
          if (interaction.replied || interaction.deferred) interaction.followUp({ embeds: [embed] });
          else interaction.reply({ embeds: [embed] });
        });
    } else {
      db.run(`INSERT INTO matches (mode,winner_team,loser_team,mmr_change) VALUES (?,?,?,0)`,
        [mode, JSON.stringify(winnerTeam), JSON.stringify(loserTeam)],
        function (err) {
          if (err) return interaction.reply({ embeds: [createErrorEmbed('Submission Failed', 'Database error.')], ephemeral: true });
          const wNames = winnerPlayers.map(p => p.username).join(', ');
          const lNames = loserPlayers.map(p => p.username).join(', ');
          logAction(interaction.user.id, interaction.user.username, 'SUBMIT_PENDING', `Match #${this.lastID}, Mode: ${mode}`);
          interaction.reply({ embeds: [createInfoEmbed('Submission Received', `**Match #${this.lastID}** | **Mode:** ${mode}\n**Winners:** ${wNames}\n**Losers:** ${lNames}\nAwaiting verification by staff.`, 0xf39c12)] });
        });
    }
  } catch (error) {
    console.error("Submit match error:", error);
    await interaction.reply({ embeds: [createErrorEmbed('Submission Failed', 'Ensure all players are registered with `/register`.')], ephemeral: true });
  }
}

async function listPending(interaction) {
  if (!await isAuthorized(interaction.user.id))
    return interaction.reply({ embeds: [createErrorEmbed('Access Denied', 'You do not have permission.')], ephemeral: true });

  db.all('SELECT * FROM matches WHERE approved=0', [], (err, rows) => {
    if (err || rows.length === 0) return interaction.reply({ embeds: [createInfoEmbed('No Pending Submissions', 'All submissions have been processed.')] });
    let description = '';
    rows.forEach(row => {
      const winners = JSON.parse(row.winner_team).map(id => `<@${id}>`).join(', ');
      const losers = JSON.parse(row.loser_team).map(id => `<@${id}>`).join(', ');
      description += `**#${row.id}**: [${row.mode}] ${winners} → ${losers}\n`;
    });
    interaction.reply({ embeds: [createInfoEmbed('📋 Pending Submissions', `${description.trim()}\n\nUse \`/approve_match id:[ID]\``)] });
  });
}

async function approveAllMatches(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID)
    return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner can approve all matches.')], ephemeral: true });

  db.all('SELECT * FROM matches WHERE approved=0', async (err, matches) => {
    if (err || matches.length === 0)
      return interaction.reply({ embeds: [createInfoEmbed('No Pending Matches', 'There are no pending matches to approve.')] });

    for (const match of matches) {
      await applyMatchResult(match, interaction.user.id, interaction.guild, interaction.channel);
    }

    logAction(interaction.user.id, interaction.user.username, 'APPROVE_ALL', `${matches.length} matches approved`);
    interaction.reply({ embeds: [createSuccessEmbed('All Matches Approved', `Approved **${matches.length}** pending matches.`)] });
  });
}

async function approveMatch(interaction) {
  const matchId = interaction.options.getInteger('id');
  if (!await isAuthorized(interaction.user.id))
    return interaction.reply({ embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve matches.')], ephemeral: true });

  db.get('SELECT * FROM matches WHERE id=? AND approved=0', [matchId], async (err, match) => {
    if (err || !match)
      return interaction.reply({ embeds: [createErrorEmbed('Not Found', 'The submission ID is invalid or already processed.')], ephemeral: true });

    const { winnerPlayers, loserPlayers, playerChanges, representativeChange, mode } = await applyMatchResult(match, interaction.user.id, interaction.guild, interaction.channel);
    const wNames = winnerPlayers.map(p => p.username).join(', ');
    const lNames = loserPlayers.map(p => p.username).join(', ');
    const changeStr = winnerPlayers.map(p => `${p.username}: +${playerChanges[p.id].change}`).join(', ');
    logAction(interaction.user.id, interaction.user.username, 'APPROVE_MATCH', `Match #${matchId}, Mode: ${mode}`);
    await interaction.reply({ embeds: [createSuccessEmbed('Match Approved', `**Match #${matchId}** | **Mode:** ${mode}\n**Winners:** ${wNames} (${changeStr})\n**Losers:** ${lNames} (-${representativeChange})`)] });
  });
}

async function addVerifier(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner may assign verifier roles.')], ephemeral: true });
  const user = interaction.options.getUser('user');
  db.run('INSERT INTO verifiers (id,username) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username', [user.id, user.username], (err) => {
    if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed', 'Failed to assign verifier role.')], ephemeral: true });
    logAction(interaction.user.id, interaction.user.username, 'ADD_VERIFIER', `User: ${user.username} (${user.id})`);
    interaction.reply({ embeds: [createSuccessEmbed('Verifier Assigned', `✅ Verifier role assigned to <@${user.id}>.`)] });
  });
}

async function removeVerifier(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner may revoke verifier roles.')], ephemeral: true });
  const user = interaction.options.getUser('user');
  db.run('DELETE FROM verifiers WHERE id=?', [user.id], (err) => {
    if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed', 'Failed to revoke verifier role.')], ephemeral: true });
    logAction(interaction.user.id, interaction.user.username, 'REMOVE_VERIFIER', `User: ${user.username} (${user.id})`);
    interaction.reply({ embeds: [createInfoEmbed('Verifier Removed', `🗑️ Verifier removed: <@${user.id}>.`, 0xe74c3c)] });
  });
}

async function blacklistUser(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner may manage the restriction list.')], ephemeral: true });
  const user = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason provided';
  db.run('INSERT OR REPLACE INTO blacklist (id,username,reason) VALUES (?,?,?)', [user.id, user.username, reason], (err) => {
    if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed', 'Failed to restrict user.')], ephemeral: true });
    logAction(interaction.user.id, interaction.user.username, 'BLACKLIST', `User: ${user.username}, Reason: ${reason}`);
    interaction.reply({ embeds: [createInfoEmbed('User Restricted', `🚫 <@${user.id}> restricted.\nReason: ${reason}`, 0xe74c3c)] });
  });
}

async function unblacklistUser(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner may modify the restriction list.')], ephemeral: true });
  const user = interaction.options.getUser('user');
  db.run('DELETE FROM blacklist WHERE id=?', [user.id], (err) => {
    if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed', 'Failed to lift restriction.')], ephemeral: true });
    logAction(interaction.user.id, interaction.user.username, 'UNBLACKLIST', `User: ${user.username}`);
    interaction.reply({ embeds: [createSuccessEmbed('Restriction Lifted', `✅ Restriction lifted for <@${user.id}>.`)] });
  });
}

async function resetAll(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner may reset tournament data.')], ephemeral: true });
  db.run('DELETE FROM matches');
  db.run("UPDATE players SET mmr_data='{}',wins_data='{}',peak_mmr_data='{}'");
  logAction(interaction.user.id, interaction.user.username, 'RESET_ALL', 'All tournament data reset');
  await interaction.reply({ embeds: [createInfoEmbed('🚨 TOURNAMENT RESET INITIATED', 'All player ratings restored to default (100 MMR).', 0xe74c3c)] });
}

async function undoLastMatch(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the system owner may reverse match results.')], ephemeral: true });

  db.get('SELECT * FROM matches WHERE approved=1 ORDER BY id DESC LIMIT 1', [], (err, match) => {
    if (err || !match || !match.winner_mmr_before || !match.loser_mmr_before)
      return interaction.reply({ embeds: [createErrorEmbed('No Undoable Match', 'No approved matches available to reverse.')], ephemeral: true });

    try {
      const winnerBefore = JSON.parse(match.winner_mmr_before);
      const loserBefore = JSON.parse(match.loser_mmr_before);
      const mode = match.mode;

      const updatePlayer = (entry, wasWinner) => new Promise((resolve, reject) => {
        db.get('SELECT mmr_data,wins_data FROM players WHERE id=?', [entry.id], (err, row) => {
          if (err) return reject(err);
          const mmrData = JSON.parse(row.mmr_data);
          const winsData = JSON.parse(row.wins_data || '{}');
          mmrData[mode] = entry.mmr;
          if (wasWinner && winsData[mode] > 0) winsData[mode]--;
          db.run('UPDATE players SET mmr_data=?,wins_data=? WHERE id=?',
            [JSON.stringify(mmrData), JSON.stringify(winsData), entry.id],
            (err) => err ? reject(err) : resolve());
        });
      });

      const all = [
        ...winnerBefore.map(e => updatePlayer(e, true)),
        ...loserBefore.map(e => updatePlayer(e, false)),
      ];

      Promise.all(all).then(() => {
        db.run('DELETE FROM matches WHERE id=?', [match.id]);
        logAction(interaction.user.id, interaction.user.username, 'UNDO_MATCH', `Match #${match.id}`);
        interaction.reply({ embeds: [createSuccessEmbed('Match Reversed', `↩️ Reversed **Match #${match.id}**. Ratings restored.`)] });
      }).catch(() => interaction.reply({ embeds: [createErrorEmbed('Undo Failed', 'Failed to restore player ratings.')], ephemeral: true }));
    } catch {
      interaction.reply({ embeds: [createErrorEmbed('Undo Failed', 'An error occurred during reversal.')], ephemeral: true });
    }
  });
}

async function checkMMR(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  ensurePlayer(target.id, target.username).then(player => {
    let description = "";
    MODES.forEach(mode => {
      const mmr = player.mmr_data[mode] || 100;
      const { display } = getRankAndDivision(mmr);
      description += `**${mode}:** ${mmr} MMR (**${display}**)\n`;
    });
    interaction.reply({ embeds: [createInfoEmbed(`📊 ${target.username}'s Ratings`, description)] });
  }).catch(() => interaction.reply({ embeds: [createErrorEmbed('Player Not Found', 'Try /register first.')], ephemeral: true }));
}

async function showStats(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  try {
    const player = await ensurePlayer(target.id, target.username);
    const seasonNum = parseInt(await getConfigValue('season_number') || '1', 10);
    const nextReset = getNextSeasonResetTimestamp();

    let description = `**Season:** S${seasonNum}\n**Next Reset:** <t:${nextReset}:R>\n\n`;

    for (const mode of MODES) {
      const mmr = player.mmr_data[mode] || 100;
      const wins = (player.wins_data && player.wins_data[mode]) || 0;
      const { display } = getRankAndDivision(mmr);
      const peakMMR = (player.peak_mmr_data && player.peak_mmr_data[mode]) || mmr;
      const { display: peakDisplay } = getRankAndDivision(peakMMR);
      const PLACEMENT_THRESHOLD = 20;
      const placementLeft = Math.max(0, PLACEMENT_THRESHOLD - wins);
      const K = wins < PLACEMENT_THRESHOLD ? 80 : 32;

      description +=
        `**— ${mode} —**\n` +
        `🏅 **Rank:** ${display}\n` +
        `📈 **MMR:** ${mmr}\n` +
        `⭐ **Season Peak:** ${peakDisplay} (${peakMMR})\n` +
        `🏆 **Wins:** ${wins}\n` +
        `⚡ **K-Factor:** ${K} (${K === 80 ? 'Placement Phase' : 'Standard'})\n` +
        (placementLeft > 0 ? `🔶 **Placement:** ${placementLeft} games remaining\n` : `✅ **Placement:** Complete\n`) +
        `\n`;
    }

    const equippedTitle = player.equipped_title || 'None';
    description += `🎖️ **Equipped Title:** ${equippedTitle}`;

    const topMMR = Math.max(...MODES.map(m => player.mmr_data[m] || 100));
    const { color } = getRankAndDivision(topMMR);

    await interaction.followUp({ embeds: [
      new EmbedBuilder().setColor(color)
        .setTitle(`🏅 ${target.username}'s Player Card`)
        .setDescription(description)
        .setTimestamp()
        .setFooter({ text: `Season ${seasonNum} • Rocket League Competitive` })
    ]});
  } catch (err) {
    console.error(err);
    await interaction.followUp({ embeds: [createErrorEmbed('Error', 'Could not load player stats.')], ephemeral: true });
  }
}

async function showLeaderboard(interaction) {
  const mode = interaction.options.getString('mode') || '1v1';
  if (!MODES.includes(mode)) return interaction.reply({ embeds: [createErrorEmbed('Invalid Mode', `Available modes: ${MODES.join(', ')}`)], ephemeral: true });

  db.all('SELECT id,username,mmr_data FROM players', [], (err, rows) => {
    if (err || rows.length === 0) return interaction.reply({ embeds: [createInfoEmbed('No Players', 'No participants found.')] });
    const players = rows.map(row => {
      try { const d = JSON.parse(row.mmr_data); return { id: row.id, username: row.username, mmr: d[mode] || 100 }; }
      catch { return { id: row.id, username: row.username, mmr: 100 }; }
    }).sort((a, b) => b.mmr - a.mmr).slice(0, 10);

    const MEDALS = ['🥇', '🥈', '🥉'];
    let description = "";
    players.forEach((p, i) => {
      const { display } = getRankAndDivision(p.mmr);
      description += `${MEDALS[i] || `**${i + 1}.**`} **${p.username}** — ${p.mmr} MMR (**${display}**)\n`;
    });
    interaction.reply({ embeds: [createInfoEmbed(`🏆 ${mode} Leaderboard`, description)] });
  });
}

async function showHelp(interaction) {
  const isMod = await isAuthorized(interaction.user.id);
  const seasonNum = parseInt(await getConfigValue('season_number') || '1', 10);
  const nextReset = getNextSeasonResetTimestamp();

  let description =
    `**📅 Season S${seasonNum}** — Resets <t:${nextReset}:R>\n\n` +
    `🔹 **PLAYER COMMANDS**\n` +
    `/register        — Enroll in the system\n` +
    `/submit_match    — Report a match result\n` +
    `/elo             — Quick MMR & rank check\n` +
    `/stats           — Full player card (placement, K-factor, peak)\n` +
    `/leaderboard     — Top 10 rankings\n` +
    `/match_log       — Detailed match history\n` +
    `/match_history   — Recent match summary\n` +
    `/profile         — Profile with titles\n` +
    `/tournaments     — View tournaments\n` +
    `/manage_title    — Equip/unequip a title\n\n`;

  if (isMod) {
    description +=
      `🔸 **MODERATOR COMMANDS**\n` +
      `/pending         — Review pending submissions\n` +
      `/approve_match   — Confirm a result\n` +
      `/approve_all     — Approve all pending\n` +
      `/add_verifier    — Grant mod rights\n` +
      `/remove_verifier — Revoke mod rights\n` +
      `/blacklist       — Restrict a user\n` +
      `/unblacklist     — Lift restriction\n` +
      `/reset_all       — Full data reset (OWNER)\n` +
      `/undo_last       — Reverse last match (OWNER)\n` +
      `/logs            — View action logs\n\n`;
  }

  description +=
    `⚙️ **RANK TIERS** (with divisions IV → I each)\n` +
    `Beginner → Amateur → Challenge → Semi-Pro → Professional → Ascendant → Godlike\n\n` +
    `🛡️ **2v2 Anti-Boost:** Team MMR = 80% highest + 20% lowest. At 1250+ MMR, team = highest.`;

  const embed = new EmbedBuilder().setColor(0x3498db)
    .setTitle('📋 ROCKET LEAGUE COMPETITIVE — HELP')
    .setDescription(description)
    .setFooter({ text: 'Use /tournament_types for all tournament formats' });
  interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showMatchLog(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  db.all(`SELECT id,mode,winner_team,loser_team,mmr_change,timestamp,approved FROM matches WHERE json_extract(winner_team,'$') LIKE ? OR json_extract(loser_team,'$') LIKE ? ORDER BY id DESC LIMIT 15`,
    [`%"${target.id}"%`, `%"${target.id}"%`], (err, rows) => {
      if (err || rows.length === 0) return interaction.reply({ embeds: [createInfoEmbed('📜 Match Log', `${target.username} has no recorded matches.`)] });
      let description = '';
      rows.reverse().forEach(row => {
        const winners = JSON.parse(row.winner_team), losers = JSON.parse(row.loser_team);
        const isWinner = winners.includes(target.id);
        const opp = isWinner ? losers.map(id => `<@${id}>`).join(', ') : winners.map(id => `<@${id}>`).join(', ');
        const status = isWinner ? '🟢 Win' : '🔴 Loss';
        const change = isWinner ? `+${row.mmr_change}` : `-${row.mmr_change}`;
        description += `**#${row.id}** • [${row.mode}] vs ${opp} • ${status} (${change}) • ${new Date(row.timestamp).toLocaleDateString()}\n`;
      });
      interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle(`📜 ${target.username}'s Match Log`).setDescription(description).setFooter({ text: 'Last 15 matches' })] });
    });
}

async function showMatchHistory(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  db.all(`SELECT mode,winner_team,loser_team,timestamp,approved FROM matches WHERE json_extract(winner_team,'$') LIKE ? OR json_extract(loser_team,'$') LIKE ? ORDER BY timestamp DESC LIMIT 10`,
    [`%"${target.id}"%`, `%"${target.id}"%`], (err, rows) => {
      if (err || rows.length === 0) return interaction.reply({ embeds: [createInfoEmbed('No Match History', `${target.username} has no recorded matches.`)] });
      let description = '';
      rows.forEach((row, i) => {
        const winners = JSON.parse(row.winner_team), losers = JSON.parse(row.loser_team);
        const isWinner = winners.includes(target.id);
        const opp = isWinner ? losers.map(id => `<@${id}>`).join(', ') : winners.map(id => `<@${id}>`).join(', ');
        description += `**${i + 1}.** [${row.mode}] vs ${opp} • ${isWinner ? '🟢 Win' : '🔴 Loss'}\n`;
      });
      interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle(`📊 ${target.username}'s Match History`).setDescription(description).setFooter({ text: 'Latest 10 matches' })] });
    });
}

async function showProfile(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  const player = await ensurePlayer(target.id, target.username);
  const seasonNum = parseInt(await getConfigValue('season_number') || '1', 10);

  let description = `**Season S${seasonNum}**\n\n**📊 MMR & Rank**\n`;
  MODES.forEach(mode => {
    const mmr = player.mmr_data[mode] || 100;
    const { display } = getRankAndDivision(mmr);
    const wins = (player.wins_data && player.wins_data[mode]) || 0;
    description += `• **${mode}:** ${mmr} MMR (**${display}**) ${wins < 20 ? `🔶 Placement (${20 - wins} left)` : ''}\n`;
  });

  description += "\n**📈 Last 5 Matches**\n";
  const matches = await new Promise((resolve) => {
    db.all(`SELECT id,mode,winner_team,loser_team,mmr_change FROM matches WHERE json_extract(winner_team,'$') LIKE ? OR json_extract(loser_team,'$') LIKE ? ORDER BY id DESC LIMIT 5`,
      [`%"${target.id}"%`, `%"${target.id}"%`], (err, rows) => resolve(err ? [] : rows.reverse()));
  });

  if (matches.length === 0) description += "No matches played yet.\n";
  else matches.forEach(row => {
    const winners = JSON.parse(row.winner_team), isWinner = winners.includes(target.id);
    const opp = isWinner ? JSON.parse(row.loser_team).map(id => `<@${id}>`).join(', ') : JSON.parse(row.winner_team).map(id => `<@${id}>`).join(', ');
    const change = isWinner ? `+${row.mmr_change}` : `-${row.mmr_change}`;
    description += `• **#${row.id}** [${row.mode}] vs ${opp} — ${isWinner ? '🟢 Win' : '🔴 Loss'} (${change})\n`;
  });

  const titles = await new Promise((resolve) => {
    db.all('SELECT title,source FROM player_titles WHERE player_id=?', [target.id], (err, rows) => resolve(err ? [] : rows));
  });

  description += "\n**🏆 Titles & Achievements**\n";
  if (titles.length === 0) description += "None yet.\n";
  else titles.forEach(t => { description += `${t.source === 'season_reset' ? '🏅' : '🏆'} "${t.title}"\n`; });
  description += `\n✨ **Equipped:** ${player.equipped_title || 'None'}`;

  const topMMR = Math.max(...MODES.map(m => player.mmr_data[m] || 100));
  const { color } = getRankAndDivision(topMMR);

  await interaction.followUp({ embeds: [
    new EmbedBuilder().setColor(color).setTitle(`🏅 ${target.username}'s Profile`)
      .setDescription(description).setFooter({ text: 'Use /manage_title to equip a title' })
  ]});
}

async function addTournamentHost(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the bot owner can assign tournament hosts.')], ephemeral: true });
  const user = interaction.options.getUser('user');
  db.run('INSERT OR IGNORE INTO tournament_hosts (id,username) VALUES (?,?)', [user.id, user.username], (err) => {
    if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed', 'Failed to assign tournament host.')], ephemeral: true });
    logAction(interaction.user.id, interaction.user.username, 'ADD_TOURNAMENT_HOST', `User: ${user.username}`);
    interaction.reply({ embeds: [createSuccessEmbed('Host Assigned', `✅ <@${user.id}> can now create tournaments.`)] });
  });
}

async function removeTournamentHost(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only the bot owner can remove tournament hosts.')], ephemeral: true });
  const user = interaction.options.getUser('user');
  db.run('DELETE FROM tournament_hosts WHERE id=?', [user.id], (err) => {
    if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed', 'Failed to remove tournament host.')], ephemeral: true });
    logAction(interaction.user.id, interaction.user.username, 'REMOVE_TOURNAMENT_HOST', `User: ${user.username}`);
    interaction.reply({ embeds: [createInfoEmbed('Host Removed', `🗑️ <@${user.id}> can no longer create tournaments.`, 0xe74c3c)] });
  });
}

function isValidDate(dateStr) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;
  const d = new Date(dateStr);
  return d.toISOString().slice(0, 10) === dateStr;
}

async function createTournament(interaction) {
  if (!await isTournamentHost(interaction.user.id))
    return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'You must be a tournament host to create tournaments.')], ephemeral: true });

  const name = interaction.options.getString('name'), mode = interaction.options.getString('mode'), type = interaction.options.getString('type');
  const minMMR = interaction.options.getInteger('min_mmr') || 0, maxMMR = interaction.options.getInteger('max_mmr') || 5000;
  const mmrRange = interaction.options.getInteger('mmr_range') || 0, startDate = interaction.options.getString('start_date');
  const assignRole = interaction.options.getBoolean('assign_role') || false;
  const bestOf = interaction.options.getInteger('best_of') || 1, totalRounds = interaction.options.getInteger('total_rounds') || 0;

  if (!TOURNAMENT_TYPES[type]) return interaction.reply({ embeds: [createErrorEmbed('Invalid Type', 'Please select a valid tournament type.')], ephemeral: true });
  if (type === 'best_of_series' && bestOf % 2 === 0) return interaction.reply({ embeds: [createErrorEmbed('Invalid Best-of', 'Best-of series must be an odd number.')], ephemeral: true });
  if (startDate && !isValidDate(startDate)) return interaction.reply({ embeds: [createErrorEmbed('Invalid Date', 'Use YYYY-MM-DD format.')], ephemeral: true });

  db.run(`INSERT INTO tournaments (name,mode,type,min_mmr,max_mmr,mmr_range,host_id,start_date,best_of,total_rounds) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [name, mode, type, minMMR, maxMMR, mmrRange, interaction.user.id, startDate, bestOf, totalRounds],
    async function (err) {
      if (err) return interaction.reply({ embeds: [createErrorEmbed('Creation Failed', 'Please try again later.')], ephemeral: true });
      const tid = this.lastID, info = TOURNAMENT_TYPES[type];
      let desc = `**📋 Format:** ${info.name}\n**🎮 Mode:** ${mode}\n**🆔 ID:** ${tid}\n`;
      if (type === 'best_of_series') desc += `**🎯 Best-of:** ${bestOf}\n`;
      if (totalRounds > 0) desc += `**🔄 Total Rounds:** ${totalRounds}\n`;
      desc += `**📅 Start Date:** ${startDate || 'TBD'}\n*${info.description}*`;
      const embed = new EmbedBuilder().setColor(info.color).setTitle(`✅ Tournament Created: ${name}`).setDescription(desc);
      if (assignRole) {
        try {
          await interaction.guild.roles.create({ name: `Tournament-${tid}`, color: info.color, reason: `Tournament ${tid}` });
          embed.addFields({ name: '🎭 Role Created', value: `"Tournament-${tid}" for participants` });
        } catch { embed.addFields({ name: '⚠️ Role Warning', value: 'Could not create Discord role.' }); }
      }
      logAction(interaction.user.id, interaction.user.username, 'CREATE_TOURNAMENT', `Name: ${name}, Type: ${type}, ID: ${tid}`);
      await interaction.reply({ embeds: [embed] });
    });
}

async function joinTournament(interaction) {
  const tournamentId = interaction.options.getInteger('id');
  const player = await ensurePlayer(interaction.user.id, interaction.user.username);
  db.get('SELECT * FROM tournaments WHERE id=?', [tournamentId], async (err, tourney) => {
    if (err || !tourney) return interaction.reply({ embeds: [createErrorEmbed('Not Found', 'The tournament ID is invalid.')], ephemeral: true });
    const playerMMR = player.mmr_data[tourney.mode] || 100;
    if (playerMMR < tourney.min_mmr || playerMMR > tourney.max_mmr)
      return interaction.reply({ embeds: [createErrorEmbed('MMR Requirements Not Met', `Your MMR (${playerMMR}) doesn't meet requirements (${tourney.min_mmr}-${tourney.max_mmr}).`)], ephemeral: true });
    db.run(`INSERT OR IGNORE INTO tournament_participants (tournament_id,player_id) VALUES (?,?)`, [tournamentId, interaction.user.id], async (err) => {
      if (err) return interaction.reply({ embeds: [createErrorEmbed('Failed to Join', 'Please try again later.')], ephemeral: true });
      const roleAssigned = await assignTournamentRole(interaction.guild, interaction.user.id, `Tournament-${tournamentId}`);
      let response = `✅ Joined tournament "${tourney.name}"!`;
      if (roleAssigned) response += `\n🎭 Assigned role: Tournament-${tournamentId}`;
      logAction(interaction.user.id, interaction.user.username, 'JOIN_TOURNAMENT', `ID: ${tournamentId}, Name: ${tourney.name}`);
      await interaction.reply({ embeds: [createSuccessEmbed('Tournament Joined', response)] });
    });
  });
}

async function showTournaments(interaction) {
  const status = interaction.options.getString('status') || 'all';
  let query = 'SELECT * FROM tournaments';
  if (status !== 'all') query += ` WHERE status='${status}'`;
  query += ' ORDER BY start_date ASC LIMIT 10';
  db.all(query, [], (err, tournaments) => {
    if (err || tournaments.length === 0) return interaction.reply({ embeds: [createInfoEmbed('No Tournaments', 'No tournaments found.')] });
    let description = "";
    tournaments.forEach(t => {
      const emoji = t.status === 'upcoming' ? '📅' : t.status === 'active' ? '🎮' : '✅';
      description += `${emoji} **[${t.id}] ${t.name}**\nMode: ${t.mode} | Type: ${TOURNAMENT_TYPES[t.type]?.name || t.type}\nMMR: ${t.min_mmr}-${t.max_mmr}`;
      if (t.mmr_range > 0) description += ` (±${t.mmr_range})`;
      description += `\nDate: ${t.start_date || 'TBD'}\n\n`;
    });
    interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('🏆 Tournaments').setDescription(description)] });
  });
}

async function awardTitle(interaction) {
  if (!await isTournamentHost(interaction.user.id))
    return interaction.reply({ embeds: [createErrorEmbed('Permission Denied', 'Only tournament hosts can award titles.')], ephemeral: true });
  const tournamentId = interaction.options.getInteger('tournament_id');
  const winner = interaction.options.getUser('winner'), title = interaction.options.getString('title');
  db.run(`INSERT INTO player_titles (player_id,title,tournament_id,awarded_by) VALUES (?,?,?,?)`, [winner.id, title, tournamentId, interaction.user.id]);
  db.run(`UPDATE players SET equipped_title=CASE WHEN equipped_title='' THEN ? ELSE equipped_title END WHERE id=?`, [title, winner.id]);
  logAction(interaction.user.id, interaction.user.username, 'AWARD_TITLE', `Title: "${title}", Winner: ${winner.username}`);
  interaction.reply({ embeds: [createSuccessEmbed('Title Awarded', `🏆 Title "${title}" awarded to <@${winner.id}>!`)] });
}

async function manageTitle(interaction) {
  const action = interaction.options.getString('action'), title = interaction.options.getString('title');
  if (action === 'equip') {
    db.get('SELECT 1 FROM player_titles WHERE player_id=? AND title=?', [interaction.user.id, title], (err, row) => {
      if (!row) return interaction.reply({ embeds: [createErrorEmbed('Title Not Owned', "You don't own this title.")], ephemeral: true });
      db.run('UPDATE players SET equipped_title=? WHERE id=?', [title, interaction.user.id]);
      logAction(interaction.user.id, interaction.user.username, 'EQUIP_TITLE', `Title: "${title}"`);
      interaction.reply({ embeds: [createSuccessEmbed('Title Equipped', `✨ Equipped: "${title}"`)] });
    });
  } else {
    db.run('UPDATE players SET equipped_title="" WHERE id=?', [interaction.user.id]);
    logAction(interaction.user.id, interaction.user.username, 'UNEQUIP_TITLE', '');
    interaction.reply({ embeds: [createSuccessEmbed('Title Unequipped', '✨ Title unequipped.')] });
  }
}

async function showTournamentTypes(interaction) {
  const overviewEmbed = new EmbedBuilder().setColor(0x3498db).setTitle('🏆 Tournament Formats')
    .setDescription('Use `/create_tournament type:[type]` to create a tournament')
    .addFields({ name: 'Quick Reference', value: 'See detailed descriptions below' });
  await interaction.reply({ embeds: [overviewEmbed] });
  const embeds = Object.entries(TOURNAMENT_TYPES).map(([key, type]) =>
    new EmbedBuilder().setColor(type.color).setTitle(`📋 ${type.name}`).setDescription(type.description)
      .addFields({ name: 'Command', value: `\`/create_tournament type:${key}\`` }));
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    if (i === 0) await interaction.followUp({ embeds: batch });
    else await interaction.channel.send({ embeds: batch });
  }
}

async function showLogs(interaction) {
  if (!await isAuthorized(interaction.user.id))
    return interaction.reply({ embeds: [createErrorEmbed('Access Denied', 'Only owners and verifiers can view logs.')], ephemeral: true });
  db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 20', [], (err, rows) => {
    if (err || rows.length === 0) return interaction.reply({ embeds: [createInfoEmbed('No Logs', 'No actions recorded yet.')] });
    let description = '';
    rows.forEach(row => {
      description += `[${new Date(row.timestamp).toLocaleString()}] **${row.username}**: ${row.action}\n`;
      if (row.details) description += `> ${row.details}\n`;
    });
    interaction.reply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle('📋 Action Logs').setDescription(description).setFooter({ text: 'Last 20 actions' })] });
  });
}

// ======================
// BUTTON HANDLER
// ======================

async function handleButtonInteraction(interaction) {
  const { customId, message, user } = interaction;

  if (customId === 'gameroom_signup') {
    const signups = gameRoomSignups.get(message.id) || new Set();
    if (signups.has(user.id)) return interaction.reply({ content: '⚠️ You are already signed up!', ephemeral: true });
    signups.add(user.id);
    gameRoomSignups.set(message.id, signups);
    await interaction.reply({ content: `✅ **${user.username}** signed up! (${signups.size} total)` });
  }

  else if (customId === 'gameroom_leave') {
    const signups = gameRoomSignups.get(message.id) || new Set();
    if (!signups.has(user.id)) return interaction.reply({ content: '⚠️ You are not signed up.', ephemeral: true });
    signups.delete(user.id);
    gameRoomSignups.set(message.id, signups);
    await interaction.reply({ content: `❌ **${user.username}** left the queue. (${signups.size} remaining)` });
  }

  else if (customId === 'gameroom_randomize') {
    const isHost = user.id === BOT_OWNER_ID || await isAuthorized(user.id);
    if (!isHost) return interaction.reply({ content: '🚫 Only the host can randomize teams.', ephemeral: true });

    const signups = gameRoomSignups.get(message.id) || new Set();
    const players = Array.from(signups);

    if (players.length < 4)
      return interaction.reply({ content: `⚠️ Need at least 4 players for 2v2. Currently: **${players.length}**`, ephemeral: true });

    // Fisher-Yates shuffle
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }

    const matches = [];
    for (let i = 0; i + 3 < players.length; i += 4) {
      matches.push({ team1: [players[i], players[i + 1]], team2: [players[i + 2], players[i + 3]] });
    }
    const leftover = players.slice(matches.length * 4);

    let result = `🎲 **Teams Randomized!**\n\n`;
    matches.forEach((m, idx) => {
      result += `**Match ${idx + 1}:**\n🔵 Team A: <@${m.team1[0]}> & <@${m.team1[1]}>\n🔴 Team B: <@${m.team2[0]}> & <@${m.team2[1]}>\n\n`;
    });
    if (leftover.length > 0) result += `⏳ **Waiting:** ${leftover.map(id => `<@${id}>`).join(', ')}`;

    const embed = new EmbedBuilder().setColor(0xf39c12).setTitle('🎲 Game Room — Teams Set!')
      .setDescription(result).setTimestamp().setFooter({ text: 'Use /submit_match to report results' });
    await interaction.reply({ embeds: [embed] });
  }
}

// ======================
// COMMAND REGISTRATION
// ======================

const commands = [
  new SlashCommandBuilder().setName('register').setDescription('Join the competitive system'),
  new SlashCommandBuilder().setName('submit_match').setDescription('Report a match result')
    .addStringOption(o => o.setName('mode').setDescription('Game mode').setRequired(true).addChoices(MODES.map(m => ({ name: m, value: m }))))
    .addUserOption(o => o.setName('winner1').setDescription('Winner 1').setRequired(true))
    .addUserOption(o => o.setName('loser1').setDescription('Loser 1').setRequired(true))
    .addUserOption(o => o.setName('winner2').setDescription('Winner 2 (2v2 only)'))
    .addUserOption(o => o.setName('loser2').setDescription('Loser 2 (2v2 only)')),
  new SlashCommandBuilder().setName('pending').setDescription('View pending submissions'),
  new SlashCommandBuilder().setName('approve_match').setDescription('Approve a submission').addIntegerOption(o => o.setName('id').setDescription('Submission ID').setRequired(true)),
  new SlashCommandBuilder().setName('approve_all').setDescription('Approve all pending submissions'),
  new SlashCommandBuilder().setName('add_verifier').setDescription('Add a verifier').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('remove_verifier').setDescription('Remove a verifier').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('blacklist').setDescription('Ban a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('unblacklist').setDescription('Unban a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('reset_all').setDescription('Reset all data'),
  new SlashCommandBuilder().setName('undo_last').setDescription('Undo last match'),
  new SlashCommandBuilder().setName('elo').setDescription('Quick MMR & rank check').addUserOption(o => o.setName('user').setDescription('User')),
  new SlashCommandBuilder().setName('stats').setDescription('View detailed player card').addUserOption(o => o.setName('user').setDescription('Player to check')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboard').addStringOption(o => o.setName('mode').setDescription('Game mode').addChoices(MODES.map(m => ({ name: m, value: m })))),
  new SlashCommandBuilder().setName('help').setDescription('Show help & season info'),
  new SlashCommandBuilder().setName('match_log').setDescription('View detailed match history').addUserOption(o => o.setName('user').setDescription('Player to check')),
  new SlashCommandBuilder().setName('match_history').setDescription('View match history').addUserOption(o => o.setName('user').setDescription('Player to check')),
  new SlashCommandBuilder().setName('profile').setDescription('View your profile & titles').addUserOption(o => o.setName('user').setDescription('Player to check')),
  new SlashCommandBuilder().setName('add_tournament_host').setDescription('Add tournament host (owner only)').addUserOption(o => o.setName('user').setDescription('User to promote').setRequired(true)),
  new SlashCommandBuilder().setName('remove_tournament_host').setDescription('Remove tournament host (owner only)').addUserOption(o => o.setName('user').setDescription('User to demote').setRequired(true)),
  new SlashCommandBuilder().setName('create_tournament').setDescription('Create a tournament (hosts only)')
    .addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('Game mode').setRequired(true).addChoices(MODES.map(m => ({ name: m, value: m }))))
    .addStringOption(o => o.setName('type').setDescription('Tournament type').setRequired(true).addChoices(Object.entries(TOURNAMENT_TYPES).map(([value, type]) => ({ name: type.name, value }))))
    .addIntegerOption(o => o.setName('min_mmr').setDescription('Minimum MMR'))
    .addIntegerOption(o => o.setName('max_mmr').setDescription('Maximum MMR'))
    .addIntegerOption(o => o.setName('mmr_range').setDescription('MMR range'))
    .addStringOption(o => o.setName('start_date').setDescription('Start date (YYYY-MM-DD)'))
    .addBooleanOption(o => o.setName('assign_role').setDescription('Create Discord role for participants'))
    .addIntegerOption(o => o.setName('best_of').setDescription('Best-of games (for series)'))
    .addIntegerOption(o => o.setName('total_rounds').setDescription('Total rounds (for Swiss/League)')),
  new SlashCommandBuilder().setName('join_tournament').setDescription('Join a tournament').addIntegerOption(o => o.setName('id').setDescription('Tournament ID').setRequired(true)),
  new SlashCommandBuilder().setName('tournaments').setDescription('View tournaments').addStringOption(o => o.setName('status').setDescription('Filter by status').addChoices([{ name: 'All', value: 'all' }, { name: 'Upcoming', value: 'upcoming' }, { name: 'Active', value: 'active' }, { name: 'Completed', value: 'completed' }])),
  new SlashCommandBuilder().setName('award_title').setDescription('Award title to winner (hosts only)')
    .addIntegerOption(o => o.setName('tournament_id').setDescription('Tournament ID').setRequired(true))
    .addUserOption(o => o.setName('winner').setDescription('Winner').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Title text').setRequired(true)),
  new SlashCommandBuilder().setName('manage_title').setDescription('Equip or unequip title')
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices([{ name: 'Equip', value: 'equip' }, { name: 'Unequip', value: 'unequip' }]))
    .addStringOption(o => o.setName('title').setDescription('Title to equip')),
  new SlashCommandBuilder().setName('tournament_types').setDescription('View all available tournament formats'),
  new SlashCommandBuilder().setName('logs').setDescription('View action logs (owners/verifiers only)'),
].map(cmd => cmd.toJSON());

// ======================
// CLIENT & STARTUP
// ======================

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log(`✅ Bot ready as ${client.user.tag}`);
  client.guilds.cache.forEach(async (guild) => { await setupRainbowRole(guild); });
  startCronJobs(client);
});

client.on('guildCreate', async (guild) => { await setupRainbowRole(guild); });

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
(async () => {
  try {
    console.log('📡 Deploying slash commands...');
    await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: commands });
    console.log('✅ Commands deployed successfully.');
  } catch (error) { console.error('⚠️ Command deployment failed:', error); }
})();

client.on('interactionCreate', async interaction => {
  // Button interactions
  if (interaction.isButton()) {
    try { await handleButtonInteraction(interaction); }
    catch (e) { console.error('[BUTTON ERROR]', e); if (!interaction.replied) await interaction.reply({ content: 'An error occurred.', ephemeral: true }).catch(() => {}); }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  const SLOW_COMMANDS = ['submit_match', 'approve_match', 'approve_all', 'create_tournament', 'join_tournament',
    'reset_all', 'undo_last', 'add_verifier', 'remove_verifier', 'blacklist', 'unblacklist', 'award_title', 'stats', 'profile'];
  if (SLOW_COMMANDS.includes(commandName)) await interaction.deferReply({ ephemeral: false });

  try {
    if (commandName === 'register') await registerPlayer(interaction);
    else if (commandName === 'submit_match') await submitMatch(interaction);
    else if (commandName === 'pending') await listPending(interaction);
    else if (commandName === 'approve_match') await approveMatch(interaction);
    else if (commandName === 'approve_all') await approveAllMatches(interaction);
    else if (commandName === 'add_verifier') await addVerifier(interaction);
    else if (commandName === 'remove_verifier') await removeVerifier(interaction);
    else if (commandName === 'blacklist') await blacklistUser(interaction);
    else if (commandName === 'unblacklist') await unblacklistUser(interaction);
    else if (commandName === 'reset_all') await resetAll(interaction);
    else if (commandName === 'undo_last') await undoLastMatch(interaction);
    else if (commandName === 'elo') await checkMMR(interaction);
    else if (commandName === 'stats') await showStats(interaction);
    else if (commandName === 'leaderboard') await showLeaderboard(interaction);
    else if (commandName === 'help') await showHelp(interaction);
    else if (commandName === 'match_log') await showMatchLog(interaction);
    else if (commandName === 'match_history') await showMatchHistory(interaction);
    else if (commandName === 'profile') await showProfile(interaction);
    else if (commandName === 'add_tournament_host') await addTournamentHost(interaction);
    else if (commandName === 'remove_tournament_host') await removeTournamentHost(interaction);
    else if (commandName === 'create_tournament') await createTournament(interaction);
    else if (commandName === 'join_tournament') await joinTournament(interaction);
    else if (commandName === 'tournaments') await showTournaments(interaction);
    else if (commandName === 'award_title') await awardTitle(interaction);
    else if (commandName === 'manage_title') await manageTitle(interaction);
    else if (commandName === 'tournament_types') await showTournamentTypes(interaction);
    else if (commandName === 'logs') await showLogs(interaction);
    else {
      const embed = createErrorEmbed('Unknown Command', 'This command is not recognized.');
      if (interaction.replied || interaction.deferred) await interaction.followUp({ embeds: [embed], ephemeral: true });
      else await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (error) {
    console.error(`[COMMAND ERROR] ${commandName}:`, error);
    const embed = createErrorEmbed('Command Failed', 'An unexpected error occurred. Please notify staff.');
    if (interaction.replied || interaction.deferred) await interaction.followUp({ embeds: [embed], ephemeral: true });
    else await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

client.login(BOT_TOKEN).catch(err => { console.error('❌ Failed to log in:', err); });