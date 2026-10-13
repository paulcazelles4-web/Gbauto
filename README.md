# Gbauto - Bot Roles Invites & Boosts

Bot Discord qui donne des roles selon le nombre d'**invites actifs** (membres toujours presents) et les **boosts actifs**.

## Roles & seuils

| Role    | Invites actifs | Boosts |
|---------|----------------|--------|
| Bronze  | 5              | -      |
| Silver  | 10             | 1+     |
| Gold    | 20             | -*     |
| Premium | 33             | -      |
| Diamond | (configurable) | -      |

* Discord ne fournit pas officiellement le nombre exact de boosts par membre aux bots. Le bot donne **Silver** des qu'un membre boost activement (`premiumSince`). Gold est principalement via invites.

## Commandes

- `!panel` - Envoie le panel interactif (admin)
- `!bronze set <roleId>` / `!silver set <roleId>` / `!gold set <roleId>` / `!diamond set <roleId>` / `!premium set <roleId>`
- `!invites [@membre]` - Voir les invites actifs d'un membre
- `!config` - Affiche la config actuelle des roles

## Permissions requises du bot

- Manage Roles
- Manage Guild (pour lire les invites)
- View Channels / Send Messages / Embed Links
- Read Message History

**Intents** : Guilds, GuildMembers, GuildInvites, GuildMessages, MessageContent

## Installation (Railway)

1. Sur Railway : New Project -> Deploy from GitHub -> selectionne ce repo
2. Variables d'environnement :
   - `DISCORD_TOKEN`
   - (optionnel) les ROLE_* si tu veux override
3. Deploy

## Notes techniques

- Stockage SQLite (`data/bot.db`) pour les invites et la config
- Les roles sont retires automatiquement si le membre n'est plus eligible (invites partis ou boost retire)
- Le panel a 2 boutons : **Claim Invites** et **Claim Boost**
