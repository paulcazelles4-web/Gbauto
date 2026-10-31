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
  Events,
  ChannelType
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
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function deleteConfig(key) {
  db.prepare('DELETE FROM config WHERE key = ?').run(key);
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

// Default invite thresholds
const DEFAULT_THRESHOLDS = {
  bronze: 5,
  silver: 10,
  gold: 20,
  diamond: 0,
  premium: 33
};

for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) {
  if (!getConfig(`threshold_${k}`)) setConfig(`threshold_${k}`, v);
}

// Role rank (higher = better). Only the highest eligible role is kept.
const ROLE_RANK = {
  bronze: 1,
  silver: 2,
  gold: 3,
  diamond: 4,
  premium: 5
};

const ROLE_NAMES = ['bronze', 'silver', 'gold', 'diamond', 'premium'];

function getRoleId(name) {
  return getConfig(`role_${name}`, DEFAULT_ROLES[name]);
}

function getThreshold(name) {
  return Number(getConfig(`threshold_${name}`, DEFAULT_THRESHOLDS[name] ?? 0));
}

function getInviteThresholdsSorted() {
  return ROLE_NAMES
    .map((role) => ({ role, count: getThreshold(role) }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);
}

function getInviteRoleForCount(count) {
  for (const t of getInviteThresholdsSorted()) {
    if (count >= t.count) return t.role;
  }
  return null;
}

function getBoostRole(guildId, userId, isBoosting) {
  if (!isBoosting) return null;
  const confirmed = Number(getConfig(`boost_confirmed_${guildId}_${userId}`, '0'));
  // 2+ boosts confirmed by staff -> gold, else 1 boost -> silver
  return confirmed >= 2 ? 'gold' : 'silver';
}

function pickHighestRole(...roleNames) {
  let best = null;
  let bestRank = 0;
  for (const name of roleNames) {
    if (!name) continue;
    const rank = ROLE_RANK[name] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = name;
    }
  }
  return best;
}

function formatThresholdsText() {
  const lines = [];
  for (const t of getInviteThresholdsSorted().slice().reverse()) {
    lines.push(`• **${t.count}** → ${t.role.charAt(0).toUpperCase() + t.role.slice(1)}`);
  }
  return lines.join('\n') || 'No invite thresholds configured.';
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

const inviteCache = new Map();

// ==================== LOGS ====================
async function sendLog(guild, content, color = 0x5865F2) {
  const channelId = getConfig(`log_channel_${guild.id}`);
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setDescription(content)
    .setColor(color)
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('[Log]', e.message);
  }
}

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

function getLeaderboard(guildId, limit = 10) {
  return db.prepare(`
    SELECT inviter_id, COUNT(*) as count
    FROM invites
    WHERE guild_id = ?
    GROUP BY inviter_id
    ORDER BY count DESC
    LIMIT ?
  `).all(guildId, limit);
}

/**
 * Sync roles: only ONE role — the highest from invites OR boosts.
 */
