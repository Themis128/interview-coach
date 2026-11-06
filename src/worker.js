const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CHEAP_MODEL = "@cf/openai/gpt-oss-20b";
const EMBED = "@cf/baai/bge-base-en-v1.5";
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

function json(d, extra) {
  return new Response(JSON.stringify(d), {
    headers: Object.assign({ "content-type": "application/json" }, extra || {}),
  });
}

async function embed(env, texts) {
  const r = await env.AI.run(EMBED, { text: texts });
  return r.data;
}

// Durable Object: owns the Flux STT session per channel; survives client WS reconnects
export class VoiceAgent {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
      return new Response("websocket expected", { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[1], server = pair[0];
    server.accept();
    const resp = await this.env.AI.run("@cf/deepgram/flux", {
      encoding: "linear16",
      sample_rate: "16000",
      eager_eot_threshold: "0.5",
      eot_threshold: "0.7",
      keyterm: "machine learning,deep learning,neural network,overfitting,regularization,dropout,transformer,gradient,TensorFlow,PyTorch,embeddings,fine-tuning,LLM,RAG,AUC,F1,precision,recall",
    }, { websocket: true });
    const flux = resp.webSocket;
    flux.accept();
    server.addEventListener("message", e => { try { flux.send(e.data); } catch (x) {} });
    server.addEventListener("close", () => { try { flux.close(); } catch (x) {} });
    flux.addEventListener("message", e => { try { server.send(e.data); } catch (x) {} });
    flux.addEventListener("close", () => { try { server.close(); } catch (x) {} });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const k = req.headers.get("x-key") || url.searchParams.get("key");
    if (k !== env.AUTH_SECRET) return new Response("forbidden", { status: 403 });
    if (req.method === "OPTIONS")
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });

    if (url.pathname === "/stt") {
      if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("websocket expected", { status: 426 });
      const ch = url.searchParams.get("ch") || "tab";
      const id = env.VOICE.idFromName("session-" + ch);
      return env.VOICE.get(id).fetch(req);
    }

    if (req.method === "POST" && url.pathname === "/transcribe") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_AUDIO_BYTES) return json({ text: "", err: "too_large" }, { status: 413 });
      let res = null;
      for (const m of ["@cf/deepgram/nova-3", "@cf/openai/whisper-large-v3-turbo", "@cf/openai/whisper"]) {
        try { res = await env.AI.run(m, { audio: Array.from(bytes) }); break; } catch (e) {}
      }
      let txt = (res && (res.text || (res.results && res.results.channels && res.results.channels[0] &&
        res.results.channels[0].alternatives && res.results.channels[0].alternatives[0] &&
        res.results.channels[0].alternatives[0].transcript))) || "";
      const w = txt.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
      const uniq = new Set(w);
      const JUNK = /thank you (very much|for watching|for joining)|i'?m sorry|subscribe|bye bye|so, so|that's it\.?$/i;
      if (!txt.trim() || JUNK.test(txt) || w.length < 3 || (w.length > 6 && uniq.size / w.length < 0.25)) txt = "";
      return json({ text: txt });
    }

    if (req.method === "POST" && url.pathname === "/tts") {
      const { text } = await req.json();
      // melotts deprecated 2026-11-20 -> Deepgram Aura-2; returns a ReadableStream of MPEG audio
      const res = await env.AI.run("@cf/deepgram/aura-2-en", {
        text, speaker: "luna", encoding: "mp3",
      });
      if (res && typeof res.getReader === "function")
        return new Response(res, { headers: { "content-type": "audio/mpeg" } });
      const bin = Uint8Array.from(atob((res && res.audio) || ""), c => c.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": "audio/mpeg" } });
    }

    if (req.method === "POST" && url.pathname === "/classify") {
      const { text } = await req.json();
      const res = await env.AI.run(CHEAP_MODEL, {
        messages: [
          { role: "system", content: `Reply with exactly one word: INTERVIEWER or CANDIDATE.
INTERVIEWER examples: Tell me about yourself. How do you handle overfitting? What is supervised learning? Can you explain your approach? Describe a project.
CANDIDATE examples: I choose deep learning. My day is good. I am an engineer. I handled it with dropout. Yes my name is Tom.` },
          { role: "user", content: text },
        ],
        max_tokens: 300,
        temperature: 0,
      });
      const content = (res.choices && res.choices[0] && res.choices[0].message &&
        res.choices[0].message.content) || res.response || "";
      const w = content.toUpperCase();
      return json({ who: w.includes("INTERVIEWER") ? "interviewer" : "candidate" });
    }

    if (req.method === "POST" && url.pathname === "/log") {
      const { session, who, text } = await req.json();
      ctx.waitUntil(env.interview_db.prepare(
        "INSERT INTO turns(session,who,text,ts) VALUES(?,?,?,?)")
        .bind(session, who, text, Date.now()).run());
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/seed") {
      const { texts } = await req.json();
      const vecs = await embed(env, texts);
      const rows = texts.map((t, i) => ({
        id: "cv" + i + "-" + Date.now(),
        values: vecs[i],
        metadata: { text: t },
      }));
      await env.VECTORIZE.upsert(rows);
      return json({ ok: true, n: rows.length });
    }

    if (url.pathname === "/latest") {
      const cache = caches.default;
      const ck = new Request("https://ic.internal/latest");
      const hit = await cache.match(ck);
      if (hit) return hit;
      const r = await env.interview_db.prepare(
        "SELECT text,ts FROM turns WHERE who='ans' ORDER BY ts DESC LIMIT 1").first();
      const resp = json(r || { text: "" }, { "cache-control": "max-age=2" });
      ctx.waitUntil(cache.put(ck, resp.clone()));
      return resp;
    }

    if (url.pathname === "/history") {
      const r = await env.interview_db.prepare(
        "SELECT session,who,text,ts FROM turns ORDER BY ts DESC LIMIT 300").all();
      return json(r.results || []);
    }

    if (req.method === "POST" && url.pathname.startsWith("/engines/")) {
      const body = await req.json();
      let ctx = "";
      try {
        const last = (body.messages || []).filter(m => m.role === "user").pop();
        if (last && body.rag !== false) {
          const q = (await embed(env, [last.content]))[0];
          const hits = await env.VECTORIZE.query(q, { topK: 5 });
          const facts = (hits.matches || []).filter(m => m.score > 0.4).map(m => m.metadata.text);
          if (facts.length) ctx = "\nRelevant facts about this candidate: " + facts.join(" | ");
        }
      } catch (e) { /* rag optional */ }
      const msgs = (body.messages || []).map(m =>
        m.role === "system" ? { role: "system", content: m.content + ctx } : m);
      const stream = body.stream !== false;
      const params = { messages: msgs, max_tokens: body.max_tokens || 220, stream };
      if (body.lora) params.lora = body.lora;
      try {
        const res = await env.AI.run(body.model || CHAT_MODEL, params);
        if (!stream || !res.getReader)
          return json({ choices: [{ message: { content: res.response || "" } }] });
        return new Response(res, { headers: { "content-type": "text/event-stream" } });
      } catch (e) {
        const msg = String(e && e.message || e);
        const friendly = msg.includes("4006")
          ? "AI quota exhausted — resets at UTC midnight, or upgrade the Workers plan."
          : "AI error: " + msg.slice(0, 120);
        return json({ choices: [{ message: { content: friendly } }] });
      }
    }

    return env.ASSETS ? env.ASSETS.fetch(req) : new Response("ok");
  },
};
