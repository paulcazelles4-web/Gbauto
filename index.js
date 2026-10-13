require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Events
} = require('discord.js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ==================== CONFIG & DB ====================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    guild_id TEXT NOT NULL,
    inviter_id TEXT NOT NULL,
    invited_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, invited_id)
  );
  CREATE TABLE IF NOT EXISTS invite_cache (
    guild_id TEXT NOT NULL,
    code TEXT NOT NULL,
    uses INTEGER NOT NULL,
    inviter_id TEXT,
    PRIMARY KEY (guild_id, code)
  );
`);

function getConfig(key, fallback = null) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setConfig(key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Default role IDs
const DEFAULT_ROLES = {
  bronze: process.env.ROLE_BRONZE || '1487902274435944531',
  silver: process.env.ROLE_SILVER || '1487902274435944532',
  gold: process.env.ROLE_GOLD || '1487902274435944533',
  diamond: process.env.ROLE_DIAMOND || '1487902274435944534',
  premium: process.env.ROLE_PREMIUM || '1487902274435944535'
};

for (const [k, v] of Object.entries(DEFAULT_ROLES)) {
  if (!getConfig(`role_${k}`)) setConfig(`role_${k}`, v);
}

function getRoleId(name) {
  return getConfig(`role_${name}`, DEFAULT_ROLES[name]);
}

// Invite thresholds
const DEFAULT_INVITE_THRESHOLDS = { bronze: 5, silver: 10, gold: 20, diamond: 33, premium: 40 };
for (const [name, count] of Object.entries(DEFAULT_INVITE_THRESHOLDS)) if (!getConfig(`invite_threshold_${name}`)) setConfig(`invite_threshold_${name}`, count);
if (!getConfig('boost_threshold')) setConfig('boost_threshold', 2);
function getInviteThresholds() {
  return Object.keys(DEFAULT_INVITE_THRESHOLDS).map(role => ({ role, count: Number(getConfig(`invite_threshold_${role}`, DEFAULT_INVITE_THRESHOLDS[role])) })).filter(x => x.count > 0).sort((a,b) => b.count-a.count);
}

// ==================== CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.GuildMember]
});

// In-memory invite cache (used to detect inviters)
const inviteCache = new Map(); // guildId -> Map<code, {uses, inviterId}>

// ==================== HELPERS ====================
async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map();
    for (const [code, inv] of invites) {
      map.set(code, { uses: inv.uses, inviterId: inv.inviter?.id || null });
      db.prepare(`
        INSERT INTO invite_cache (guild_id, code, uses, inviter_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, code) DO UPDATE SET uses = excluded.uses, inviter_id = excluded.inviter_id
      `).run(guild.id, code, inv.uses, inv.inviter?.id || null);
    }
    inviteCache.set(guild.id, map);
  } catch (e) {
    console.error(`[Invites] Could not fetch invites for ${guild.name}:`, e.message);
  }
}

function getActiveInviteCount(guildId, userId) {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM invites
    WHERE guild_id = ? AND inviter_id = ?
  `).get(guildId, userId);
  return row?.count || 0;
}

function getInviteRoleForCount(count) {
  for (const t of getInviteThresholds()) if (count >= t.count) return t.role;
  return null;
}

async function syncMemberRoles(member) {
  if (!member || member.user.bot) return;

  const guild = member.guild;
  const inviteCount = getActiveInviteCount(guild.id, member.id);
  const isBoosting = !!member.premiumSince;

  const wantedRoles = new Set();

  // Invite-based roles
  const inviteRoleName = getInviteRoleForCount(inviteCount);
  if (inviteRoleName) wantedRoles.add(inviteRoleName);

  // Boost roles: Discord does not expose individual boost counts, so admins confirm 2+.
  const confirmedBoostCount = Number(getConfig(`boost_count_${guild.id}_${member.id}`, '1'));
  const requiredBoostCount = Number(getConfig('boost_threshold', '2'));
  if (isBoosting) wantedRoles.add(confirmedBoostCount >= requiredBoostCount ? 'gold' : 'silver');

  const allManaged = ['bronze', 'silver', 'gold', 'diamond', 'premium'];
  const rolesToAdd = [];
  const rolesToRemove = [];

  for (const name of allManaged) {
    const roleId = getRoleId(name);
    if (!roleId) continue;
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    const has = member.roles.cache.has(roleId);
    const shouldHave = wantedRoles.has(name);

    if (shouldHave && !has) rolesToAdd.push(role);
    if (!shouldHave && has) rolesToRemove.push(role);
  }

  try {
    if (rolesToAdd.length) await member.roles.add(rolesToAdd, 'Gbauto: eligible');
    if (rolesToRemove.length) await member.roles.remove(rolesToRemove, 'Gbauto: no longer eligible');
  } catch (e) {
    console.error(`[Roles] Sync failed for ${member.user.tag}:`, e.message);
  }

  return { inviteCount, isBoosting, confirmedBoostCount, wantedRoles: [...wantedRoles] };
}

// ==================== EVENTS ====================
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
    console.log(`Invite cache loaded for ${guild.name}`);
  }
});