async function syncMemberRoles(member, reason = 'sync') {
  if (!member || member.user.bot) return null;

  const guild = member.guild;
  const inviteCount = getActiveInviteCount(guild.id, member.id);
  const isBoosting = !!member.premiumSince;

  const inviteRole = getInviteRoleForCount(inviteCount);
  const boostRole = getBoostRole(guild.id, member.id, isBoosting);
  const highest = pickHighestRole(inviteRole, boostRole);

  const rolesToAdd = [];
  const rolesToRemove = [];
  let previousRole = null;

  for (const name of ROLE_NAMES) {
    const roleId = getRoleId(name);
    if (!roleId) continue;
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;

    const has = member.roles.cache.has(roleId);
    if (has) previousRole = name;

    const shouldHave = highest === name;
    if (shouldHave && !has) rolesToAdd.push(role);
    if (!shouldHave && has) rolesToRemove.push(role);
  }

  try {
    if (rolesToAdd.length) await member.roles.add(rolesToAdd, `Gbauto: ${reason}`);
    if (rolesToRemove.length) await member.roles.remove(rolesToRemove, `Gbauto: ${reason}`);
  } catch (e) {
    console.error(`[Roles] Sync failed for ${member.user.tag}:`, e.message);
  }

  if (highest !== previousRole) {
    if (highest && !previousRole) {
      await sendLog(
        guild,
        `✅ **Role granted** to <@${member.id}> → **${highest}**\nInvites: ${inviteCount} | Boosting: ${isBoosting ? 'yes' : 'no'}\nReason: ${reason}`,
        0x57F287
      );
    } else if (!highest && previousRole) {
      await sendLog(
        guild,
        `❌ **Role removed** from <@${member.id}> (was **${previousRole}**)\nInvites: ${inviteCount} | Boosting: ${isBoosting ? 'yes' : 'no'}\nReason: ${reason}`,
        0xED4245
      );
    } else if (highest && previousRole && highest !== previousRole) {
      await sendLog(
        guild,
        `🔄 **Role updated** for <@${member.id}>: **${previousRole}** → **${highest}**\nInvites: ${inviteCount} | Boosting: ${isBoosting ? 'yes' : 'no'}\nReason: ${reason}`,
        0xFEE75C
      );
    }
  }

  return {
    inviteCount,
    isBoosting,
    inviteRole,
    boostRole,
    highest,
    previousRole
  };
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

    await cacheGuildInvites(guild);

    if (inviterId) {
      db.prepare(`
        INSERT OR REPLACE INTO invites (guild_id, inviter_id, invited_id, joined_at)
        VALUES (?, ?, ?, ?)
      `).run(guild.id, inviterId, member.id, Date.now());

      await sendLog(
        guild,
        `📥 **Member joined** <@${member.id}>\nInvited by: <@${inviterId}>`,
        0x57F287
      );

      const inviterMember = await guild.members.fetch(inviterId).catch(() => null);
      if (inviterMember) await syncMemberRoles(inviterMember, 'invite gained');
    } else {
      await sendLog(
        guild,
        `📥 **Member joined** <@${member.id}>\nInviter: unknown (vanity / direct)`,
        0x99AAB5
      );
    }
  } catch (e) {
    console.error('[GuildMemberAdd]', e.message);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;

  const row = db.prepare(
    'SELECT inviter_id FROM invites WHERE guild_id = ? AND invited_id = ?'
  ).get(guild.id, member.id);

  if (row) {
    db.prepare('DELETE FROM invites WHERE guild_id = ? AND invited_id = ?')
      .run(guild.id, member.id);

    await sendLog(
      guild,
      `📤 **Member left** <@${member.id}>\nWas invited by: <@${row.inviter_id}> (invite credit removed)`,
      0xED4245
    );

    const inviterMember = await guild.members.fetch(row.inviter_id).catch(() => null);
    if (inviterMember) await syncMemberRoles(inviterMember, 'invite lost');
  }

  // Clear boost confirmation if they leave
  deleteConfig(`boost_confirmed_${guild.id}_${member.id}`);
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const wasBoosting = !!oldMember.premiumSince;
  const isBoosting = !!newMember.premiumSince;

  if (wasBoosting !== isBoosting) {
    if (!isBoosting) {
      deleteConfig(`boost_confirmed_${newMember.guild.id}_${newMember.id}`);
      await sendLog(
        newMember.guild,
        `⭐ **Boost ended** for <@${newMember.id}>`,
        0xED4245
      );
    } else {
      await sendLog(
        newMember.guild,
        `⭐ **Boost started** for <@${newMember.id}>`,
        0x57F287
      );
    }
    await syncMemberRoles(newMember, isBoosting ? 'boost started' : 'boost ended');
  }
});

