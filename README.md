# Gbauto — Discord Invite & Boost Roles

Gbauto assigns and removes roles based on **active invites** and **active server boosts**.

## Role thresholds

| Role | Active invites | Boosts |
|------|----------------|--------|
| Bronze | 5+ | — |
| Silver | 10+ | 1 active boost (claim button) |
| Gold | 20+ | — |
| Premium | 33+ | — |
| Diamond | configurable | — |

Invite counts only include members who are **still in the server**.

### Boosts

- **1 boost** → claim with the button → **Silver**
- **2 boosts** → open a **ticket** for staff verification (bots cannot see exact boost count per user)

Roles are removed automatically when the member is no longer eligible (invited members left or boost removed).

## Commands

| Command | Description |
|---------|-------------|
| `!panel` | Post the interactive rewards panel (admin) |
| `!invites [@member]` | Show active invite count |
| `!config` | Show configured role IDs (admin) |
| `!bronze set <roleId>` | Set Bronze role ID (admin) |
| `!silver set <roleId>` | Set Silver role ID (admin) |
| `!gold set <roleId>` | Set Gold role ID (admin) |
| `!diamond set <roleId>` | Set Diamond role ID (admin) |
| `!premium set <roleId>` | Set Premium role ID (admin) |
| `!help` | List available commands |

## Required bot permissions

- Manage Roles
- Manage Server (to fetch invites)
- View Channels, Send Messages, Embed Links
- Read Message History

**Gateway intents:** Guilds, GuildMembers, GuildInvites, GuildMessages, MessageContent

## Installation (Railway)

1. Railway → New Project → Deploy from GitHub → select this repo
2. Set environment variable: `DISCORD_TOKEN`
3. Optional: `ROLE_BRONZE`, `ROLE_SILVER`, `ROLE_GOLD`, `ROLE_DIAMOND`, `ROLE_PREMIUM`
4. Deploy

Place the bot role **above** the reward roles in the server hierarchy.

## Technical notes

- SQLite storage in `data/bot.db`
- Panel buttons: **Claim Invites** and **Claim Boost**
- All user-facing text is in English
