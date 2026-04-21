# codex-proxy

OpenAI-compatible HTTP proxy for [Codex CLI](https://github.com/openai/codex), packaged with the [OpenClaw](https://github.com/openclaw) gateway.

Point any OpenAI-compatible client at `http://localhost:3001/v1` — no cloud API key needed.

## Architecture

```
OpenClaw / any client  →  codex-proxy :3001  →  codex exec (CLI)
```

## Setup

```bash
cp .env.example .env
# Edit .env
docker compose up -d
```

## Configuration

Everything lives in a single `.env` file — see `.env.example` for all variables with descriptions.

To run `codex-proxy` as a systemd user service instead of Docker:

```bash
cp codex-proxy/codex-proxy.service ~/.config/systemd/user/
systemctl --user enable --now codex-proxy
```

The service file uses `%h` for the home directory — no hardcoded paths.

## Interactive approvals (optional)

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_APPROVAL_CHAT_ID` to receive inline Telegram buttons when Codex requests a shell action. Auto-denied after 2 minutes.
