require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPLICATION_ID = process.env.APPLICATION_ID;

if (!BOT_TOKEN || !APPLICATION_ID || !BOT_OWNER_ID) {
    console.error('❌ Missing required environment variables. Check your .env file.');
    process.exit(1);
}

const MODES = ['1v1', '2v2'];

const TOURNAMENT_TYPES = {
    'single_elimination': { name: 'Single Elimination', description: 'Players are paired in matches. The loser of each match is eliminated. Winners advance to the next round. The tournament ends when one undefeated player remains.', elimination_logic: 'single_elimination', bracket_type: 'knockout', color: 0x3498db },
    'double_elimination': { name: 'Double Elimination', description: 'Players are eliminated only after losing two matches. All players start in the winners bracket. A first loss moves a player to the losers bracket. A second loss eliminates the player. The final winner may need to defeat the winners bracket finalist twice, depending on rules.', elimination_logic: 'double_elimination', bracket_type: 'double_bracket', color: 0xe74c3c }
};

const dbPath = path.join(__dirname, 'tournament.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run("PRAGMA journal_mode=WAL;");
    db.run("PRAGMA synchronous=NORMAL;");
    
    db.run(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, username TEXT, mmr_data TEXT DEFAULT '{}', equipped_title TEXT DEFAULT '')`);
    db.run(`CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, winner_team TEXT NOT NULL, loser_team TEXT NOT NULL, winner_mmr_before TEXT, loser_mmr_before TEXT, mmr_change INTEGER NOT NULL, approved BOOLEAN DEFAULT 0, approved_by TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS verifiers (id TEXT PRIMARY KEY, username TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS blacklist (id TEXT PRIMARY KEY, username TEXT, reason TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS tournament_hosts (id TEXT PRIMARY KEY, username TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mode TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'upcoming', min_mmr INTEGER DEFAULT 0, max_mmr INTEGER DEFAULT 5000, mmr_range INTEGER DEFAULT 0, host_id TEXT NOT NULL, start_date TEXT, total_rounds INTEGER DEFAULT 0, current_round INTEGER DEFAULT 0, best_of INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS tournament_participants (tournament_id INTEGER, player_id TEXT, eliminated BOOLEAN DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, draws INTEGER DEFAULT 0, points INTEGER DEFAULT 0, rank INTEGER, bracket_position TEXT, seed INTEGER, FOREIGN KEY (tournament_id) REFERENCES tournaments(id), FOREIGN KEY (player_id) REFERENCES players(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS tournament_matches (id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, match_id INTEGER, round INTEGER, match_type TEXT, player1_id TEXT, player2_id TEXT, winner_id TEXT, games_won_p1 INTEGER DEFAULT 0, games_won_p2 INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', bracket_position TEXT, FOREIGN KEY (tournament_id) REFERENCES tournaments(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS player_titles (player_id TEXT, title TEXT, tournament_id INTEGER, awarded_by TEXT, awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (player_id) REFERENCES players(id), FOREIGN KEY (tournament_id) REFERENCES tournaments(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, action TEXT, details TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)`);
});

function checkpointAndCloseDatabase() {
    db.serialize(() => {
        db.run('PRAGMA wal_checkpoint(FULL);');
        db.close();
    });
}

function checkpointDatabase() {
    db.run('PRAGMA wal_checkpoint(FULL);');
}

process.on('SIGINT', checkpointAndCloseDatabase);
process.on('SIGTERM', checkpointAndCloseDatabase);
process.on('beforeExit', checkpointAndCloseDatabase);

setInterval(checkpointDatabase, 5 * 60 * 1000);

// ===== Metadata Helpers =====
function setMetadata(key, value) {
    return new Promise((resolve, reject) => {
        db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value], function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getMetadata(key, defaultValue = null) {
    return new Promise((resolve, reject) => {
        db.get('SELECT value FROM metadata WHERE key = ?', [key], (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.value : defaultValue);
        });
    });
}

function getDefaultMMRData() {
    const data = {};
    MODES.forEach(mode => data[mode] = 100);
    return data;
}

function getRankName(mode, elo) {
    if (mode === '1v1') {
        if (elo >= 2000) return 'Godlike';
        if (elo >= 1400) return 'Ascendant';
        if (elo >= 1200) return 'Professional';
        if (elo >= 1000) return 'Semi-Pro';
        if (elo >= 800) return 'Challenge';
        if (elo >= 600) return 'Amateur';
        return 'Beginner';
    } else {
        if (elo >= 2000) return 'Godlike';
        if (elo >= 1250) return 'Ascendant';
        if (elo >= 1050) return 'Professional';
        if (elo >= 850) return 'Semi-Pro';
        if (elo >= 650) return 'Challenge';
        if (elo >= 450) return 'Amateur';
        return 'Beginner';
    }
}

function isAuthorized(userId) {
    return new Promise((resolve) => {
        if (userId === BOT_OWNER_ID) return resolve(true);
        db.get('SELECT 1 FROM verifiers WHERE id = ?', [userId], (err, row) => {
            resolve(!!row);
        });
    });
}

function isBlacklisted(userId) {
    return new Promise((resolve) => {
        db.get('SELECT 1 FROM blacklist WHERE id = ?', [userId], (err, row) => {
            resolve(!!row);
        });
    });
}

function isTournamentHost(userId) {
    return new Promise((resolve) => {
        if (userId === BOT_OWNER_ID) return resolve(true);
        db.get('SELECT 1 FROM verifiers WHERE id = ?', [userId], (err, row) => {
            if (row) return resolve(true);
            db.get('SELECT 1 FROM tournament_hosts WHERE id = ?', [userId], (err, row2) => {
                resolve(!!row2);
            });
        });
    });
}

function ensurePlayer(playerId, username) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM players WHERE id = ?', [playerId], (err, row) => {
            if (err) return reject(err);
            if (!row) {
                const defaultData = getDefaultMMRData();
                db.run('INSERT INTO players (id, username, mmr_data) VALUES (?, ?, ?)', [playerId, username, JSON.stringify(defaultData)], (err) => {
                    if (err) reject(err);
                    else resolve({ id: playerId, username, mmr_data: defaultData });
                });
            } else {
                try {
                    const mmrData = JSON.parse(row.mmr_data);
                    let updated = false;
                    MODES.forEach(mode => {
                        if (mmrData[mode] === undefined) {
                            mmrData[mode] = 100;
                            updated = true;
                        }
                    });
                    if (updated) {
                        db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(mmrData), playerId]);
                    }
                    resolve({ id: playerId, username: row.username, mmr_data: mmrData });
                } catch (e) {
                    reject(e);
                }
            }
        });
    });
}

