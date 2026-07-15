# Realtime Bridge Deployment (Phase 15D)

Long-running WebSocket service for Twilio Media Streams + OpenAI Realtime voice.
The Next.js app on Vercel stays the HTTP entry point; this bridge handles live audio.

## Build and run locally

From repository root:

```bash
docker build -f services/realtime-bridge/Dockerfile -t roofing-realtime-bridge .
docker run --rm -p 8080:8080 --env-file services/realtime-bridge/.env.example roofing-realtime-bridge
```

Or from `services/realtime-bridge/`:

```bash
npm install
npm run build
npm start
```

Health check: `GET http://localhost:8080/health` → `ok`

WebSocket path: `ws://localhost:8080/media` (use `wss://` in production)

## Fly.io deploy

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and log in.
2. From repository root, create the app (once):

   ```bash
   fly launch --no-deploy --copy-config --name roofing-realtime-bridge
   ```

3. Set secrets (copy Supabase/OpenAI values from Vercel):

   ```bash
   fly secrets set \
     OPENAI_API_KEY="..." \
     REALTIME_BRIDGE_SIGNING_SECRET="..." \
     NEXT_PUBLIC_SUPABASE_URL="..." \
     SUPABASE_SERVICE_ROLE_KEY="..."
   ```

4. Deploy:

   ```bash
   fly deploy
   ```

5. Confirm health:

   ```bash
   curl https://roofing-realtime-bridge.fly.dev/health
   ```

6. WebSocket URL for Vercel Preview:

   ```
   wss://roofing-realtime-bridge.fly.dev/media
   ```

## Vercel Preview activation (private test only)

Add to **Preview** environment (not Production):

| Variable | Value |
|----------|--------|
| `REALTIME_VOICE_ENABLED` | `true` |
| `REALTIME_WEBSOCKET_URL` | `wss://<bridge-host>/media` |
| `REALTIME_BRIDGE_SIGNING_SECRET` | same as bridge |

Redeploy Preview. Point a **test Twilio number** (not production) to:

```
https://<preview-domain>/api/twilio/voice
```

## Fallback

If `REALTIME_VOICE_ENABLED` is not `true`, or URL/signing secret is missing, Vercel serves legacy Twilio `<Say>`/`<Gather>` automatically.

## Voice

Default male receptionist voice: `echo` (`OPENAI_REALTIME_VOICE`).
Also accepted: `ash`, `ballad`.
