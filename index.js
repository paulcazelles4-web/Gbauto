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

// Valeurs par defaut (celles que tu as donnees)
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

// Seuils invites
const INVITE_THRESHOLDS = [
  { count: 33, role: 'premium' },
  { count: 20, role: 'gold' },
  { count: 10, role: 'silver' },
  { count: 5, role: 'bronze' }
];

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

// Cache invites en memoire (pour detecter qui a invite)
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
    console.error(`[Invites] Impossible de fetch les invites de ${guild.name}:`, e.message);
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
  for (const t of INVITE_THRESHOLDS) {
    if (count >= t.count) return t.role;
  }
  return null;
}

async function syncMemberRoles(member) {
  if (!member || member.user.bot) return;

  const guild = member.guild;
  const inviteCount = getActiveInviteCount(guild.id, member.id);
  const isBoosting = !!member.premiumSince;

  const wantedRoles = new Set();

  // Roles via invites
  const inviteRoleName = getInviteRoleForCount(inviteCount);
  if (inviteRoleName) wantedRoles.add(inviteRoleName);

  // Role via boost (Silver si boost actif)
  if (isBoosting) wantedRoles.add('silver');

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
    if (rolesToRemove.length) await member.roles.remove(rolesToRemove, 'Gbauto: plus eligible');
  } catch (e) {
    console.error(`[Roles] Erreur sync pour ${member.user.tag}:`, e.message);
  }

  return { inviteCount, isBoosting, wantedRoles: [...wantedRoles] };
}

// ==================== EVENTS ====================
client.once(Events.ClientReady, async () => {
  console.log(`Connecte en tant que ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
    console.log(`Cache invites charge pour ${guild.name}`);
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

    // Mettre a jour le cache
    await cacheGuildInvites(guild);

    if (inviterId) {
      db.prepare(`
        INSERT OR REPLACE INTO invites (guild_id, inviter_id, invited_id, joined_at)
        VALUES (?, ?, ?, ?)
      `).run(guild.id, inviterId, member.id, Date.now());

      // Sync le role de l'inviteur
      const inviterMember = await guild.members.fetch(inviterId).catch(() => null);
      if (inviterMember) await syncMemberRoles(inviterMember);
    }
  } catch (e) {
    console.error('[GuildMemberAdd]', e.message);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;

  // Retirer l'entree invite si cette personne avait ete invitee
  const row = db.prepare('SELECT inviter_id FROM invites WHERE guild_id = ? AND invited_id = ?')
    .get(guild.id, member.id);

  if (row) {
    db.prepare('DELETE FROM invites WHERE guild_id = ? AND invited_id = ?')
      .run(guild.id, member.id);

    // Resync l'inviteur
    const inviterMember = await guild.members.fetch(row.inviter_id).catch(() => null);
    if (inviterMember) await syncMemberRoles(inviterMember);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  // Detection boost ajoute / retire
  const wasBoosting = !!oldMember.premiumSince;
  const isBoosting = !!newMember.premiumSince;

  if (wasBoosting !== isBoosting) {
    await syncMemberRoles(newMember);
  }
});

// ==================== COMMANDES TEXTE ====================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);

  // ---- !panel ----
  if (cmd === 'panel') {
    if (!isAdmin) return message.reply('Seuls les administrateurs peuvent envoyer le panel.');

    const embed = new EmbedBuilder()
      .setTitle('Récompenses Invites & Boosts')
      .setDescription(
        'Clique sur un bouton ci-dessous pour **claim** ton rôle selon tes stats **actuelles et actives**.\n\n' +
        '**Invites actifs** (membres toujours présents) :\n' +
        '• **5** → Bronze\n' +
        '• **10** → Silver\n' +
        '• **20** → Gold\n' +
        '• **33** → Premium\n\n' +
        '**Boosts** :\n' +
        '• Boost actif → Silver\n\n' +
        '*Les rôles sont retirés automatiquement si tu n\'es plus éligible (invités partis ou boost retiré).*'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Gbauto • Claim tes rôles' })
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
      .setTitle(`Invites de ${target.user.username}`)
      .setDescription(
        `**Invites actifs** : **${count}**\n` +
        (roleName ? `Rôle éligible : **${roleName}**` : 'Aucun rôle invite pour le moment.')
      )
      .setColor(0x57F287)
      .setThumbnail(target.user.displayAvatarURL());

    return message.reply({ embeds: [embed] });
  }

  // ---- !config ----
  if (cmd === 'config') {
    if (!isAdmin) return message.reply('Admin uniquement.');

    const lines = ['bronze', 'silver', 'gold', 'diamond', 'premium'].map(n => {
      const id = getRoleId(n);
      const role = message.guild.roles.cache.get(id);
      return `**${n}** : ${role ? role.toString() : '`' + id + '` (introuvable)'}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Configuration des rôles')
      .setDescription(lines.join('\n'))
      .setColor(0xFEE75C);

    return message.reply({ embeds: [embed] });
  }

  // ---- !bronze|silver|gold|diamond|premium set <id> ----
  const roleCmds = ['bronze', 'silver', 'gold', 'diamond', 'premium'];
  if (roleCmds.includes(cmd) && args[0]?.toLowerCase() === 'set') {
    if (!isAdmin) return message.reply('Admin uniquement.');

    const roleId = args[1];
    if (!roleId || !/^\d{17,20}$/.test(roleId)) {
      return message.reply(`Usage : \`!${cmd} set <roleId>\``);
    }

    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('Rôle introuvable sur ce serveur.');

    setConfig(`role_${cmd}`, roleId);
    return message.reply(`Rôle **${cmd}** mis à jour → ${role}`);
  }
});

// ==================== BOUTONS ====================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!['claim_invites', 'claim_boost'].includes(interaction.customId)) return;

  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member;
  if (!member) {
    return interaction.editReply('Impossible de récupérer ton profil membre.');
  }

  // Force un refresh du membre pour premiumSince a jour
  const freshMember = await interaction.guild.members.fetch(member.id).catch(() => member);

  const result = await syncMemberRoles(freshMember);

  if (interaction.customId === 'claim_invites') {
    const roleName = getInviteRoleForCount(result.inviteCount);
    if (roleName) {
      await interaction.editReply(
        `Tu as **${result.inviteCount}** invites actifs.\n` +
        `Rôle accordé / vérifié : **${roleName}**.\n` +
        `Rôles actuellement éligibles : ${result.wantedRoles.join(', ') || 'aucun'}`
      );
    } else {
      await interaction.editReply(
        `Tu as **${result.inviteCount}** invites actifs.\n` +
        `Il t'en faut au moins **5** pour Bronze.\n` +
        `(Les invites comptent uniquement les membres encore présents sur le serveur)`
      );
    }
  } else {
    // claim_boost
    if (result.isBoosting) {
      await interaction.editReply(
        `Tu boostes actuellement ce serveur.\n` +
        `Rôle **Silver** accordé / vérifié.\n\n` +
        `*Note : Discord ne donne pas aux bots le nombre exact de boosts (1 vs 2+). Silver est donné dès qu'un boost est actif.*`
      );
    } else {
      await interaction.editReply(
        `Tu ne boostes pas actuellement ce serveur.\n` +
        `Boost le serveur pour obtenir le rôle **Silver**.`
      );
    }
  }
});

// ==================== LOGIN ====================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN manquant dans les variables d\'environnement.');
  process.exit(1);
}

client.login(token);