client.on(Events.InviteCreate, async (invite) => {
  const map = inviteCache.get(invite.guild.id) || new Map();
  map.set(invite.code, { uses: invite.uses, inviterId: invite.inviter?.id || null });
  inviteCache.set(invite.guild.id, map);
});

client.on(Events.InviteDelete, async (invite) => {
  const map = inviteCache.get(invite.guild.id);
  if (map) map.delete(invite.code);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;

  const guild = member.guild;
  let inviterId = null;

  try {
    const newInvites = await guild.invites.fetch();
    const oldMap = inviteCache.get(guild.id) || new Map();

    for (const [code, inv] of newInvites) {
      const old = oldMap.get(code);
      if (old && inv.uses > old.uses) {
        inviterId = inv.inviter?.id || old.inviterId;
        break;
      }
    }

    // Update the cache
    await cacheGuildInvites(guild);

    if (inviterId) {
      db.prepare(`
        INSERT OR REPLACE INTO invites (guild_id, inviter_id, invited_id, joined_at)
        VALUES (?, ?, ?, ?)
      `).run(guild.id, inviterId, member.id, Date.now());

      // Sync the inviter's roles
      const inviterMember = await guild.members.fetch(inviterId).catch(() => null);
      if (inviterMember) await syncMemberRoles(inviterMember);
    }
  } catch (e) {
    console.error('[GuildMemberAdd]', e.message);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;

  // Remove this member's invite record, if they were invited by someone
  const row = db.prepare('SELECT inviter_id FROM invites WHERE guild_id = ? AND invited_id = ?')
    .get(guild.id, member.id);

  if (row) {
    db.prepare('DELETE FROM invites WHERE guild_id = ? AND invited_id = ?')
      .run(guild.id, member.id);

    // Recalculate the inviter's roles
    const inviterMember = await guild.members.fetch(row.inviter_id).catch(() => null);
    if (inviterMember) await syncMemberRoles(inviterMember);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  // Detect boost started / stopped
  const wasBoosting = !!oldMember.premiumSince;
  const isBoosting = !!newMember.premiumSince;

  if (wasBoosting !== isBoosting) {
    if (!isBoosting) db.prepare('DELETE FROM config WHERE key = ?').run(`boost_count_${newMember.guild.id}_${newMember.id}`);
    await syncMemberRoles(newMember);
  }
});

// ==================== TEXT COMMANDS ====================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
  const isStaff = getConfig(`staff_${message.guild.id}_${message.author.id}`, '0') === '1';

  if (cmd === 'help') {
    const lines = [
      '**Member commands**',
      '`!help` — show this help',
      '`!invites [@member]` — view active invite count',
      '',
      '**Administrator commands**',
      '`!panel` — publish the invite/boost panel',
      '`!config` — view configured role IDs',
      '`!boosts set @member <1|2>` — confirm active boosts',
      '`!bronze set <roleId>`, `!silver set <roleId>`, `!gold set <roleId>`, `!diamond set <roleId>`, `!premium set <roleId>` — configure reward roles',
      '`!staff @member` — grant staff access',
      '`!staff remove @member` — revoke staff access'
    ];
    if (isAdmin) lines.push('', '**Your access**: Administrator');
    else if (isStaff) lines.push('', '**Your access**: Staff (no additional staff workflow commands are currently implemented).');
    const embed = new EmbedBuilder()
      .setTitle('Gbauto — Help & Commands')
      .setDescription(lines.join('\\n'))
      .setColor(0x5865F2);
    return message.reply({ embeds: [embed] });
  }

  // Staff access can only be granted or revoked by administrators.
  if (cmd === 'staff') {
    if (!isAdmin) return message.reply('Administrators only.');
    const target = message.mentions.members.first();
    const action = args[0]?.toLowerCase();
    if (!target) return message.reply('Usage: `!staff @member` or `!staff remove @member`.');
    if (target.id === message.author.id) return message.reply('You cannot change your own staff access.');
    if (action === 'remove') {
      db.prepare('DELETE FROM config WHERE key = ?').run(`staff_${message.guild.id}_${target.id}`);
      return message.reply(`Staff access removed for ${target}.`);
    }
    setConfig(`staff_${message.guild.id}_${target.id}`, '1');
    return message.reply(`Staff access granted to ${target}. Staff-specific request commands are not implemented yet.`);
  }

  // ---- !panel ----
  if (cmd === 'panel') {
    if (!isAdmin) return message.reply('Only administrators can post the panel.');

    const embed = new EmbedBuilder()
      .setTitle('Invite & Boost Rewards')
      .setDescription(
        'Click a button below to claim your role based on your current active stats.\n\n' +
        '**Active invites** (members still in the server):\n' +
        '• **5** → Bronze\n' +
        '• **10** → Silver\n' +
        '• **20** → Gold\n' +
        '• **33** → Premium\n\n' +
        '**Server boosts**:\n' +
        '• 1 confirmed active boost → Silver\n' +
        '• 2+ confirmed active boosts → Gold (administrator confirmation required)\n\n' +
        '*Roles are removed automatically when you are no longer eligible.*'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Gbauto • Claim your roles' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('claim_invites')
        .setLabel('Claim Invites')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📨'),
      new ButtonBuilder()
        .setCustomId('claim_boost')
        .setLabel('Claim Boost')
        .setStyle(ButtonStyle.Success)
        .setEmoji('⭐')
    );

    await message.channel.send({ embeds: [embed], components: [row] });
    if (message.deletable) message.delete().catch(() => {});
    return;
  }

  // ---- !invites [@user] ----
  if (cmd === 'invites') {
    const target = message.mentions.members.first() || message.member;
    const count = getActiveInviteCount(message.guild.id, target.id);
    const roleName = getInviteRoleForCount(count);

    const embed = new EmbedBuilder()
      .setTitle(`Invites for ${target.user.username}`)
      .setDescription(
        `**Active invites**: **${count}**\n` +
        (roleName ? `Eligible role: **${roleName}**` : 'No invite role earned yet.')
      )
      .setColor(0x57F287)
      .setThumbnail(target.user.displayAvatarURL());

    return message.reply({ embeds: [embed] });
  }

  // ---- !config ----
  if (cmd === 'config') {
    if (!isAdmin) return message.reply('Administrators only.');

    const lines = ['bronze', 'silver', 'gold', 'diamond', 'premium'].map(n => {
      const id = getRoleId(n);
      const role = message.guild.roles.cache.get(id);
      return `**${n}**: ${role ? role.toString() : '`' + id + '` (not found)'}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Role Configuration')
      .setDescription(lines.join('\n'))
      .setColor(0xFEE75C);

    return message.reply({ embeds: [embed] });
  }

  // ---- !boosts set @member <1|2> ----
  if (cmd === 'boosts' && args[0]?.toLowerCase() === 'set') {
    if (!isAdmin) return message.reply('Administrators only.');
    const target = message.mentions.members.first();
    const count = Number(args[2]);
    if (!target || ![1, 2].includes(count)) return message.reply('Usage: `!boosts set @member 1` or `!boosts set @member 2`. Use 2 for two or more active boosts.');
    if (!target.premiumSince) return message.reply('That member is not currently boosting this server.');
    setConfig(`boost_count_${message.guild.id}_${target.id}`, count);
    await syncMemberRoles(target);
    return message.reply(`Confirmed ${count === 2 ? '2+ active boosts' : '1 active boost'} for ${target}. Their boost role is now **${count === 2 ? 'Gold' : 'Silver'}**.`);
  }

  // ---- !bronze|silver|gold|diamond|premium set <id> ----
  const roleCmds = ['bronze', 'silver', 'gold', 'diamond', 'premium'];
  if (roleCmds.includes(cmd) && args[0]?.toLowerCase() === 'set') {
    if (!isAdmin) return message.reply('Administrators only.');

    const roleId = args[1];
    if (!roleId || !/^\d{17,20}$/.test(roleId)) {
      return message.reply(`Usage: !${cmd} set <roleId>`);
    }

    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('Role not found on this server.');

    setConfig(`role_${cmd}`, roleId);
    return message.reply(`The **${cmd}** role was updated to ${role}.`);
  }
});

// ==================== BUTTONS ====================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!['claim_invites', 'claim_boost'].includes(interaction.customId)) return;

  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member;
  if (!member) {
    return interaction.editReply('Could not retrieve your server member profile.');
  }

  // Refresh the member to get the latest premiumSince value
  const freshMember = await interaction.guild.members.fetch(member.id).catch(() => member);

  const result = await syncMemberRoles(freshMember);

  if (interaction.customId === 'claim_invites') {
    const roleName = getInviteRoleForCount(result.inviteCount);
    if (roleName) {
      await interaction.editReply(
        `You have **${result.inviteCount}** active invites.\n` +
        `Eligible role granted / verified: **${roleName}**.\n` +
        `Currently eligible roles: ${result.wantedRoles.join(', ') || 'none'}`
      );
    } else {
      await interaction.editReply(
        `You have **${result.inviteCount}** active invites.\n` +
        `You need at least **5** for Bronze.\n` +
        `(Only invited members who are still in the server count.)`
      );
    }
  } else {
    // claim_boost
    if (result.isBoosting) {
      await interaction.editReply(
        `You are currently boosting this server.\n` +
        `Confirmed boost count: **${result.confirmedBoostCount >= 2 ? '2+' : '1'}**.\n` +
        `Boost role granted / verified: **${result.confirmedBoostCount >= 2 ? 'Gold' : 'Silver'}**.\n\n` +
        `*Discord does not expose each member's exact boost count to bots. An administrator can confirm 2+ boosts with the command !boosts set @member 2.*`
      );
    } else {
      await interaction.editReply(
        `You are not currently boosting this server.\n` +
        `Boost the server to earn **Silver** (or **Gold** with 2+ confirmed boosts).`
      );
    }
  }
});

// ==================== LOGIN ====================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is missing from environment variables.');
  process.exit(1);
}

client.login(token);
