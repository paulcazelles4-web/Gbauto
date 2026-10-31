# Gbauto — Discord Invite & Boost Roles

Gbauto assigns and removes roles based on **active invites** and **active server boosts**.

**Only the highest eligible role is kept** (roles do not stack).

## Default thresholds

| Role | Active invites | Boosts |
|------|----------------|--------|
| Bronze | 5+ | — |
| Silver | 10+ | 1 active boost |
| Gold | 20+ | 2 boosts (staff: `!boost confirm`) |
| Premium | 33+ | — |
| Diamond | disabled by default | — |

Invite counts only include members who are **still in the server**. Thresholds are configurable with `!threshold`.

### Boosts

- **1 boost** → claim button → **Silver** (if higher than invite role)
- **2 boosts** → open a ticket → staff runs `!boost confirm @user` → **Gold**

## Commands

| Command | Description |
|---------|-------------|
| `!panel` | Post the rewards panel (admin) |
| `!invites [@member]` | Active invite count + progress |
| `!leaderboard` / `!top` | Top 10 inviters |
| `!config` | Roles, thresholds, log channel (admin) |
| `!log set #channel` | Set log channel (admin) |
| `!log off` | Disable logs (admin) |
| `!boost confirm @member` | Confirm 2 boosts → Gold (admin) |
| `!boost revoke @member` | Remove boost confirmation (admin) |
| `!threshold` | List invite thresholds (admin) |
| `!threshold set <role> <n>` | Set threshold, 0 = off (admin) |
| `!bronze set <roleId>` | Set role ID (also silver/gold/diamond/premium) |
| `!help` | List commands |

## Logs

When a log channel is set, the bot posts:
- Member joined / left (with inviter)
- Role granted / updated / removed
- Boost started / ended
- Boost confirm / revoke

## Required permissions

- Manage Roles, Manage Server
- View Channels, Send Messages, Embed Links, Read Message History

**Intents:** Guilds, GuildMembers, GuildInvites, GuildMessages, MessageContent

## Railway

1. Deploy from GitHub
2. Env: `DISCORD_TOKEN`
3. Optional: `ROLE_BRONZE`, `ROLE_SILVER`, etc.
4. Put the bot role **above** reward roles

SQLite data lives in `data/bot.db` — use a persistent volume on Railway so data survives redeploys.
