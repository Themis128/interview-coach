# interview-coach

Voice-enabled ML interview coach Cloudflare Worker.
Live at `https://interview-coach.baltzakis-themis.workers.dev` — all endpoints
require `?key=<AUTH_SECRET>` or `x-key` header (`AUTH_SECRET` is a wrangler secret).

Recovered verbatim from the deployed worker bundle (2026-11-06) — this repo is
the canonical source going forward.

## Architecture

```
browser ──▶ Worker fetch()
              ├─ /stt        WebSocket → Durable Object VoiceAgent → AI Flux STT (@cf/deepgram/flux)
              ├─ /transcribe POST audio bytes → STT fallback chain
              ├─ /tts        POST {text} → TTS  ⚠ melotts deprecated 2026-11-20
              ├─ /classify   POST {text} → INTERVIEWER|CANDIDATE (cheap model)
              ├─ /log        POST turn → D1 interview_db.turns
              ├─ /seed       POST {texts[]} → Vectorize cv-index embeddings
              ├─ /latest     GET last candidate answer (2s edge cache)
              ├─ /history    GET last 300 turns
              ├─ /engines/*  OpenAI-style proxy → CHAT_MODEL, optional RAG over Vectorize
              └─ /*          ASSETS (static UI)
```

## Models

| Constant | Model | Deprecation status |
|---|---|---|
| `CHAT_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ✅ supported |
| `CHEAP_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | ✅ supported |
| `EMBED` | `@cf/baai/bge-base-en-v1.5` | ✅ supported |
| Flux STT | `@cf/deepgram/flux` | ✅ supported |
| `/transcribe` chain | `@cf/deepgram/nova-3` → `whisper-large-v3-turbo` → `whisper` | ✅ all supported |
| `/tts` | `@cf/deepgram/aura-2-en` | ✅ migrated + deployed 2026-11-06 (was `melotts`) |

## /tts migration: melotts → aura-2-en (done)

Deployed 2026-11-06 (wrangler, version `c4e84fed`). The APIs differ — melotts
took `prompt`/`lang`/`voice` and returned base64 `audio`; aura-2-en takes
`text`/`speaker`/`encoding` and the binding returns a `ReadableStream` of MPEG
audio (with a base64 `res.audio` fallback kept for safety):

```js
const res = await env.AI.run("@cf/deepgram/aura-2-en", {
  text, speaker: "luna", encoding: "mp3",
});
if (res && typeof res.getReader === "function")
  return new Response(res, { headers: { "content-type": "audio/mpeg" } });
const bin = Uint8Array.from(atob((res && res.audio) || ""), c => c.charCodeAt(0));
return new Response(bin, { headers: { "content-type": "audio/mpeg" } });
```

## Deploy

```bash
wrangler deploy          # uses CLOUDFLARE_API_TOKEN / wrangler login
wrangler secret put AUTH_SECRET
```

Bindings (verified from live `/settings`): AI, ASSETS, AUTH_SECRET (secret),
D1 `interview_db` (`b00202a5-…`), Vectorize `cv-index`, DO `VoiceAgent`.