async function assignTournamentRole(guild, userId, roleName) {
    try {
        const member = await guild.members.fetch(userId);
        const role = guild.roles.cache.find(r => r.name === roleName);
        if (role) {
            await member.roles.add(role);
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function removeTournamentRole(guild, userId, roleName) {
    try {
        const member = await guild.members.fetch(userId);
        const role = guild.roles.cache.find(r => r.name === roleName);
        if (role) {
            await member.roles.remove(role);
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function processTournamentElimination(tournamentId, matchData, guild) {
    return new Promise((resolve) => {
        db.get('SELECT type FROM tournaments WHERE id = ?', [tournamentId], (err, tourney) => {
            if (err || !tourney) return resolve(false);
            const { type } = tourney;
            const logic = TOURNAMENT_TYPES[type]?.elimination_logic;
            
            switch (logic) {
                case 'single_elimination':
                    handleSingleElimination(tournamentId, matchData.loser_id, guild);
                    break;
                case 'double_elimination':
                    handleDoubleElimination(tournamentId, matchData, guild);
                    break;
                default:
                    handleSingleElimination(tournamentId, matchData.loser_id, guild);
            }
            resolve(true);
        });
    });
}

function handleSingleElimination(tournamentId, playerId, guild) {
    db.run(`UPDATE tournament_participants SET eliminated = 1 WHERE tournament_id = ? AND player_id = ?`, [tournamentId, playerId], () => {
        removeTournamentRole(guild, playerId, `Tournament-${tournamentId}`);
    });
}

function handleDoubleElimination(tournamentId, matchData, guild) {
    const { winner_id, loser_id } = matchData;
    db.get(`SELECT bracket_position FROM tournament_participants WHERE tournament_id = ? AND player_id = ?`, [tournamentId, loser_id], (err, loser) => {
        if (err) return;
        if (!loser || loser.bracket_position === 'winners') {
            db.run(`UPDATE tournament_participants SET bracket_position = 'losers', losses = losses + 1 WHERE tournament_id = ? AND player_id = ?`, [tournamentId, loser_id]);
        } else if (loser.bracket_position === 'losers') {
            db.run(`UPDATE tournament_participants SET eliminated = 1, losses = losses + 1 WHERE tournament_id = ? AND player_id = ?`, [tournamentId, loser_id], () => {
                removeTournamentRole(guild, loser_id, `Tournament-${tournamentId}`);
            });
        }
    });
}

function calculateMMRChange(winnerMMR, loserMMR) {
    const diff = loserMMR - winnerMMR;
    if (diff <= -100) return 0;
    if (diff <= -50) return Math.floor(Math.random() * 3) + 3;
    if (diff < 50) return Math.floor(Math.random() * 3) + 8;
    if (diff < 100) return Math.floor(Math.random() * 6) + 15;
    return Math.floor(Math.random() * 21) + 30;
}

function logAction(userId, username, action, details = '') {
    db.run('INSERT INTO logs (user_id, username, action, details) VALUES (?, ?, ?, ?)', [userId, username, action, details]);
}

function respondToInteraction(interaction, payload) {
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
    }
    return interaction.reply(payload);
}

function createSuccessEmbed(title, description) {
    return new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ ${title}`).setDescription(description).setTimestamp().setFooter({ text: 'Tournament System' });
}

function createErrorEmbed(title, description) {
    return new EmbedBuilder().setColor(0xe74c3c).setTitle(`❌ ${title}`).setDescription(description).setTimestamp().setFooter({ text: 'Tournament System' });
}

function createInfoEmbed(title, description, color = 0x3498db) {
    return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp().setFooter({ text: 'Tournament System' });
}

function buildLeaderboardEmbed({ mode, players, page, perPage }) {
    const totalPages = Math.max(1, Math.ceil(players.length / perPage));
    const currentPage = Math.min(Math.max(page, 1), totalPages);
    const startIndex = (currentPage - 1) * perPage;
    const pageEntries = players.slice(startIndex, startIndex + perPage);
    
    let description = '';
    pageEntries.forEach((p, index) => {
        const rank = getRankName(mode, p.mmr);
        const position = startIndex + index + 1;
        description += `${position}. **${p.username}** — ${p.mmr} ELO (**${rank}**)\n`;
    });
    
    if (!description) {
        description = 'No participants found.';
    }
    
    return createInfoEmbed(`🏆 ${mode} Leaderboard (Page ${currentPage}/${totalPages})`, description);
}

function buildLeaderboardButtons(mode, page, totalPages) {
    const prevDisabled = page <= 1;
    const nextDisabled = page >= totalPages;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`lb:${mode}:${page - 1}`)
            .setLabel('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(prevDisabled),
        new ButtonBuilder()
            .setCustomId(`lb:${mode}:${page + 1}`)
            .setLabel('➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(nextDisabled)
    );
    return row;
}

async function setupRainbowRole(guild) {
    try {
        const existingRole = guild.roles.cache.find(r => r.name === '✨ Tournament Creator');
        if (existingRole) return existingRole;
        
        const rainbowRole = await guild.roles.create({
            name: '✨ Tournament Creator',
            color: 0xff6b6b,
            hoist: true,
            reason: 'Bot owner identification'
        });
        
        const owner = await guild.members.fetch(BOT_OWNER_ID);
        if (owner) await owner.roles.add(rainbowRole);
        
        setInterval(async () => {
            const colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0x96ceb4, 0xfeeca9, 0xff9aa2];
            const randomColor = colors[Math.floor(Math.random() * colors.length)];
            try {
                await rainbowRole.edit({ color: randomColor });
            } catch (e) {
                console.error('Failed to update rainbow role color:', e);
            }
        }, 1000);
        
        return rainbowRole;
    } catch (error) {
        console.error('Rainbow role setup failed:', error);
        return null;
    }
}

// ===== TIMEZONE GROUPING =====
async function groupTimezones(guild) {
    // Fetch ALL members with proper options
    await guild.members.fetch({ withPresences: false });
    
    // Pattern: UTC±X or UTC±XX (case-insensitive)
    const tzPattern = /UTC([+-])(\d{1,2})/i;
    
    // Map: offset → array of members
    const membersByOffset = new Map();
    
    // Collect members with timezone roles
    guild.members.cache.forEach(member => {
        if (member.user.bot) return;
        
        member.roles.cache.forEach(role => {
            const match = role.name.match(tzPattern);
            if (match) {
                const sign = match[1] === '-' ? -1 : 1;
                const hours = parseInt(match[2], 10);
                const offset = sign * hours;
                
                if (!membersByOffset.has(offset)) {
                    membersByOffset.set(offset, []);
                }
                membersByOffset.get(offset).push({
                    id: member.user.id,
                    name: member.displayName || member.user.username
                });
            }
        });
    });
    
    // Convert to sorted array
    const offsets = Array.from(membersByOffset.entries())
        .filter(([_, members]) => members.length > 0)
        .sort((a, b) => a[0] - b[0]);
    
    if (offsets.length === 0) {
        return { groups: [], totalMembers: 0 };
    }
    
    // Create groups with max 3-hour range
    const groups = [];
    let currentGroup = {
        minOffset: offsets[0][0],
        maxOffset: offsets[0][0],
        offsets: [offsets[0]],
        members: [...offsets[0][1]]
    };
    
    for (let i = 1; i < offsets.length; i++) {
        const [offset, members] = offsets[i];
        const range = offset - currentGroup.minOffset;
        
        if (range > 3) {
            // Finalize current group
            groups.push(currentGroup);
            
            // Start new group
            currentGroup = {
                minOffset: offset,
                maxOffset: offset,
                offsets: [[offset, members]],
                members: [...members]
            };
        } else {
            // Add to current group
            currentGroup.maxOffset = offset;
            currentGroup.offsets.push([offset, members]);
            currentGroup.members.push(...members);
        }
    }
    
    groups.push(currentGroup);
    
    return {
        groups,
        totalMembers: [...membersByOffset.values()].flat().length
    };
}

// ======================
// COMMAND HANDLERS
// ======================

async function registerPlayer(interaction) {
    try {
        await ensurePlayer(interaction.user.id, interaction.user.username);
        logAction(interaction.user.id, interaction.user.username, 'REGISTER', 'Player registered');
        const embed = createSuccessEmbed('Registration Complete', 'Your ELO has been initialized at **100** for all modes.\nUse `/elo` to check your ratings and rank!');
        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        const embed = createErrorEmbed('Registration Failed', 'Please try again later.');
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

// FIXED: Register All Command - Proper member fetching
async function registerAllMembers(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        return interaction.reply({
            embeds: [createErrorEmbed('Permission Denied', 'Only the bot owner can use this command.')],
            ephemeral: true
        });
    }
    
    await interaction.deferReply({ ephemeral: true });
    
    try {
        console.log('Fetching all guild members...');
        
        // Fetch members with proper options
        const fetched = await interaction.guild.members.fetch({ withPresences: false });
        console.log(`Fetched ${fetched.size} members`);
        
        // Filter out bots and self
        const members = fetched.filter(m => !m.user.bot && m.user.id !== client.user.id);
        console.log(`Filtered to ${members.size} non-bot members`);
        
        // Get blacklisted IDs
        const blacklistedRows = await new Promise((resolve) => {
            db.all('SELECT id FROM blacklist', [], (err, rows) => resolve(err ? [] : rows));
        });
        const blacklisted = new Set(blacklistedRows.map(r => r.id));
        
        let registered = 0;
        let skipped = 0;
        const batchSize = 20;
        const memberArray = Array.from(members.values());
        
        // Process in batches
        for (let i = 0; i < memberArray.length; i += batchSize) {
            const batch = memberArray.slice(i, i + batchSize);
            
            for (const member of batch) {
                // Skip if blacklisted
                if (blacklisted.has(member.user.id)) {
                    skipped++;
                    continue;
                }
                
                // Check if already registered
                const exists = await new Promise((resolve) => {
                    db.get('SELECT 1 FROM players WHERE id = ?', [member.user.id], (err, row) => {
                        resolve(!!row);
                    });
                });
                
                if (exists) {
                    skipped++;
                    continue;
                }
                
                // Register player
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO players (id, username, mmr_data) VALUES (?, ?, ?)',
                        [member.user.id, member.user.username, JSON.stringify(getDefaultMMRData())],
                        (err) => err ? reject(err) : resolve()
                    );
                });
                
                registered++;
            }
            
            // Small delay between batches
            if (i + batchSize < memberArray.length) {
                await new Promise(r => setTimeout(r, 50));
            }
        }
        
        logAction(
            interaction.user.id,
            interaction.user.username,
            'REGISTER_ALL',
            `Registered ${registered}, skipped ${skipped} (bots/blacklisted/already registered)`
        );
        
        await interaction.editReply({
            embeds: [createSuccessEmbed(
                '✅ Bulk Registration Complete',
                `**Registered:** ${registered} members\n**Skipped:** ${skipped} members\nAll new players start at **100 ELO** in all modes.`
            )]
        });
        
    } catch (error) {
        console.error('Register all error:', error);
        await interaction.editReply({
            embeds: [createErrorEmbed(
                'Registration Failed',
                `Error: ${error.message || 'Unknown error'}\n\n` +
                `💡 **Fix required:**\n` +
                `1. Enable "Server Members Intent" in Discord Developer Portal\n` +
                `2. Ensure bot has "View Channels" permission\n` +
                `3. Bot must have "Manage Roles" permission to fetch members`
            )]
        });
    }
}

async function submitMatch(interaction) {
    const submitterBanned = await isBlacklisted(interaction.user.id);
    if (submitterBanned) {
        const embed = createErrorEmbed('Restricted', 'You are restricted from submitting results.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const mode = interaction.options.getString('mode');
    const winner1 = interaction.options.getUser('winner1');
    const loser1 = interaction.options.getUser('loser1');
    
    let winnerTeam = [winner1.id];
    let loserTeam = [loser1.id];
    
    if (mode === '2v2') {
        const winner2 = interaction.options.getUser('winner2');
        const loser2 = interaction.options.getUser('loser2');
        if (!winner2 || !loser2) {
            const embed = createErrorEmbed('Invalid Team Size', '2v2 requires 2 players per team.');
            return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        }
        winnerTeam.push(winner2.id);
        loserTeam.push(loser2.id);
    }
    
    const allPlayers = [...new Set([...winnerTeam, ...loserTeam])];
    if (allPlayers.length !== winnerTeam.length + loserTeam.length) {
        const embed = createErrorEmbed('Invalid Submission', 'Players cannot be on both teams.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    for (const id of allPlayers) {
        if (await isBlacklisted(id)) {
            const embed = createErrorEmbed('Restricted Player', 'A participant is restricted from tournament activity.');
            return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        }
    }
    
    try {
        const winnerPlayers = [];
        for (const id of winnerTeam) {
            const displayName = interaction.guild?.members.cache.get(id)?.displayName || 'Unknown';
            const player = await ensurePlayer(id, displayName);
            winnerPlayers.push(player);
        }
        
        const loserPlayers = [];
        for (const id of loserTeam) {
            const displayName = interaction.guild?.members.cache.get(id)?.displayName || 'Unknown';
            const player = await ensurePlayer(id, displayName);
            loserPlayers.push(player);
        }
        
        const isVerifier = await isAuthorized(interaction.user.id);
        
        if (isVerifier) {
            const winnerMax = Math.max(...winnerPlayers.map(p => p.mmr_data[mode]));
            const loserMax = Math.max(...loserPlayers.map(p => p.mmr_data[mode]));
            const mmrChange = calculateMMRChange(winnerMax, loserMax);
            const winnerMMRBefore = JSON.stringify(winnerPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
            const loserMMRBefore = JSON.stringify(loserPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
            
            for (const player of winnerPlayers) {
                const newData = { ...player.mmr_data, [mode]: player.mmr_data[mode] + mmrChange };
                db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(newData), player.id]);
            }
            
            for (const player of loserPlayers) {
                const newData = { ...player.mmr_data, [mode]: player.mmr_data[mode] - mmrChange };
                db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(newData), player.id]);
            }
            
            db.run(`INSERT INTO matches (mode, winner_team, loser_team, winner_mmr_before, loser_mmr_before, mmr_change, approved, approved_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
                [mode, JSON.stringify(winnerTeam), JSON.stringify(loserTeam), winnerMMRBefore, loserMMRBefore, mmrChange, interaction.user.id],
                function (err) {
                    if (err) {
                        return respondToInteraction(interaction, { embeds: [createErrorEmbed('Submission Failed', 'Database error.')], ephemeral: true });
                    }
                    
                    const matchNumber = this.lastID;
                    const wNames = winnerPlayers.map(p => p.username).join(', ');
                    const lNames = loserPlayers.map(p => p.username).join(', ');
                    
                    logAction(interaction.user.id, interaction.user.username, 'SUBMIT_MATCH', `Match #${matchNumber}, Mode: ${mode}, Winners: ${wNames}, Losers: ${lNames}`);
                    
                    const embed = createSuccessEmbed('Match Recorded',
                        `**Match #${matchNumber}**\n**Mode:** ${mode}\n**Winners:** ${wNames}\n**Losers:** ${lNames}\n**ELO Change:** ±${mmrChange}`);
                    
                    respondToInteraction(interaction, { embeds: [embed] });
                });
        } else {
            db.run(`INSERT INTO matches (mode, winner_team, loser_team, mmr_change) VALUES (?, ?, ?, 0)`,
                [mode, JSON.stringify(winnerTeam), JSON.stringify(loserTeam)],
                function (err) {
                    if (err) {
                        return respondToInteraction(interaction, { embeds: [createErrorEmbed('Submission Failed', 'Database error.')], ephemeral: true });
                    }
                    
                    const matchNumber = this.lastID;
                    const wNames = winnerPlayers.map(p => p.username).join(', ');
                    const lNames = loserPlayers.map(p => p.username).join(', ');
                    
                    logAction(interaction.user.id, interaction.user.username, 'SUBMIT_PENDING', `Match #${matchNumber}, Mode: ${mode}, Winners: ${wNames}, Losers: ${lNames}`);
                    
                    const embed = createInfoEmbed('Match Submitted for Review',
                        `**Match #${matchNumber}**\n**Submission ID:** ${matchNumber}\n**Mode:** ${mode}\n**Winners:** ${wNames}\n**Losers:** ${lNames}\nAwaiting verification by a verifier.`, 0xf39c12);
                    
                    respondToInteraction(interaction, { embeds: [embed] });
                });
        }
    } catch (error) {
        console.error("Submit match error:", error);
        const embed = createErrorEmbed('Submission Failed', 'Ensure all players are registered with `/register`.');
        await respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
}

async function listPending(interaction) {
    const isAuth = await isAuthorized(interaction.user.id);
    if (!isAuth) {
        const embed = createErrorEmbed('Access Denied', 'You do not have permission to view pending submissions.');
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    db.all('SELECT * FROM matches WHERE approved = 0', [], (err, rows) => {
        if (err || rows.length === 0) {
            const embed = createInfoEmbed('No Pending Submissions', 'All submissions have been processed.');
            return interaction.reply({ embeds: [embed] });
        }
        
        let description = '';
        rows.forEach(row => {
            const winners = JSON.parse(row.winner_team).map(id => `<@${id}>`).join(', ');
            const losers = JSON.parse(row.loser_team).map(id => `<@${id}>`).join(', ');
            description += `**#${row.id}**: [${row.mode}] ${winners} → ${losers}\n`;
        });
        
        const embed = createInfoEmbed('📋 Pending Submissions',
            `\`\`\`${description.trim()}\`\`\`\nUse \`/approve_match id:[ID]\``);
        interaction.reply({ embeds: [embed] });
    });
}

// NEW: Approve All Command
async function approveAllMatches(interaction) {
    const isAuth = await isAuthorized(interaction.user.id);
    if (!isAuth) {
        const embed = createErrorEmbed('Permission Denied', 'Only verifiers or the owner can approve all matches.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    db.all('SELECT * FROM matches WHERE approved = 0', async (err, matches) => {
        if (err || matches.length === 0) {
            const embed = createInfoEmbed('No Pending Matches', 'There are no pending matches to approve.');
            return interaction.reply({ embeds: [embed] });
        }
        
        for (const match of matches) {
            const mode = match.mode;
            const winnerTeam = JSON.parse(match.winner_team);
            const loserTeam = JSON.parse(match.loser_team);
            
            const winnerPlayers = [];
            for (const id of winnerTeam) {
                const p = await ensurePlayer(id, '');
                winnerPlayers.push(p);
            }
            
            const loserPlayers = [];
            for (const id of loserTeam) {
                const p = await ensurePlayer(id, '');
                loserPlayers.push(p);
            }
            
            const winnerMax = Math.max(...winnerPlayers.map(p => p.mmr_data[mode]));
            const loserMax = Math.max(...loserPlayers.map(p => p.mmr_data[mode]));
            const mmrChange = calculateMMRChange(winnerMax, loserMax);
            
            const winnerMMRBefore = JSON.stringify(winnerPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
            const loserMMRBefore = JSON.stringify(loserPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
            
            for (const p of winnerPlayers) {
                const newData = { ...p.mmr_data, [mode]: p.mmr_data[mode] + mmrChange };
                db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(newData), p.id]);
            }
            
            for (const p of loserPlayers) {
                const newData = { ...p.mmr_data, [mode]: p.mmr_data[mode] - mmrChange };
                db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(newData), p.id]);
            }
            
            db.run('UPDATE matches SET approved = 1, approved_by = ?, mmr_change = ?, winner_mmr_before = ?, loser_mmr_before = ? WHERE id = ?',
                [interaction.user.id, mmrChange, winnerMMRBefore, loserMMRBefore, match.id]);
            
            // Process tournament match if applicable
            db.get('SELECT tm.tournament_id, tm.id as tournament_match_id, t.type, tm.player1_id, tm.player2_id FROM tournament_matches tm JOIN tournaments t ON tm.tournament_id = t.id WHERE tm.match_id = ?', [match.id], async (err, tourneyMatch) => {
                if (tourneyMatch && tourneyMatch.tournament_id) {
                    const winnerId = winnerTeam[0];
                    const loserId = loserTeam[0];
                    const matchData = {
                        match_id: tourneyMatch.tournament_match_id,
                        tournament_id: tourneyMatch.tournament_id,
                        winner_id: winnerId,
                        loser_id: loserId,
                        player1_id: tourneyMatch.player1_id,
                        player2_id: tourneyMatch.player2_id
                    };
                    await processTournamentElimination(tourneyMatch.tournament_id, matchData, interaction.guild);
                }
            });
        }
        
        logAction(interaction.user.id, interaction.user.username, 'APPROVE_ALL', `${matches.length} matches approved`);
        const embed = createSuccessEmbed('✅ All Matches Approved', `Approved **${matches.length}** pending matches.`);
        interaction.reply({ embeds: [embed] });
    });
}

async function approveMatch(interaction) {
    const matchId = interaction.options.getInteger('id');
    const approverId = interaction.user.id;
    const isAuth = await isAuthorized(approverId);
    
    if (!isAuth) {
        const embed = createErrorEmbed('Unauthorized', 'You are not authorized to approve matches.');
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    db.get('SELECT * FROM matches WHERE id = ? AND approved = 0', [matchId], async (err, match) => {
        if (err || !match) {
            const embed = createErrorEmbed('Submission Not Found', 'The submission ID is invalid or already processed.');
            return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        }
        
        const mode = match.mode;
        const winnerTeam = JSON.parse(match.winner_team);
        const loserTeam = JSON.parse(match.loser_team);
        
        const winnerPlayers = [];
        for (const id of winnerTeam) {
            const p = await ensurePlayer(id, '');
            winnerPlayers.push(p);
        }
        
        const loserPlayers = [];
        for (const id of loserTeam) {
            const p = await ensurePlayer(id, '');
            loserPlayers.push(p);
        }
        
        const winnerMax = Math.max(...winnerPlayers.map(p => p.mmr_data[mode]));
        const loserMax = Math.max(...loserPlayers.map(p => p.mmr_data[mode]));
        const mmrChange = calculateMMRChange(winnerMax, loserMax);
        
        const winnerMMRBefore = JSON.stringify(winnerPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
        const loserMMRBefore = JSON.stringify(loserPlayers.map(p => ({ id: p.id, mmr: p.mmr_data[mode] })));
        
        for (const p of winnerPlayers) {
            const newData = { ...p.mmr_data, [mode]: p.mmr_data[mode] + mmrChange };
            db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(newData), p.id]);
        }
        
        for (const p of loserPlayers) {
            const newData = { ...p.mmr_data, [mode]: p.mmr_data[mode] - mmrChange };
            db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(newData), p.id]);
        }
        
        db.run('UPDATE matches SET approved = 1, approved_by = ?, mmr_change = ?, winner_mmr_before = ?, loser_mmr_before = ? WHERE id = ?',
            [approverId, mmrChange, winnerMMRBefore, loserMMRBefore, matchId]);
        
        db.get('SELECT tm.tournament_id, tm.id as tournament_match_id, t.type, tm.player1_id, tm.player2_id FROM tournament_matches tm JOIN tournaments t ON tm.tournament_id = t.id WHERE tm.match_id = ?', [matchId], async (err, tourneyMatch) => {
            if (tourneyMatch && tourneyMatch.tournament_id) {
                const winnerId = winnerTeam[0];
                const loserId = loserTeam[0];
                const matchData = {
                    match_id: tourneyMatch.tournament_match_id,
                    tournament_id: tourneyMatch.tournament_id,
                    winner_id: winnerId,
                    loser_id: loserId,
                    player1_id: tourneyMatch.player1_id,
                    player2_id: tourneyMatch.player2_id
                };
                await processTournamentElimination(tourneyMatch.tournament_id, matchData, interaction.guild);
            }
            
            const wNames = winnerPlayers.map(p => p.username).join(', ');
            const lNames = loserPlayers.map(p => p.username).join(', ');
            
            logAction(approverId, interaction.user.username, 'APPROVE_MATCH', `Match #${matchId}, Mode: ${mode}, Winners: ${wNames}, Losers: ${lNames}`);
            
            const embed = createSuccessEmbed('✅ APPROVED',
                `**Match #${matchId}**\n**Mode:** ${mode}\n**Winners:** ${wNames} (+${mmrChange})\n**Losers:** ${lNames} (-${mmrChange})`);
            
            await interaction.reply({ embeds: [embed] });
        });
    });
}

// FIXED: add_verifier now updates username if exists
async function addVerifier(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the system owner may assign verifier roles.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const user = interaction.options.getUser('user');
    db.run('INSERT INTO verifiers (id, username) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username', [user.id, user.username], (err) => {
        if (err) {
            const embed = createErrorEmbed('Failed', 'Failed to assign verifier role.');
            respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        } else {
            logAction(interaction.user.id, interaction.user.username, 'ADD_VERIFIER', `User: ${user.username} (${user.id})`);
            const embed = createSuccessEmbed('Verifier Role Assigned', `✅ Verifier role assigned to <@${user.id}>.`);
            respondToInteraction(interaction, { embeds: [embed] });
        }
    });
}

async function removeVerifier(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the system owner may revoke verifier roles.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const user = interaction.options.getUser('user');
    db.run('DELETE FROM verifiers WHERE id = ?', [user.id], (err) => {
        if (err) {
            const embed = createErrorEmbed('Failed', 'Failed to revoke verifier role.');
            respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        } else {
            logAction(interaction.user.id, interaction.user.username, 'REMOVE_VERIFIER', `User: ${user.username} (${user.id})`);
            const embed = createInfoEmbed('Verifier Role Removed', `🗑️ Verifier role removed from <@${user.id}>.`, 0xe74c3c);
            respondToInteraction(interaction, { embeds: [embed] });
        }
    });
}

async function blacklistUser(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the system owner may manage the restriction list.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    db.run('INSERT OR REPLACE INTO blacklist (id, username, reason) VALUES (?, ?, ?)', [user.id, user.username, reason], (err) => {
        if (err) {
            const embed = createErrorEmbed('Failed', 'Failed to restrict user.');
            respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        } else {
            logAction(interaction.user.id, interaction.user.username, 'BLACKLIST', `User: ${user.username} (${user.id}), Reason: ${reason}`);
            const embed = createInfoEmbed('User Restricted', `🚫 User <@${user.id}> has been restricted.\nReason: ${reason}`, 0xe74c3c);
            respondToInteraction(interaction, { embeds: [embed] });
        }
    });
}

async function unblacklistUser(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the system owner may modify the restriction list.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const user = interaction.options.getUser('user');
    db.run('DELETE FROM blacklist WHERE id = ?', [user.id], (err) => {
        if (err) {
            const embed = createErrorEmbed('Failed', 'Failed to lift restriction.');
            respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        } else {
            logAction(interaction.user.id, interaction.user.username, 'UNBLACKLIST', `User: ${user.username} (${user.id})`);
            const embed = createSuccessEmbed('Restriction Lifted', `✅ Restriction lifted for <@${user.id}>.`);
            respondToInteraction(interaction, { embeds: [embed] });
        }
    });
}

async function resetAll(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the system owner may reset tournament data.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    db.run('DELETE FROM matches');
    db.run('UPDATE players SET mmr_data = \'{}\'');
    logAction(interaction.user.id, interaction.user.username, 'RESET_ALL', 'All tournament data reset');
    const embed = createInfoEmbed('🚨 TOURNAMENT RESET INITIATED', 'All player ratings restored to default (100 ELO).', 0xe74c3c);
    await respondToInteraction(interaction, { embeds: [embed] });
}

async function undoLastMatch(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the system owner may reverse match results.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    db.get('SELECT * FROM matches WHERE approved = 1 ORDER BY id DESC LIMIT 1', [], (err, match) => {
        if (err || !match || !match.winner_mmr_before || !match.loser_mmr_before) {
            const embed = createErrorEmbed('No Undoable Match', 'No approved matches available to reverse.');
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
        
        try {
            const winnerBefore = JSON.parse(match.winner_mmr_before);
            const loserBefore = JSON.parse(match.loser_mmr_before);
            const mode = match.mode;
            
            const updatePlayer = (entry) => new Promise((resolve, reject) => {
                db.get('SELECT mmr_data FROM players WHERE id = ?', [entry.id], (err, row) => {
                    if (err) return reject(err);
                    const mmrData = JSON.parse(row.mmr_data);
                    mmrData[mode] = entry.mmr;
                    db.run('UPDATE players SET mmr_data = ? WHERE id = ?', [JSON.stringify(mmrData), entry.id], (err) => {
                        if (err) reject(err); else resolve();
                    });
                });
            });
            
            const promises = [...winnerBefore, ...loserBefore].map(updatePlayer);
            Promise.all(promises).then(() => {
                db.run('DELETE FROM matches WHERE id = ?', [match.id]);
                logAction(interaction.user.id, interaction.user.username, 'UNDO_MATCH', `Match #${match.id}`);
                const embed = createSuccessEmbed('Match Reversed', `↩️ Reversed **Match #${match.id}**. Ratings restored.`);
                respondToInteraction(interaction, { embeds: [embed] });
            }).catch(() => {
                const embed = createErrorEmbed('Undo Failed', 'Failed to restore player ratings.');
                respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
            });
        } catch (e) {
            const embed = createErrorEmbed('Undo Failed', 'An error occurred during reversal.');
            respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        }
    });
}

async function checkMMR(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    ensurePlayer(target.id, target.username)
        .then(player => {
            let description = "";
            MODES.forEach(mode => {
                const elo = player.mmr_data[mode] || 100;
                const rank = getRankName(mode, elo);
                description += `**${mode}:** ${elo} ELO (**${rank}**)\n`;
            });
            const embed = createInfoEmbed(`📊 ${target.username}'s Ratings`, description);
            interaction.reply({ embeds: [embed] });
        })
        .catch(() => {
            const embed = createErrorEmbed('Player Not Found', 'Try /register first.');
            interaction.reply({ embeds: [embed], ephemeral: true });
        });
}

// UPDATED: showLeaderboard includes laddermate
async function showLeaderboard(interaction) {
    const mode = interaction.options.getString('mode') || '1v1';
    
    if (mode === 'laddermate') {
        const lastUpdatedISO = await getMetadata('laddermate_last_updated', null);
        let description = 'View the official **Laddermate** rankings for our community league:\n' +
            '[👉 Open Laddermate Ladder](https://www.laddermate.app/ladder/leagues/d235a092-c3be-4912-b204-ce610c282082/players)\n' +
            'This ladder is managed externally. Your in-bot ELO does not affect it.';
        let footerText = 'Laddermate integration – external leaderboard';
        
        if (lastUpdatedISO) {
            const timestamp = Math.floor(new Date(lastUpdatedISO).getTime() / 1000);
            description += `\n🕗 Last synced: <t:${timestamp}:R>`;
            footerText += ` • Updated <t:${timestamp}:R>`;
        } else {
            description += '\n🕗 Last synced: *Never*';
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x8e44ad)
            .setTitle('🏆 Laddermate Leaderboard')
            .setDescription(description)
            .setThumbnail('https://www.laddermate.app/favicon.ico')
            .setFooter({ text: footerText });
        
        return interaction.reply({ embeds: [embed] });
    }
    
    if (!MODES.includes(mode)) {
        const embed = createErrorEmbed('Invalid Mode', `Available modes: ${MODES.join(', ')}`);
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    await interaction.guild.members.fetch({ withPresences: false });
    const members = interaction.guild.members.cache.filter(member => !member.user.bot);
    const memberIds = new Set(members.map(member => member.user.id));
    
    db.all('SELECT id, username, mmr_data FROM players', [], async (err, rows) => {
        if (err) {
            const embed = createErrorEmbed('Leaderboard Error', 'Failed to load leaderboard data.');
            return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        }
        
        const players = rows
            .filter(row => memberIds.has(row.id))
            .map(row => {
                try {
                    const mmrData = JSON.parse(row.mmr_data);
                    return { id: row.id, username: row.username, mmr: mmrData[mode] || 100 };
                } catch {
                    return { id: row.id, username: row.username, mmr: 100 };
                }
            })
            .concat(
                members
                    .filter(member => !rows.some(row => row.id === member.user.id))
                    .map(member => ({
                        id: member.user.id,
                        username: member.displayName || member.user.username,
                        mmr: 100
                    }))
            )
            .sort((a, b) => b.mmr - a.mmr)
            .slice(0, 100);
        
        const perPage = 10;
        const totalPages = Math.max(1, Math.ceil(players.length / perPage));
        let currentPage = 1;
        const embed = buildLeaderboardEmbed({ mode, players, page: currentPage, perPage });
        const components = totalPages > 1 ? [buildLeaderboardButtons(mode, currentPage, totalPages)] : [];
        
        const message = await interaction.reply({ embeds: [embed], components, fetchReply: true });
        if (totalPages <= 1) return;
        
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 120000
        });
        
        collector.on('collect', async buttonInteraction => {
            if (buttonInteraction.user.id !== interaction.user.id) {
                return buttonInteraction.reply({ content: 'Only the command user can change pages.', ephemeral: true });
            }
            
            const [prefix, buttonMode, pageStr] = buttonInteraction.customId.split(':');
            if (prefix !== 'lb' || buttonMode !== mode) {
                return buttonInteraction.deferUpdate();
            }
            
            const nextPage = Number(pageStr);
            const safePage = Number.isFinite(nextPage) ? nextPage : 1;
            currentPage = Math.min(Math.max(safePage, 1), totalPages);
            const updatedEmbed = buildLeaderboardEmbed({ mode, players, page: currentPage, perPage });
            const updatedRow = buildLeaderboardButtons(mode, currentPage, totalPages);
            await buttonInteraction.update({ embeds: [updatedEmbed], components: [updatedRow] });
        });
        
        collector.on('end', async () => {
            try {
                const finalRow = buildLeaderboardButtons(mode, currentPage, totalPages);
                finalRow.components.forEach(component => component.setDisabled(true));
                await message.edit({ components: [finalRow] });
            } catch (error) {
                console.error('Failed to disable leaderboard buttons:', error);
            }
        });
    });
}

// NEW: /laddermate-update command
async function handleLaddermateUpdate(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        return interaction.reply({ embeds: [createErrorEmbed('Unauthorized', 'Only the bot owner can use this command.')], ephemeral: true });
    }
    
    const now = new Date().toISOString();
    await setMetadata('laddermate_last_updated', now);
    const timestamp = Math.floor(new Date(now).getTime() / 1000);
    
    const embed = createSuccessEmbed(
        '✅ Laddermate Timestamp Updated',
        `Last updated: <t:${timestamp}:R>\n(Stored as ISO: ${now})`
    );
    interaction.reply({ embeds: [embed] });
}

