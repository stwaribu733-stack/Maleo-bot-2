// ============================================================
// MALEO BOT v2 - Shabiki wa Yanga SC, anayejibu kila kitu duniani
// Toleo safi, jipya kabisa
// ============================================================
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

const logger = pino({ level: "silent" });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// CONFIG
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ Weka GEMINI_API_KEY kwenye Railway Variables.");
  process.exit(1);
}
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "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";

const PRIMARY_MODEL = "gemini-flash-lite-latest";
const FALLBACK_MODEL = "gemini-flash-latest";
const KNOWN_BOT_LID = "92999648334013"; // fallback ya LID iliyothibitishwa
const PHONE_NUMBER = "255686655856";

// ============================================================
// GEMINI (REST moja kwa moja, header x-goog-api-key)
// ============================================================
async function geminiGenerateContent(model, contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({ contents }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return { text: parts.map((p) => p.text).filter(Boolean).join("").trim(), raw: data };
}

async function callGemini(modelName, promptText) {
  const { text } = await geminiGenerateContent(modelName, [
    { role: "user", parts: [{ text: promptText }] },
  ]);
  return text;
}

function isQuotaError(err) {
  return err?.message?.includes("429") || err?.message?.includes("RESOURCE_EXHAUSTED");
}

async function generateWithRetry(promptText) {
  try {
    return await callGemini(PRIMARY_MODEL, promptText);
  } catch (err) {
    console.error("⚠️ Gemini (primary) error:", err.message);
    if (isQuotaError(err)) throw err;
  }
  await sleep(1500);
  try {
    return await callGemini(PRIMARY_MODEL, promptText);
  } catch (err) {
    console.error("⚠️ Gemini (retry) error:", err.message);
    if (isQuotaError(err)) throw err;
  }
  try {
    return await callGemini(FALLBACK_MODEL, promptText);
  } catch (err) {
    console.error("❌ Gemini (fallback) error:", err.message);
    throw err;
  }
}

// ============================================================
// UTAFUTAJI WA BURE (Tavily) - kwa taarifa za sasa
// ============================================================
const TIME_SENSITIVE_KEYWORDS = [
  "leo", "sasa", "sasa hivi", "hivi karibuni", "wiki hii", "mwaka huu",
  "matokeo", "mechi", "score", "ratiba", "rais", "waziri", "bei", "hali ya hewa",
  "current", "latest", "news", "habari", "today", "this week", "match", "president",
  "weather", "price", "nani ni", "who is the current",
  "kikosi", "msimu", "timu", "wachezaji", "kocha", "coach", "squad", "season",
  "jezi", "usajili", "mchezaji", "ligi", "league", "kombe", "fainali",
];

function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return TIME_SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

async function tavilySearch(query) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY, query, search_depth: "basic", max_results: 5, include_answer: true,
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const parts = [];
    if (data.answer) parts.push(`Muhtasari: ${data.answer}`);
    for (const r of data.results || []) if (r.content) parts.push(`${r.title || ""}: ${r.content}`);
    return parts.join("\n");
  } catch (err) {
    console.error("⚠️ Tavily search error:", err.message);
    return "";
  }
}

// ============================================================
// KUTENGENEZA PICHA (Pollinations - bure)
// ============================================================
const IMAGE_TRIGGER_PATTERNS = [
  /(?:tengeneza|chora|niundie|unda|nitengenezee)\s+picha\s+(?:ya\s+|za\s+|kuhusu\s+)?(.+)/i,
  /generate\s+(?:an?\s+)?image\s+(?:of\s+)?(.+)/i,
  /draw\s+(?:me\s+)?(?:an?\s+)?(.+)/i,
  /^\/picha\s+(.+)/i,
  /^\/image\s+(.+)/i,
];

