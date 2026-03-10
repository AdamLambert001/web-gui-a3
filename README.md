# Arma 3 Remote Panel (Vercel)

This folder contains a minimal remote control panel intended to be deployed on Vercel.

- The **Agent** (your main `web-gui-a3` project) runs on the Arma host and actually
  starts/stops Arma 3 server processes.
- This **Remote** project provides a web UI and serverless API routes that call the Agent
  over HTTPS using a shared `AGENT_TOKEN`.

## Env vars (set in Vercel)

- `AGENT_BASE_URL` – public HTTPS URL of your Agent (e.g. `https://panel.wallace-dc.live`)
- `AGENT_TOKEN` – must match `AGENT_TOKEN` in the Agent's `.env`

## Deploying to Vercel

1. Push this folder as a separate repo, or tell Vercel to use `remote-panel/` as the root.
2. Framework preset: **Other** / **Static**.
3. Build command: leave empty or `npm run build` (no-op).
4. Output directory: `public`.
5. Set `AGENT_BASE_URL` and `AGENT_TOKEN` in the Vercel project settings.

