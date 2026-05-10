# Mehen

Server-side ops agent for [DigitalEmpire](https://github.com/chriscase/DigitalEmpire). Wraps each managed server in a nightly protective coil — backup orchestration, security scans, health checks — and reports results back to a DE control plane.

> _Mehen, the Egyptian protective serpent, coils around Ra's barque each night to defend it on its underworld journey._

## What it does

- **Backups (PR-3.5, this release):** `pg_dump` configured PostgreSQL databases, gzip them locally, optionally push to Linode Object Storage (S3-compatible), POST a run summary to DE.
- **Security scans (PR-4):** run SQL anomaly modules per database, file findings to DE.
- **Health checks (PR-5):** probe configured `/api/health` endpoints, sample to DE.

The CLI shape is stable; PR-4 and PR-5 add new subcommands without changing the existing ones.

## Install

On a target server (root):

```bash
curl -fsSL https://raw.githubusercontent.com/chriscase/mehen/main/scripts/install.sh | sudo bash
```

That clones the repo to `/srv/ops`, builds, and writes a config template at `/etc/abydos-ops.env` (mode 600).

To upgrade later, re-run the same command — `install.sh` is idempotent.

## Configuration

`/etc/abydos-ops.env` — root-owned, mode 600. Format is dotenv (`KEY=value`).

| Variable | Required | Notes |
|---|---|---|
| `MEHEN_BACKEND_URL` | yes | DE control plane base URL, e.g. `https://mehen.abydonian.com` |
| `MEHEN_AGENT_KEY_ID` | yes | Public agent key id (registered in DE's `AgentToken`) |
| `MEHEN_AGENT_KEY_HASH` | yes (or `KEY_SECRET`) | SHA-256 hex of the agent's keySecret. Use `KEY_SECRET` for first-run bootstrap; rotate to `KEY_HASH` once you've recorded it. |
| `MEHEN_AGENT_KEY_SECRET` | (alternative) | Raw secret. Hashed at load time. Prefer `KEY_HASH` for cold storage. |
| `MEHEN_ENTITY_ID` | yes | DE Entity row id this server is registered as |
| `MEHEN_DEPLOY_HOST` | yes | Friendly identifier in logs ("isis", "osiris") |
| `MEHEN_BACKUP_DBS` | yes | Comma-separated database names |
| `MEHEN_BACKUP_DIR` | no | Default `/srv/apps/backups` |
| `MEHEN_BACKUP_RETAIN_DAYS` | no | Default 7. Older `.sql.gz` files auto-pruned after each run. |
| `MEHEN_PG_USER` | no | Postgres role for `pg_dump`. Falls back to peer auth if unset. |
| `MEHEN_S3_ENDPOINT` | no | Linode `https://us-iad-10.linodeobjects.com` |
| `MEHEN_S3_REGION` | no | e.g. `us-iad-1` |
| `MEHEN_S3_BUCKET` | no | e.g. `chriscase-server-backups` |
| `MEHEN_S3_ACCESS_KEY` | no | |
| `MEHEN_S3_SECRET_KEY` | no | |

If any of the five S3 fields are missing, the agent runs in local-only mode (still records a `BackupRun` row, just with `offsiteUrl=null`). Useful for dev / first-run diagnostics.

## Commands

```
mehen backup [--db NAME ...] [--dry-run]
mehen scan      # PR-4
mehen health    # PR-5
mehen config    # print loaded config (with secrets masked)
mehen --help
```

Exit codes for `backup`:
- `0` — every DB succeeded
- `1` — at least one partial (dump succeeded, offsite upload failed)
- `2` — at least one full failure (pg_dump itself failed)

## Cron

Standard nightly invocation. Add to root's crontab (`sudo crontab -e`):

```
0 3 * * * /usr/local/bin/mehen backup >> /var/log/mehen.log 2>&1
```

Logs are line-delimited JSON; `grep -F '"failed"'` and `jq` work as expected.

## Auth

The agent signs every request to DE with HMAC-SHA256 over `<timestamp>\n<nonce>\n<body>`, using the agent's keyHash as the HMAC key. The DE control plane validates: keyId, signature, ±5min timestamp window, single-use nonce. Replays and substitutions are rejected.

To rotate a key: revoke the old `AgentToken` in DE's admin UI, issue a new one, update `MEHEN_AGENT_KEY_ID` + `MEHEN_AGENT_KEY_HASH` (or `_SECRET`) in `/etc/abydos-ops.env`. No agent restart needed — the next cron tick picks up the new env on its own dotenv read.

## Local development

```bash
git clone https://github.com/chriscase/mehen
cd mehen
npm install
npm run build
npm test
```

The CLI runs from `bin/mehen.js` after building. For end-to-end smoke testing, point a dev `MEHEN_BACKEND_URL` at a local DE instance.

## Architecture

See [chriscase/DigitalEmpire#105](https://github.com/chriscase/DigitalEmpire/issues/105) for the full epic. Mehen is one half (data plane); DE is the other (control plane + dashboard + MCP server).

## License

MIT.