// ==================== TEXT COMMANDS ====================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);

  // ---- !help ----
  if (cmd === 'help') {
    const lines = [
      '**Member commands**',
      '• `!invites [@member]` — view active invite count',
      '• `!leaderboard` / `!top` — top inviters',
      '',
      '**Rewards**',
      'Use the panel buttons to claim your roles.'
    ];

    if (isAdmin) {
      lines.push(
        '',
        '**Admin commands**',
        '• `!panel` — post the rewards panel',
        '• `!config` — view role IDs & thresholds',
        '• `!log set #channel` — set log channel',
        '• `!log off` — disable logs',
        '• `!boost confirm @member` — confirm 2 boosts → Gold',
        '• `!boost revoke @member` — remove 2-boost confirmation',
        '• `!threshold` — list invite thresholds',
        '• `!threshold set <role> <number>` — set threshold (0 = disabled)',
        '• `!bronze set <roleId>` (also silver/gold/diamond/premium)'
      );
    }

    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Gbauto | Help')
          .setDescription(lines.join('\n'))
          .setColor(0x5865F2)
      ]
    });
  }

  // ---- !panel ----
  if (cmd === 'panel') {
    if (!isAdmin) return message.reply('Only administrators can post the panel.');

    const embed = new EmbedBuilder()
      .setTitle('Invite & Boost Rewards')
      .setDescription(
        'Click a button below to **claim** your role based on your **current active** stats.\n\n' +
        '**Active invites** (members still in the server):\n' +
        formatThresholdsText() +
        '\n\n**Server boosts**:\n' +
        '• **1 boost** → Silver (claim with the button)\n' +
        '• **2 boosts** → Open a ticket — staff uses `!boost confirm`\n\n' +
        '*Only your **highest** role is kept (roles do not stack).*\n' +
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

  // ---- !invites ----
  if (cmd === 'invites') {
    const target = message.mentions.members.first() || message.member;
    const count = getActiveInviteCount(message.guild.id, target.id);
    const roleName = getInviteRoleForCount(count);
    const next = getInviteThresholdsSorted()
      .slice()
      .reverse()
      .find((t) => count < t.count);

    let desc = `**Active invites**: **${count}**\n`;
    desc += roleName
      ? `Eligible invite role: **${roleName}**\n`
      : 'No invite role earned yet.\n';
    if (next) desc += `Next: **${next.count - count}** more for **${next.role}**.`;

    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Invites for ${target.user.username}`)
          .setDescription(desc)
          .setColor(0x57F287)
          .setThumbnail(target.user.displayAvatarURL())
      ]
    });
  }

  // ---- !leaderboard / !top ----
  if (cmd === 'leaderboard' || cmd === 'top') {
    const rows = getLeaderboard(message.guild.id, 10);
    if (!rows.length) {
      return message.reply('No invite data yet.');
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const prefix = medals[i] || `**${i + 1}.**`;
      lines.push(`${prefix} <@${r.inviter_id}> — **${r.count}** invite${r.count === 1 ? '' : 's'}`);
    }

    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🏆 Invite Leaderboard')
          .setDescription(lines.join('\n'))
          .setColor(0xFEE75C)
          .setFooter({ text: 'Active invites only (members still in the server)' })
          .setTimestamp()
      ]
    });
  }

  // ---- !config ----
  if (cmd === 'config') {
    if (!isAdmin) return message.reply('Administrators only.');

    const roleLines = ROLE_NAMES.map((n) => {
      const id = getRoleId(n);
      const role = message.guild.roles.cache.get(id);
      return `**${n}**: ${role ? role.toString() : '`' + id + '` (not found)'}`;
    });

    const logId = getConfig(`log_channel_${message.guild.id}`);
    const logLine = logId
      ? `**Log channel**: <#${logId}>`
      : '**Log channel**: not set (`!log set #channel`)';

    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Configuration')
          .setDescription(
            '**Roles**\n' + roleLines.join('\n') +
            '\n\n**Invite thresholds**\n' + formatThresholdsText() +
            '\n\n' + logLine
          )
          .setColor(0xFEE75C)
      ]
    });
  }

  // ---- !log set #channel / !log off ----
  if (cmd === 'log') {
    if (!isAdmin) return message.reply('Administrators only.');

    const sub = args[0]?.toLowerCase();
    if (sub === 'off' || sub === 'disable') {
      deleteConfig(`log_channel_${message.guild.id}`);
      return message.reply('Logs disabled.');
    }

    if (sub === 'set') {
      const channel =
        message.mentions.channels.first() ||
        message.guild.channels.cache.get(args[1]);

      if (!channel || channel.type !== ChannelType.GuildText) {
        return message.reply('Usage: `!log set #channel`');
      }

      setConfig(`log_channel_${message.guild.id}`, channel.id);
      await sendLog(
        message.guild,
        `📋 Log channel set to ${channel} by <@${message.author.id}>`,
        0x5865F2
      );
      return message.reply(`Log channel set to ${channel}.`);
    }

    const current = getConfig(`log_channel_${message.guild.id}`);
    return message.reply(
      current
        ? `Current log channel: <#${current}>\nUse \`!log set #channel\` or \`!log off\`.`
        : 'No log channel set. Use `!log set #channel`.'
    );
  }

  // ---- !boost confirm @member / !boost revoke @member ----
  if (cmd === 'boost') {
    if (!isAdmin) return message.reply('Administrators only.');

    const sub = args[0]?.toLowerCase();
    const target = message.mentions.members.first();

    if (!target) {
      return message.reply(
        'Usage:\n`!boost confirm @member` — confirm 2 boosts (Gold)\n`!boost revoke @member` — remove confirmation'
      );
    }

    if (sub === 'confirm') {
      if (!target.premiumSince) {
        return message.reply(`${target} is not currently boosting this server.`);
      }
      setConfig(`boost_confirmed_${message.guild.id}_${target.id}`, '2');
      const result = await syncMemberRoles(target, 'boost confirm (2+)');
      await sendLog(
        message.guild,
        `⭐ **2 boosts confirmed** for <@${target.id}> by <@${message.author.id}>\nRole: **${result?.highest || 'none'}**`,
        0x57F287
      );
      return message.reply(
        `Confirmed **2+ boosts** for ${target}. Role: **${result?.highest || 'none'}**.`
      );
    }

    if (sub === 'revoke') {
      deleteConfig(`boost_confirmed_${message.guild.id}_${target.id}`);
      const result = await syncMemberRoles(target, 'boost confirm revoked');
      await sendLog(
        message.guild,
        `⭐ **Boost confirmation revoked** for <@${target.id}> by <@${message.author.id}>\nRole: **${result?.highest || 'none'}**`,
        0xFEE75C
      );
      return message.reply(
        `Boost confirmation removed for ${target}. Role: **${result?.highest || 'none'}**.`
      );
    }

    return message.reply(
      'Usage:\n`!boost confirm @member`\n`!boost revoke @member`'
    );
  }

  // ---- !threshold / !threshold set <role> <number> ----
  if (cmd === 'threshold' || cmd === 'thresholds') {
    if (!isAdmin) return message.reply('Administrators only.');

    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Invite Thresholds')
            .setDescription(
              formatThresholdsText() +
              '\n\nUsage: `!threshold set <bronze|silver|gold|diamond|premium> <number>`\nUse `0` to disable a tier.'
            )
            .setColor(0x5865F2)
        ]
      });
    }

    if (sub === 'set') {
      const roleName = args[1]?.toLowerCase();
      const count = Number(args[2]);

      if (!ROLE_NAMES.includes(roleName) || Number.isNaN(count) || count < 0) {
        return message.reply(
          'Usage: `!threshold set <bronze|silver|gold|diamond|premium> <number>`'
        );
      }

      setConfig(`threshold_${roleName}`, Math.floor(count));
      return message.reply(
        count === 0
          ? `Threshold for **${roleName}** disabled.`
          : `Threshold for **${roleName}** set to **${Math.floor(count)}** invites.`
      );
    }

    return message.reply('Usage: `!threshold` or `!threshold set <role> <number>`');
  }

  // ---- !bronze|silver|gold|diamond|premium set <id> ----
  if (ROLE_NAMES.includes(cmd) && args[0]?.toLowerCase() === 'set') {
    if (!isAdmin) return message.reply('Administrators only.');

    const roleId = args[1];
    if (!roleId || !/^\d{17,20}$/.test(roleId)) {
      return message.reply(`Usage: \`!${cmd} set <roleId>\``);
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
    return interaction.editReply('Could not retrieve your member profile.');
  }

  const freshMember = await interaction.guild.members.fetch(member.id).catch(() => member);
  const result = await syncMemberRoles(
    freshMember,
    interaction.customId === 'claim_invites' ? 'claim invites' : 'claim boost'
  );

  if (!result) {
    return interaction.editReply('Could not sync your roles.');
  }

  if (interaction.customId === 'claim_invites') {
    const next = getInviteThresholdsSorted()
      .slice()
      .reverse()
      .find((t) => result.inviteCount < t.count);

    if (result.highest) {
      let msg =
        `You have **${result.inviteCount}** active invites.\n` +
        `Your role: **${result.highest}**` +
        (result.inviteRole && result.boostRole && result.inviteRole !== result.boostRole
          ? ` (best of invites: **${result.inviteRole}**, boost: **${result.boostRole}**)`
          : '') +
        '.';
      if (next) msg += `\n**${next.count - result.inviteCount}** more invites for **${next.role}**.`;
      await interaction.editReply(msg);
    } else {
      const min = getInviteThresholdsSorted().slice().reverse()[0];
      await interaction.editReply(
        `You have **${result.inviteCount}** active invites.\n` +
          (min
            ? `You need at least **${min.count}** for **${min.role}**.\n`
            : '') +
          `(Only invited members who are still in the server count.)`
      );
    }
  } else {
    // claim_boost
    if (result.isBoosting) {
      const confirmed = Number(
        getConfig(`boost_confirmed_${interaction.guild.id}_${freshMember.id}`, '0')
      );
      if (confirmed >= 2) {
        await interaction.editReply(
          `You are boosting this server (**2+ boosts confirmed**).\n` +
            `Your role: **${result.highest || 'none'}**.`
        );
      } else {
        await interaction.editReply(
          `You are currently boosting this server.\n` +
            `Your role: **${result.highest || 'silver'}**.\n\n` +
            `If you have **2 boosts**, please **open a ticket**.\n` +
            `Staff can confirm with \`!boost confirm @you\`.`
        );
      }
    } else {
      await interaction.editReply(
        `You are not currently boosting this server.\n` +
          `Boost once to claim **Silver**.\n` +
          `For **2 boosts**, open a ticket after boosting for staff verification.`
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