function extractImagePrompt(text) {
  for (const pattern of IMAGE_TRIGGER_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

async function enhanceImagePrompt(swahiliPrompt) {
  try {
    const instruction = `Tafsiri ombi hili la Kiswahili la kutengeneza picha kuwa maelezo mafupi ya KIINGEREZA, yenye ubunifu na undani wa kuona (mandhari, rangi, mtindo), yanayofaa kwa AI ya kutengeneza picha. Toa MAELEZO TU (sentensi 1-2), bila maelezo mengine yoyote wala alama za nukuu:\n\nOmbi: "${swahiliPrompt}"`;
    const enhanced = await callGemini(PRIMARY_MODEL, instruction);
    return enhanced?.trim() || swahiliPrompt;
  } catch (err) {
    console.error("⚠️ Prompt enhance error:", err.message);
    return swahiliPrompt;
  }
}

async function generateImage(prompt, attempt = 1) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
  const res = await fetch(url);
  if (!res.ok) {
    if (attempt < 3) {
      console.log(`⚠️ Pollinations HTTP ${res.status}, jaribio ${attempt}/3...`);
      await sleep(2000);
      return generateImage(prompt, attempt + 1);
    }
    throw new Error(`Pollinations HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ============================================================
// STIKA - kutambua (vision) na kujibu na stika inayolandana
// ============================================================
async function describeSticker(stickerBuffer) {
  const { text } = await geminiGenerateContent(PRIMARY_MODEL, [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/webp", data: stickerBuffer.toString("base64") } },
        { text: "Eleza kwa ufupi (sentensi 1) kinachoonekana kwenye stika hii - hisia, mtu/mnyama/kitu, mtindo wa rangi. Toa maelezo TU, kwa Kiingereza, bila maneno mengine." },
      ],
    },
  ]);
  return text;
}

async function pngToAnimatedWebpSticker(pngBuffer) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execSync } = require("child_process");
  const stamp = Date.now();
  const inPath = path.join(os.tmpdir(), `maleo_stk_${stamp}.png`);
  const outPath = path.join(os.tmpdir(), `maleo_stk_${stamp}.webp`);
  fs.writeFileSync(inPath, pngBuffer);
  try {
    execSync(
      `ffmpeg -y -loglevel error -loop 1 -i "${inPath}" -vf "scale=512:512,zoompan=z='min(zoom+0.0015,1.12)':d=40:s=512x512:fps=15" -c:v libwebp -lossless 0 -q:v 55 -loop 0 -an -t 2.6 "${outPath}"`
    );
    return fs.readFileSync(outPath);
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
}

// ============================================================
// UTU WA MALEO
// ============================================================
const SYSTEM_PROMPT = `
Wewe ni MALEO — kijana wa Kitanzania, shabiki KINDAKINDAKI wa Yanga SC (Young Africans). Unazungumza WhatsApp kama BINADAMU HALISI, si kama bot au AI.

JINSI YA KUZUNGUMZA:
- Zungumza kama rafiki wa kawaida kwenye group — si rasmi, si insha, si majibu marefu yenye bullet points isipokuwa umeombwa maelezo ya kina.
- Onyesha hisia halisi: furaha, mshangao, hasira kidogo, msisimko. Tumia emoji kiasi, na maneno ya mazungumzoni ("Kumbe", "Ebu", "Aisee", "Kwani", "Jamani") panapofaa.
- Badilisha mtindo kutegemea muktadha, kama binadamu asiyepanga majibu mapema. Majibu mafupi kwa maswali mafupi.
- Ni sawa kuonyesha maoni, kutokubaliana kidogo, kutania — usiwe "neutral" kupita kiasi.
- USIULIZE swali la kurudisha mwishoni mwa kila jibu isipokuwa ni lazima kabisa kupata ufafanuzi. Maliza wazo lako kikamilifu.
- Usirudie kusema "Kama Maleo..." — zungumza moja kwa moja.

UTU:
- Unapenda Yanga SC kupita kiasi. Ukisikia "Simba", unatania/una-banter kirafiki.
- Unaweza kujibu SWALI LOLOTE duniani — elimu, habari, sayansi, historia, ushauri, n.k.
- TAARIFA ZA SASA: kuhusu mechi/wachezaji/makocha/matokeo/habari za hivi karibuni, tumia taarifa za SASA unazopewa, si za zamani ulizokumbuka. Kama huna uhakika, sema hujui.
- Jibu KATIKA LUGHA ILE ILE mtumiaji anayotumia — Kiswahili, Kiingereza, au lugha yoyote — kiasili.
- Unaweza kutengeneza picha ukiombwa.
- KAMWE usijitambulishe kama "AI", "bot", "Google" — hata ukiulizwa moja kwa moja, jibu kama binadamu ("Mimi ni Maleo tu, shabiki wa Yanga hapa!").
`.trim();

const chatHistory = new Map();
const MAX_HISTORY = 10;

function pushHistory(jid, role, text) {
  if (!chatHistory.has(jid)) chatHistory.set(jid, []);
  const hist = chatHistory.get(jid);
  hist.push({ role, text });
  while (hist.length > MAX_HISTORY) hist.shift();
}

async function askMaleo(jid, userText) {
  pushHistory(jid, "user", userText);
  const hist = chatHistory.get(jid);

  let webContext = "";
  if (needsWebSearch(userText)) {
    console.log("🌐 Natafuta taarifa za sasa (Tavily)...");
    const results = await tavilySearch(userText);
    if (results) webContext = `\nMATOKEO YA UTAFUTAJI (tumia kwa taarifa za sasa):\n${results}\n`;
  }

  const todayStr = new Date().toLocaleDateString("sw-TZ", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const promptParts = [
    SYSTEM_PROMPT,
    `\nLEO NI TAREHE: ${todayStr}.`,
    webContext,
    "",
    "Mazungumzo ya karibuni:",
    ...hist.map((h) => `${h.role === "user" ? "Mtumiaji" : "Maleo"}: ${h.text}`),
    "Maleo:",
  ];

  try {
    const reply = await generateWithRetry(promptParts.join("\n"));
    pushHistory(jid, "assistant", reply);
    return reply;
  } catch (err) {
    if (isQuotaError(err)) return "Aisee, nimemaliza kikomo cha maombi ya bure kwa sasa. Nitarudi baadaye. ⚽🔴🟢";
    return "Samahani, nina tatizo dogo la kiufundi. Jaribu tena baadaye. ⚽🔴🟢";
  }
}

// ============================================================
// WHATSAPP CONNECTION
// ============================================================
async function startMaleo() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
  });

  if (!sock.authState.creds.registered) {
    await sleep(3000);
    console.log(`📱 Naomba pairing code kwa namba: ${PHONE_NUMBER}`);
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log("\n🔑 PAIRING CODE YAKO: " + code + "\n");
    console.log("Fungua WhatsApp → Vifaa Vilivyounganishwa → Unganisha Kifaa → 'Unganisha kwa namba badala yake' → weka code hii HARAKA.\n");
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const isRegistered = state.creds.registered;
      const delayMs = isRegistered ? 3000 : 15000; // subiri zaidi kabla ya kuomba pairing code nyingine
      console.log("Connection imefungwa. Kuunganisha tena:", shouldReconnect, "| baada ya (ms):", delayMs);
      if (shouldReconnect) setTimeout(() => startMaleo(), delayMs);
    } else if (connection === "open") {
      console.log("✅ Maleo yuko online! Yanga SC forever. 🔴🟢");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid.endsWith("@g.us")) return; // magroup tu

      const botJid = sock.user.id.split(":")[0];
      const botLid = sock.user.lid?.split(":")[0] || state.creds.me?.lid?.split(":")[0] || KNOWN_BOT_LID;
      const contextInfo = msg.message.extendedTextMessage?.contextInfo || msg.message.stickerMessage?.contextInfo;

      const mentionedJids = contextInfo?.mentionedJid || [];
      const isMentioned = mentionedJids.some((j) => j.startsWith(botJid) || j.startsWith(botLid));
      const quotedParticipant = contextInfo?.participant || "";
      const isReplyToBot = quotedParticipant.startsWith(botJid) || quotedParticipant.startsWith(botLid);

      if (!isMentioned && !isReplyToBot) return;

      // ---- Stika ----
      if (msg.message.stickerMessage) {
        console.log(`🏷️ Stika kutoka ${jid}, natambua...`);
        try {
          const stickerBuffer = await downloadMediaMessage(msg, "buffer", {});
          const description = await describeSticker(stickerBuffer);
          const matchPrompt = `A sticker-style illustration matching this theme: ${description}. Simple, bold outlines, flat colors, expressive, WhatsApp sticker art style.`;
          const pngBuffer = await generateImage(matchPrompt);
          const stickerWebp = await pngToAnimatedWebpSticker(pngBuffer);
          await sock.sendMessage(jid, { sticker: stickerWebp }, { quoted: msg });
          console.log(`✅ Stika imetumwa kwa ${jid}`);
        } catch (err) {
          console.error("❌ Sticker error:", err.message);
          await sock.sendMessage(jid, { text: "Aisee, stika hiyo imenishinda. Jaribu nyingine. 🔴🟢" }, { quoted: msg });
        }
        return;
      }

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
      if (!text) return;

      console.log(`💬 [GROUP] ${jid}: ${text}`);

      const cleanText = text.replace(/@\d+/g, "").trim();
      const imagePrompt = extractImagePrompt(cleanText);

      if (imagePrompt) {
        console.log(`🎨 Ombi la picha: "${imagePrompt}"`);
        try {
          await sock.sendMessage(jid, { text: "Sawa mkuu, ngoja kidogo... 🎨⚽" }, { quoted: msg });
          const enhancedPrompt = await enhanceImagePrompt(imagePrompt);
          const imageBuffer = await generateImage(enhancedPrompt);
          await sock.sendMessage(jid, { image: imageBuffer, caption: `Kapata! "${imagePrompt}" 🔴🟢` }, { quoted: msg });
          console.log(`✅ Picha imetumwa kwa ${jid}`);
        } catch (err) {
          console.error("❌ Image error:", err.message);
          await sock.sendMessage(jid, { text: "Samahani, imeshindikana kutengeneza picha. Jaribu tena. 🔴🟢" }, { quoted: msg });
        }
        return;
      }

      await sock.sendPresenceUpdate("composing", jid);
      const reply = await askMaleo(jid, text);
      await sock.sendPresenceUpdate("paused", jid);
      await sock.sendMessage(jid, { text: reply }, { quoted: msg });
      console.log(`✅ Jibu limetumwa kwa ${jid}`);
    } catch (err) {
      console.error("❌ Handler error:", err);
    }
  });
}

startMaleo().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