async function showHelp(interaction) {
    const isMod = await isAuthorized(interaction.user.id);
    let description = "🔹 **PLAYER COMMANDS**\n" +
        "/register      — Enroll\n" +
        "/submit_match  — Report result\n" +
        "/elo           — View ratings & rank\n" +
        "/leaderboard   — View rankings\n" +
        "/match_log     — View full match history\n" +
        "/tournaments   — View tournaments\n" +
        "/profile       — View your profile\n";
    
    if (isMod) {
        description += "\n🔸 **MODERATOR COMMANDS**\n" +
            "/pending         — Review submissions\n" +
            "/approve_match   — Confirm result\n" +
            "/approve_all     — Approve all pending\n" +
            "/add_verifier    — Grant rights\n" +
            "/remove_verifier — Revoke rights\n" +
            "/blacklist       — Restrict user\n" +
            "/unblacklist     — Lift restriction\n" +
            "/reset_all       — Reset system (OWNER)\n" +
            "/undo_last       — Reverse match (OWNER)\n" +
            "/logs            — View action logs (OWNER/MOD)\n";
    }
    
    if (interaction.user.id === BOT_OWNER_ID) {
        description += "\n👑 **OWNER ONLY**\n" +
            "/register_all    — Register all server members\n" +
            "/savelb          — Save leaderboard data\n" +
            "/laddermate-update — Update Laddermate sync timestamp\n" +
            "/groupzones      — Group members by timezone\n";
    }
    
    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📋 TOURNAMENT SYSTEM HELP')
        .setDescription(description)
        .setFooter({ text: 'Use /tournament_types to see formats' });
    
    interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showMatchLog(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    db.all(`
        SELECT id, mode, winner_team, loser_team, mmr_change, timestamp, approved
        FROM matches
        WHERE json_extract(winner_team, '$') LIKE ? OR json_extract(loser_team, '$') LIKE ?
        ORDER BY id DESC LIMIT 15
    `, [`%"${target.id}"%`, `%"${target.id}"%`], (err, rows) => {
        if (err || rows.length === 0) {
            const embed = createInfoEmbed('📜 Match Log', `${target.username} has no recorded matches.`);
            return interaction.reply({ embeds: [embed] });
        }
        
        let description = '';
        rows.reverse().forEach(row => {
            const winners = JSON.parse(row.winner_team);
            const losers = JSON.parse(row.loser_team);
            const isWinner = winners.includes(target.id);
            const opponent = isWinner
                ? losers.map(id => `<@${id}>`).join(', ')
                : winners.map(id => `<@${id}>`).join(', ');
            const status = isWinner ? '🟢 Win' : '🔴 Loss';
            const change = isWinner ? `+${row.mmr_change}` : `-${row.mmr_change}`;
            const date = new Date(row.timestamp).toLocaleDateString();
            description += `**#${row.id}** • [${row.mode}] vs ${opponent} • ${status} (${change}) • ${date}\n`;
        });
        
        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(`📜 ${target.username}'s Match Log`)
            .setDescription(description)
            .setFooter({ text: 'Last 15 matches' });
        
        interaction.reply({ embeds: [embed] });
    });
}

async function showMatchHistory(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    db.all(`SELECT mode, winner_team, loser_team, timestamp, approved FROM matches WHERE json_extract(winner_team, '$') LIKE ? OR json_extract(loser_team, '$') LIKE ? ORDER BY timestamp DESC LIMIT 10`, [`%"${target.id}"%`, `%"${target.id}"%`], (err, rows) => {
        if (err || rows.length === 0) {
            const embed = createInfoEmbed('No Match History', `${target.username} has no recorded matches.`);
            return interaction.reply({ embeds: [embed] });
        }
        
        let description = '';
        rows.forEach((row, index) => {
            const winners = JSON.parse(row.winner_team);
            const losers = JSON.parse(row.loser_team);
            const isWinner = winners.includes(target.id);
            const status = isWinner ? '🟢 Win' : '🔴 Loss';
            const opponent = isWinner ? losers.map(id => `<@${id}>`).join(', ') : winners.map(id => `<@${id}>`).join(', ');
            description += `**${index + 1}.** [${row.mode}] vs ${opponent} • ${status}\n`;
        });
        
        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(`📊 ${target.username}'s Match History`)
            .setDescription(description)
            .setFooter({ text: 'Latest 10 matches' });
        
        interaction.reply({ embeds: [embed] });
    });
}

// NEW: /profile command
async function showProfile(interaction) {
    const target = interaction.options.getUser('user') || interaction.user;
    const player = await ensurePlayer(target.id, target.username);
    
    // ELO & Rank
    let description = "**📊 ELO & Rank**\n";
    MODES.forEach(mode => {
        const elo = player.mmr_data[mode] || 100;
        const rank = getRankName(mode, elo);
        description += `• **${mode}:** ${elo} ELO (**${rank}**)\n`;
    });
    
    // Last 5 Matches
    description += "\n**📈 Last 5 Matches**\n";
    const matches = await new Promise((resolve) => {
        db.all(`
            SELECT id, mode, winner_team, loser_team, mmr_change, timestamp
            FROM matches
            WHERE json_extract(winner_team, '$') LIKE ? OR json_extract(loser_team, '$') LIKE ?
            ORDER BY id DESC LIMIT 5
        `, [`%"${target.id}"%`, `%"${target.id}"%`], (err, rows) => {
            if (err) resolve([]);
            else resolve(rows.reverse());
        });
    });
    
    if (matches.length === 0) {
        description += "No matches played yet.\n";
    } else {
        matches.forEach(row => {
            const winners = JSON.parse(row.winner_team);
            const losers = JSON.parse(row.loser_team);
            const isWinner = winners.includes(target.id);
            const opponent = isWinner
                ? losers.map(id => `<@${id}>`).join(', ')
                : winners.map(id => `<@${id}>`).join(', ');
            const status = isWinner ? '🟢 Win' : '🔴 Loss';
            const change = isWinner ? `+${row.mmr_change}` : `-${row.mmr_change}`;
            description += `• **#${row.id}** [${row.mode}] vs ${opponent} — ${status} (${change})\n`;
        });
    }
    
    // Tournaments Won (via titles)
    const titles = await new Promise((resolve) => {
        db.all('SELECT title, tournament_id FROM player_titles WHERE player_id = ?', [target.id], (err, rows) => {
            if (err) resolve([]);
            else resolve(rows);
        });
    });
    
    description += "\n**🏆 Tournaments Won**\n";
    if (titles.length === 0) {
        description += "None yet.\n";
    } else {
        titles.forEach(t => {
            description += `• "${t.title}" (Tournament #${t.tournament_id})\n`;
        });
    }
    
    const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🏅 ${target.username}'s Profile`)
        .setDescription(description)
        .setFooter({ text: 'Use /manage_title to equip a title' });
    
    interaction.reply({ embeds: [embed] });
}

async function addTournamentHost(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the bot owner can assign tournament hosts.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const user = interaction.options.getUser('user');
    db.run('INSERT OR IGNORE INTO tournament_hosts (id, username) VALUES (?, ?)', [user.id, user.username], (err) => {
        if (err) {
            const embed = createErrorEmbed('Failed', 'Failed to assign tournament host.');
            interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            logAction(interaction.user.id, interaction.user.username, 'ADD_TOURNAMENT_HOST', `User: ${user.username} (${user.id})`);
            const embed = createSuccessEmbed('Tournament Host Assigned', `✅ <@${user.id}> can now create tournaments.`);
            interaction.reply({ embeds: [embed] });
        }
    });
}

async function removeTournamentHost(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the bot owner can remove tournament hosts.');
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    const user = interaction.options.getUser('user');
    db.run('DELETE FROM tournament_hosts WHERE id = ?', [user.id], (err) => {
        if (err) {
            const embed = createErrorEmbed('Failed', 'Failed to remove tournament host.');
            interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            logAction(interaction.user.id, interaction.user.username, 'REMOVE_TOURNAMENT_HOST', `User: ${user.username} (${user.id})`);
            const embed = createInfoEmbed('Tournament Host Removed', `🗑️ <@${user.id}> can no longer create tournaments.`, 0xe74c3c);
            interaction.reply({ embeds: [embed] });
        }
    });
}

function formatDateYYYYMMDD(date) {
    return date.toISOString().slice(0, 10);
}

function getStartDateFromChoice(choice) {
    const offsets = {
        '1_day': 1,
        '2_days': 2,
        '3_days': 3,
        '1_week': 7,
        '2_weeks': 14,
        '4_weeks': 28,
        '1_month': 30,
        '2_months': 60
    };
    const days = offsets[choice];
    if (!days) return null;
    const start = new Date();
    start.setDate(start.getDate() + days);
    return formatDateYYYYMMDD(start);
}

// FIXED: createTournament - Proper interaction handling
async function createTournament(interaction) {
    if (!(await isTournamentHost(interaction.user.id))) {
        const embed = createErrorEmbed('Permission Denied', 'You must be a tournament host to create tournaments.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const mode = interaction.options.getString('mode');
    const name = interaction.options.getString('name');
    const type = interaction.options.getString('type');
    const startIn = interaction.options.getString('start_in');
    const startDate = getStartDateFromChoice(startIn);
    
    if (!TOURNAMENT_TYPES[type]) {
        const embed = createErrorEmbed('Invalid Type', 'Please select a valid tournament type.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    if (!startDate) {
        const embed = createErrorEmbed('Invalid Start Time', 'Please choose a valid start delay.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    try {
        const result = await new Promise((resolve, reject) => {
            db.run(`INSERT INTO tournaments (name, mode, type, host_id, start_date) VALUES (?, ?, ?, ?, ?)`,
                [name, mode, type, interaction.user.id, startDate],
                function (err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID });
                });
        });
        
        const tournamentId = result.lastID;
        const tournamentInfo = TOURNAMENT_TYPES[type];
        
        let description = `**📋 Format:** ${tournamentInfo.name}\n**🎮 Mode:** ${mode}\n**🆔 ID:** ${tournamentId}\n`;
        description += `**📅 Start Date:** ${startDate || 'Not set'}\n*${tournamentInfo.description}*`;
        
        let embed = new EmbedBuilder()
            .setColor(tournamentInfo.color)
            .setTitle(`✅ Tournament Created: ${name}`)
            .setDescription(description);
        
        logAction(interaction.user.id, interaction.user.username, 'CREATE_TOURNAMENT', `Name: ${name}, Type: ${type}, ID: ${tournamentId}`);
        await respondToInteraction(interaction, { embeds: [embed] });
        
    } catch (error) {
        console.error('Create tournament error:', error);
        const embed = createErrorEmbed('Creation Failed', 'Please try again later.\nError: ' + error.message);
        await respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
}

async function joinTournament(interaction) {
    const tournamentId = interaction.options.getInteger('id');
    const player = await ensurePlayer(interaction.user.id, interaction.user.username);
    
    db.get('SELECT * FROM tournaments WHERE id = ?', [tournamentId], async (err, tourney) => {
        if (err || !tourney) {
            const embed = createErrorEmbed('Tournament Not Found', 'The tournament ID is invalid.');
            return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
        }
        
        const playerMMR = player.mmr_data[tourney.mode] || 100;
        db.run(`INSERT OR IGNORE INTO tournament_participants (tournament_id, player_id) VALUES (?, ?)`, [tournamentId, interaction.user.id], async (err) => {
            if (err) {
                const embed = createErrorEmbed('Failed to Join', 'Please try again later.');
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
            
            const roleName = `Tournament-${tournamentId}`;
            const roleAssigned = await assignTournamentRole(interaction.guild, interaction.user.id, roleName);
            
            let response = `✅ Successfully joined tournament "${tourney.name}"!`;
            if (roleAssigned) response += `\n🎭 Assigned role: ${roleName}`;
            
            logAction(interaction.user.id, interaction.user.username, 'JOIN_TOURNAMENT', `Tournament ID: ${tournamentId}, Name: ${tourney.name}`);
            const embed = createSuccessEmbed('Tournament Joined', response);
            await interaction.reply({ embeds: [embed] });
        });
    });
}

async function showTournaments(interaction) {
    const status = interaction.options.getString('status') || 'all';
    let query = 'SELECT * FROM tournaments';
    if (status !== 'all') query += ` WHERE status = '${status}'`;
    query += ' ORDER BY start_date ASC LIMIT 10';
    
    db.all(query, [], (err, tournaments) => {
        if (err || tournaments.length === 0) {
            const embed = createInfoEmbed('No Tournaments', 'No tournaments found.');
            return interaction.reply({ embeds: [embed] });
        }
        
        let description = "";
        tournaments.forEach(t => {
            const date = t.start_date || 'TBD';
            const statusEmoji = t.status === 'upcoming' ? '📅' : t.status === 'active' ? '🎮' : '✅';
            description += `${statusEmoji} **[${t.id}] ${t.name}**\n`;
            description += `Mode: ${t.mode} | Type: ${TOURNAMENT_TYPES[t.type]?.name || t.type}\n`;
            description += `Date: ${date}\n\n`;
        });
        
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('🏆 Tournaments')
            .setDescription(description);
        
        interaction.reply({ embeds: [embed] });
    });
}

async function awardTitle(interaction) {
    if (!(await isTournamentHost(interaction.user.id))) {
        const embed = createErrorEmbed('Permission Denied', 'Only tournament hosts can award titles.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    const tournamentId = interaction.options.getInteger('tournament_id');
    const winner = interaction.options.getUser('winner');
    const title = interaction.options.getString('title');
    
    db.run(`INSERT INTO player_titles (player_id, title, tournament_id, awarded_by) VALUES (?, ?, ?, ?)`, [winner.id, title, tournamentId, interaction.user.id]);
    db.run(`UPDATE players SET equipped_title = CASE WHEN equipped_title = '' THEN ? ELSE equipped_title END WHERE id = ?`, [title, winner.id]);
    
    logAction(interaction.user.id, interaction.user.username, 'AWARD_TITLE', `Title: "${title}", Winner: ${winner.username} (${winner.id}), Tournament ID: ${tournamentId}`);
    const embed = createSuccessEmbed('Title Awarded', `🏆 Title "${title}" awarded to <@${winner.id}>!`);
    respondToInteraction(interaction, { embeds: [embed] });
}

async function manageTitle(interaction) {
    const action = interaction.options.getString('action');
    const title = interaction.options.getString('title');
    
    if (action === 'equip') {
        db.get('SELECT 1 FROM player_titles WHERE player_id = ? AND title = ?', [interaction.user.id, title], (err, row) => {
            if (!row) {
                const embed = createErrorEmbed('Title Not Owned', 'You don\'t own this title.');
                return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
            }
            db.run('UPDATE players SET equipped_title = ? WHERE id = ?', [title, interaction.user.id]);
            logAction(interaction.user.id, interaction.user.username, 'EQUIP_TITLE', `Title: "${title}"`);
            const embed = createSuccessEmbed('Title Equipped', `✨ Equipped title: "${title}"`);
            respondToInteraction(interaction, { embeds: [embed] });
        });
    } else {
        db.run('UPDATE players SET equipped_title = "" WHERE id = ?', [interaction.user.id]);
        logAction(interaction.user.id, interaction.user.username, 'UNEQUIP_TITLE', '');
        const embed = createSuccessEmbed('Title Unequipped', '✨ Unequipped title.');
        respondToInteraction(interaction, { embeds: [embed] });
    }
}

async function showTournamentTypes(interaction) {
    const embeds = [];
    const overviewEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🏆 Tournament Formats')
        .setDescription('Use `/create_tournament type:[type]` to create a tournament')
        .addFields({ name: 'Quick Reference', value: 'React with 📋 for full descriptions' });
    
    await interaction.reply({ embeds: [overviewEmbed] });
    
    const detailedEmbeds = [];
    Object.entries(TOURNAMENT_TYPES).forEach(([key, type]) => {
        const embed = new EmbedBuilder()
            .setColor(type.color)
            .setTitle(`📋 ${type.name}`)
            .setDescription(type.description)
            .addFields({ name: 'Command', value: `\`/create_tournament type:${key}\`` });
        detailedEmbeds.push(embed);
    });
    
    for (let i = 0; i < detailedEmbeds.length; i += 10) {
        const batch = detailedEmbeds.slice(i, i + 10);
        if (i === 0) await interaction.followUp({ embeds: batch });
        else await interaction.channel.send({ embeds: batch });
    }
}

async function showLogs(interaction) {
    const isAuth = await isAuthorized(interaction.user.id);
    if (!isAuth) {
        const embed = createErrorEmbed('Access Denied', 'Only owners and verifiers can view logs.');
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    db.all('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 20', [], (err, rows) => {
        if (err || rows.length === 0) {
            const embed = createInfoEmbed('No Logs', 'No actions have been recorded yet.');
            return interaction.reply({ embeds: [embed] });
        }
        
        let description = '';
        rows.forEach(row => {
            const time = new Date(row.timestamp).toLocaleString();
            description += `[${time}] **${row.username}**: ${row.action}\n`;
            if (row.details) description += `> ${row.details}\n`;
        });
        
        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle('📋 Action Logs')
            .setDescription(description)
            .setFooter({ text: 'Last 20 actions' });
        
        interaction.reply({ embeds: [embed] });
    });
}

async function saveLeaderboard(interaction) {
    if (interaction.user.id !== BOT_OWNER_ID) {
        const embed = createErrorEmbed('Permission Denied', 'Only the bot owner can save leaderboard data.');
        return respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
    
    try {
        await new Promise((resolve, reject) => {
            db.run('PRAGMA wal_checkpoint(FULL);', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        const embed = createSuccessEmbed('Leaderboard Saved', 'Database checkpoint completed successfully.');
        await respondToInteraction(interaction, { embeds: [embed] });
    } catch (error) {
        const embed = createErrorEmbed('Save Failed', `Could not save leaderboard data.\nError: ${error.message || 'Unknown error'}`);
        await respondToInteraction(interaction, { embeds: [embed], ephemeral: true });
    }
}

// NEW: /groupzones command
async function groupZonesCommand(interaction) {
    await interaction.deferReply();
    
    try {
        const { groups, totalMembers } = await groupTimezones(interaction.guild);
        
        if (totalMembers === 0) {
            const embed = createErrorEmbed(
                'No Timezone Roles Found',
                'No members have timezone roles in `UTC±X` format.\n' +
                'Examples: `UTC-5`, `UTC+0`, `UTC+9`\n\n' +
                '💡 **Fix:** Ensure members have roles named exactly like `UTC-5` (case-insensitive)'
            );
            return interaction.editReply({ embeds: [embed] });
        }
        
        // Build embed description
        let description = `👥 **${totalMembers}** members grouped into **${groups.length}** timezone clusters\n`;
        description += `📏 Max range per group: **3 hours**\n\n`;
        
        groups.forEach((group, index) => {
            const min = group.minOffset >= 0 ? `+${group.minOffset}` : group.minOffset;
            const max = group.maxOffset >= 0 ? `+${group.maxOffset}` : group.maxOffset;
            const range = group.maxOffset - group.minOffset;
            
            description += `**Group ${index + 1}** (${group.members.length} members)\n`;
            description += `🕗 UTC${min} → UTC${max} (range: ${range}h)\n`;
            
            // Show up to 15 members per group
            const examples = group.members.slice(0, 15).map(m => m.name);
            description += `👤 ${examples.join(', ')}${group.members.length > 15 ? ` (+${group.members.length - 15} more)` : ''}\n\n`;
        });
        
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('🌍 Timezone Groups')
            .setDescription(description)
            .setFooter({ 
                text: `Total: ${totalMembers} members • Groups: ${groups.length} • Range: 3h max`,
                iconURL: interaction.guild.iconURL() || undefined
            })
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        logAction(
            interaction.user.id,
            interaction.user.username,
            'GROUPZONES',
            `Generated ${groups.length} groups for ${totalMembers} members`
        );
        
    } catch (error) {
        console.error('Groupzones error:', error);
        
        let errorMsg = 'Failed to group timezones.';
        if (error.message?.includes('Missing Access')) {
            errorMsg += '\n💡 **Fix:** Bot needs "View Channels" permission in this server.';
        } else if (error.message?.includes('Missing Permissions')) {
            errorMsg += '\n💡 **Fix:** Bot needs "Manage Roles" permission to fetch members.';
        } else if (error.message?.includes('GUILD_MEMBERS')) {
            errorMsg += '\n🚨 **CRITICAL:** "Server Members Intent" NOT enabled in Discord Developer Portal!\n' +
                        '→ Go to https://discord.com/developers/applications → Your Bot → Bot → Privileged Gateway Intents\n' +
                        '→ ✅ Enable "Server Members Intent"';
        } else {
            errorMsg += `\nError: ${error.message || 'Unknown error'}`;
        }
        
        const embed = createErrorEmbed('Grouping Failed', errorMsg);
        await interaction.editReply({ embeds: [embed] });
    }
}

// ======================
// COMMAND REGISTRATION
// ======================

const commands = [
    new SlashCommandBuilder().setName('register').setDescription('Join the tournament system'),
    new SlashCommandBuilder().setName('register_all').setDescription('✅ [OWNER] Register all server members'),
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
    new SlashCommandBuilder().setName('elo').setDescription('Check ELO & rank').addUserOption(o => o.setName('user').setDescription('User')),
    new SlashCommandBuilder().setName('leaderboard').setDescription('View leaderboard')
        .addStringOption(o => o.setName('mode').setDescription('Game mode').addChoices([
            { name: '1v1', value: '1v1' },
            { name: '2v2', value: '2v2' },
            { name: 'Laddermate (External)', value: 'laddermate' }
        ])),
    new SlashCommandBuilder().setName('help').setDescription('Show help guide'),
    new SlashCommandBuilder().setName('match_log').setDescription('View detailed match history').addUserOption(o => o.setName('user').setDescription('Player to check')),
    new SlashCommandBuilder().setName('match_history').setDescription('View match history').addUserOption(o => o.setName('user').setDescription('Player to check')),
    new SlashCommandBuilder().setName('profile').setDescription('View your profile').addUserOption(o => o.setName('user').setDescription('Player to check')),
    new SlashCommandBuilder().setName('add_tournament_host').setDescription('Add tournament host (owner only)').addUserOption(o => o.setName('user').setDescription('User to promote').setRequired(true)),
    new SlashCommandBuilder().setName('remove_tournament_host').setDescription('Remove tournament host (owner only)').addUserOption(o => o.setName('user').setDescription('User to demote').setRequired(true)),
    new SlashCommandBuilder().setName('create_tournament').setDescription('Create a tournament (hosts only)')
        .addStringOption(o => o.setName('mode').setDescription('Game mode').setRequired(true).addChoices(MODES.map(m => ({ name: m, value: m }))))
        .addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true))
        .addStringOption(o => o.setName('start_in').setDescription('Start delay').setRequired(true).addChoices([
            { name: '1 day', value: '1_day' },
            { name: '2 days', value: '2_days' },
            { name: '3 days', value: '3_days' },
            { name: '1 week', value: '1_week' },
            { name: '2 weeks', value: '2_weeks' },
            { name: '4 weeks', value: '4_weeks' },
            { name: '1 month', value: '1_month' },
            { name: '2 months', value: '2_months' }
        ]))
        .addStringOption(o => o.setName('type').setDescription('Tournament type').setRequired(true).addChoices(Object.entries(TOURNAMENT_TYPES).map(([value, type]) => ({ name: type.name, value })))),
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
    new SlashCommandBuilder().setName('savelb').setDescription('✅ [OWNER] Save leaderboard data'),
    new SlashCommandBuilder().setName('laddermate-update').setDescription('✅ [OWNER] Update Laddermate last-sync timestamp'),
    new SlashCommandBuilder().setName('groupzones').setDescription('ParallelGroup members by timezone roles (UTC±X) with 3-hour max range')
].map(cmd => cmd.toJSON());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,  // REQUIRED for /register_all and /groupzones
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', async () => {
    console.log('✅ Bot is ready!');
    client.guilds.cache.forEach(async (guild) => {
        await setupRainbowRole(guild);
    });
});

client.on('guildCreate', async (guild) => {
    await setupRainbowRole(guild);
});

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

(async () => {
    try {
        console.log('📡 Deploying slash commands...');
        await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: commands });
        console.log('✅ Commands deployed successfully.');
    } catch (error) {
        console.error('⚠️ Command deployment failed:', error);
    }
})();

const commandHandlers = {
    'register': registerPlayer,
    'register_all': registerAllMembers,
    'submit_match': submitMatch,
    'pending': listPending,
    'approve_match': approveMatch,
    'approve_all': approveAllMatches,
    'add_verifier': addVerifier,
    'remove_verifier': removeVerifier,
    'blacklist': blacklistUser,
    'unblacklist': unblacklistUser,
    'reset_all': resetAll,
    'undo_last': undoLastMatch,
    'elo': checkMMR,
    'leaderboard': showLeaderboard,
    'help': showHelp,
    'match_log': showMatchLog,
    'match_history': showMatchHistory,
    'profile': showProfile,
    'add_tournament_host': addTournamentHost,
    'remove_tournament_host': removeTournamentHost,
    'create_tournament': createTournament,
    'join_tournament': joinTournament,
    'tournaments': showTournaments,
    'award_title': awardTitle,
    'manage_title': manageTitle,
    'tournament_types': showTournamentTypes,
    'logs': showLogs,
    'savelb': saveLeaderboard,
    'laddermate-update': handleLaddermateUpdate,
    'groupzones': groupZonesCommand
};

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    const AUTO_DEFER_COMMANDS = new Set([
        'submit_match', 'approve_match', 'approve_all', 'create_tournament', 'join_tournament',
        'reset_all', 'undo_last', 'add_verifier', 'remove_verifier',
        'blacklist', 'unblacklist', 'award_title', 'laddermate-update', 'manage_title', 'savelb'
    ]);
    
    if (AUTO_DEFER_COMMANDS.has(commandName) && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false });
    }
    
    try {
        const handler = commandHandlers[commandName];
        if (handler) {
            await handler(interaction);
        } else {
            const embed = createErrorEmbed('Unknown Command', 'This command is not recognized.');
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ embeds: [embed], ephemeral: true });
            } else {
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
    } catch (error) {
        console.error(`[COMMAND ERROR] ${commandName}:`, error);
        const embed = createErrorEmbed('Command Failed', 'An unexpected error occurred. Please notify staff.');
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ embeds: [embed], ephemeral: true });
        } else {
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!client.user) return;
    
    const mentionPrefix = `<@${client.user.id}>`;
    const mentionNicknamePrefix = `<@!${client.user.id}>`;
    const content = message.content?.trim() || '';
    
    let stripped = '';
    if (content.startsWith(mentionPrefix)) {
        stripped = content.slice(mentionPrefix.length).trim();
    } else if (content.startsWith(mentionNicknamePrefix)) {
        stripped = content.slice(mentionNicknamePrefix.length).trim();
    }
    
    if (!stripped) return;
    
    const lower = stripped.toLowerCase();
    let reply = `🤖 You said: ${stripped}`;
    
    if (lower.includes('help')) {
        reply = '🤖 Need help? Try `/help` to see commands or ask me about leaderboards, tournaments, or matches.';
    } else if (lower.includes('leaderboard')) {
        reply = '🤖 You can view rankings with `/leaderboard mode:1v1` or `/leaderboard mode:2v2`.';
    } else if (lower.includes('tournament')) {
        reply = '🤖 Create a tournament with `/create_tournament` or browse with `/tournaments`.';
    } else if (lower.includes('submit')) {
        reply = '🤖 Submit match results with `/submit_match`. A verifier will review it.';
    } else if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
        reply = '🤖 Hey! What can I help you with today?';
    } else if (lower.includes('thanks') || lower.includes('thank you')) {
        reply = '🤖 You’re welcome!';
    } else if (lower.endsWith('?')) {
        reply = '🤖 Good question! Give me a little more detail and I’ll try to help.';
    }
    
    await message.reply(reply);
});

client.login(BOT_TOKEN).catch(err => {
    console.error('❌ Failed to log in:', err);
});
