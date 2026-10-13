# Gbauto — Discord Invite & Boost Roles

Gbauto automatically assigns and removes roles based on active invites and server boosts.

## Role thresholds

| Role | Active invites | Boost requirement |
|---|---:|---|
| Bronze | 5+ | — |
| Silver | 10+ | 1 confirmed active boost |
| Gold | 20+ | 2+ confirmed active boosts |
| Diamond | 33+ | — |
| Premium | 40+ | — |

Invite roles use the highest threshold reached. Invite counts include only invited members who are still in the server. Boost roles are evaluated separately, so a member can qualify through invites and/or boosts.

**Important Discord limitation:** Discord's standard bot API does not expose the exact number of boosts contributed by an individual member. Gbauto treats an active booster as **1 boost by default**. An administrator must confirm when a member contributes 2 or more boosts. That confirmation is stored in SQLite and is cleared automatically when the member stops boosting.

## Commands

- `!panel` — Post the interactive rewards panel (administrators only).
- `!invites [@member]` — Show a member's active invite count and invite role.
- `!config` — Show configured role IDs.
- `!bronze set <roleId>`, `!silver set <roleId>`, `!gold set <roleId>`, `!diamond set <roleId>`, `!premium set <roleId>` — Configure role IDs (administrators only).
- `!boosts set @member 1` — Confirm that an active booster contributes one boost (administrators only).
- `!boosts set @member 2` — Confirm that an active booster contributes two or more boosts, granting Gold (administrators only).

The target member must currently be boosting the server before an administrator can set their confirmed boost count. If their boost ends, the confirmation is removed and their boost role is recalculated automatically.

## Required bot permissions

- Manage Roles
- Manage Server / Manage Guild (to fetch invites)
- View Channels, Send Messages, Embed Links
- Read Message History

**Gateway intents:** Guilds, GuildMembers, GuildInvites, GuildMessages, MessageContent.

## Installation (Railway)

1. In Railway, create a project and choose **Deploy from GitHub**.
2. Select this repository.
3. Set the `DISCORD_TOKEN` environment variable.
4. Optionally set `ROLE_BRONZE`, `ROLE_SILVER`, `ROLE_GOLD`, `ROLE_DIAMOND`, and `ROLE_PREMIUM` to override the default role IDs.
5. Deploy the service.

## Technical notes

- SQLite data is stored in `data/bot.db`.
- Invite records and role configuration persist across restarts.
- Roles are removed when members no longer qualify, including when invited members leave or boosting stops.
- The panel has two buttons: **Claim Invites** and **Claim Boost Role**.
