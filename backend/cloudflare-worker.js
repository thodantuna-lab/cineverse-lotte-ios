/**
 * Cloudflare Worker: Tự động liệt kê toàn bộ video (.mp4, .webm, .mov, .mkv)
 * trong R2 Bucket để web CineVerse Lotte tự cập nhật khi có video mới.
 *
 * Cách cài đặt trên Cloudflare Dashboard:
 * 1. Vào Workers & Pages -> Create -> Create Worker -> dán toàn bộ code này vào -> Deploy.
 * 2. Vào Settings -> Bindings -> Add -> R2 bucket:
 *    - Variable name: MY_BUCKET
 *    - R2 bucket: chọn bucket chứa video của bạn
 * 3. (Để bật AI Gemini thật cho AI Phim, Đố Vui & Vote Phim):
 *    Vào Settings -> Variables and Secrets -> Add:
 *    - Type: Secret
 *    - Name: GEMINI_API_KEY
 *    - Value: dán API Key tạo từ https://aistudio.google.com/apikey
 * 4. Save and deploy -> copy URL dạng https://xxxx.workers.dev
 */

const R2_PUBLIC_BASE = "https://pub-c634cb0eca714151876c408aa346c6b5.r2.dev";
const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), payment=()"
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  ...SECURITY_HEADERS
};

function getCorsHeaders(request, env) {
  const allowedRaw = String(env?.ALLOWED_ORIGINS || "").trim();
  if (!allowedRaw) return CORS_HEADERS;
  const origin = String(request?.headers?.get("Origin") || "").trim();
  const allowList = allowedRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const matched = allowList.includes(origin) ? origin : allowList[0];
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": matched,
    "Vary": "Origin"
  };
}

// Edge in-memory rate limiters & caches (per isolate)
const RATE_BUCKETS = new Map();
const ADMIN_FAIL_BUCKETS = new Map();
let R2_CATALOG_CACHE = { ts: 0, data: null };

function getClientIp(request) {
  return (
    request?.headers?.get("CF-Connecting-IP") ||
    String(request?.headers?.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function checkRateLimit(ip, bucketName, maxReq, windowMs) {
  const now = Date.now();
  if (RATE_BUCKETS.size > 2000) {
    for (const [k, v] of RATE_BUCKETS) {
      if (now - v.start > v.windowMs) RATE_BUCKETS.delete(k);
    }
  }
  const key = `${bucketName}:${ip}`;
  const entry = RATE_BUCKETS.get(key);
  if (!entry || now - entry.start > windowMs) {
    RATE_BUCKETS.set(key, { count: 1, start: now, windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  entry.count += 1;
  if (entry.count > maxReq) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function checkAdminBan(ip) {
  const now = Date.now();
  if (ADMIN_FAIL_BUCKETS.size > 1000) {
    for (const [k, v] of ADMIN_FAIL_BUCKETS) {
      if (now > v.until) ADMIN_FAIL_BUCKETS.delete(k);
    }
  }
  const rec = ADMIN_FAIL_BUCKETS.get(ip);
  if (rec && rec.count >= 5 && now < rec.until) {
    return { banned: true, retryAfterSec: Math.max(1, Math.ceil((rec.until - now) / 1000)) };
  }
  if (rec && now >= rec.until) ADMIN_FAIL_BUCKETS.delete(ip);
  return { banned: false, retryAfterSec: 0 };
}

function recordAdminFail(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const rec = ADMIN_FAIL_BUCKETS.get(ip);
  if (!rec || now >= rec.until) {
    ADMIN_FAIL_BUCKETS.set(ip, { count: 1, until: now + windowMs });
  } else {
    rec.count += 1;
    if (rec.count >= 5) rec.until = now + windowMs;
  }
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [d1, d2] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b || "")))
  ]);
  const u1 = new Uint8Array(d1);
  const u2 = new Uint8Array(d2);
  let diff = 0;
  for (let i = 0; i < u1.length; i++) diff |= u1[i] ^ u2[i];
  return diff === 0;
}

function base64UrlEncode(bytesOrStr) {
  const bytes = typeof bytesOrStr === "string"
    ? new TextEncoder().encode(bytesOrStr)
    : new Uint8Array(bytesOrStr);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signLiveKitJwt(apiKey, apiSecret, { room, identity, name, ttlSeconds = 21600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: apiKey,
    sub: identity,
    name: name || identity,
    nbf: now - 10,
    exp: now + ttlSeconds,
    video: {
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    }
  }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function handleLiveKitTokenRequest(request, env) {
  const livekitUrl = String(env.LIVEKIT_URL || "").trim();
  const apiKey = String(env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(env.LIVEKIT_API_SECRET || "").trim();
  if (!livekitUrl || !apiKey || !apiSecret) {
    return jsonResponse({ ok: false, error: "MISSING_LIVEKIT_SECRETS" }, 200);
  }
  try {
    const body = request.method === "POST" ? await request.json() : {};
    const url = new URL(request.url);
    const room = String(body?.roomId || url.searchParams.get("roomId") || "").trim();
    const identity = String(body?.uid || url.searchParams.get("uid") || "").trim();
    const name = String(body?.name || url.searchParams.get("name") || identity).trim();
    if (!room || !identity) {
      return jsonResponse({ ok: false, error: "MISSING_ROOM_OR_UID" }, 200);
    }
    const token = await signLiveKitJwt(apiKey, apiSecret, { room, identity, name });
    return jsonResponse({ ok: true, url: livekitUrl, token }, 200);
  } catch (e) {
    return jsonResponse({ ok: false, error: e?.message || "LIVEKIT_TOKEN_ERROR" }, 200);
  }
}

async function getRoomSealKey(env) {
  const secret = String(env.ADMIN_PIN || "2026").trim() + "::cineverse-room-seal-v1";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealRoomPin(env, roomId, pin) {
  const key = await getRoomSealKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ roomId, pin }));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return base64UrlEncode(combined);
}

async function unsealRoomPin(env, sealed, expectedRoomId) {
  const b64 = String(sealed || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  const key = await getRoomSealKey(env);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (expectedRoomId && parsed.roomId !== expectedRoomId) return null;
  return String(parsed.pin || "");
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

async function handleTranslateSrtRequest(request, env) {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ ok: false, error: "MISSING_GEMINI_KEY" }, 200);
  }
  try {
    const body = await request.json();
    const movieTitle = String(body?.movieTitle || "Phim điện ảnh").trim();
    const lines = Array.isArray(body?.lines) ? body.lines.map(s => String(s || "")) : [];
    const contextPrev = Array.isArray(body?.contextPrev) ? body.contextPrev.map(s => String(s || "")) : [];

    if (!lines.length) {
      return jsonResponse({ ok: true, translations: [] }, 200);
    }

    const numberedLines = lines.map((txt, idx) => `${idx}: ${txt.replace(/\r?\n/g, " ").trim()}`).join("\n");
    const ctxBlock = contextPrev.length
      ? `\nNgữ cảnh vài câu ngay trước đó (KHÔNG dịch lại phần này, chỉ dùng để giữ mạch xưng hô):\n${contextPrev.join("\n")}\n`
      : "";

    const prompt = `Bạn là biên dịch viên phụ đề phim chuyên nghiệp cho rạp CineVerse Lotte.
Hãy dịch các câu thoại tiếng Anh sau của bộ phim "${movieTitle}" sang Tiếng Việt thật TỰ NHIÊN, mượt mà như văn nói điện ảnh (không dịch word-by-word kiểu máy móc).
Quy tắc bắt buộc:
1. Đọc cả mạch hội thoại để chọn đại từ xưng hô hợp lý & nhất quán (anh/em, tôi/anh, tao/mày, bố/con, cậu/tớ, ngài/tôi...).
2. Dịch thoát ý, tự nhiên, đúng cảm xúc nhân vật; giữ nguyên tên riêng nhân vật/địa danh (ví dụ Stark, Rancho, Thanos...).
3. Trả về ĐÚNG 1 mảng JSON gồm ĐÚNG ${lines.length} chuỗi (string) tương ứng lần lượt từng câu 0..${lines.length - 1}, KHÔNG gộp câu, KHÔNG bỏ sót câu nào.${ctxBlock}
Danh sách ${lines.length} câu cần dịch:
${numberedLines}`;

    const modelsToTry = ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
    let rawText = "";
    let lastError = "EMPTY_RESPONSE";

    for (const modelName of modelsToTry) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
      try {
        const gemRes = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.4
            }
          })
        });
        const gemData = await gemRes.json();
        rawText = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (rawText) break;
        lastError = gemData?.error?.message || lastError;
      } catch (e) {
        lastError = e?.message || lastError;
      }
    }

    if (!rawText) {
      return jsonResponse({ ok: false, error: lastError }, 200);
    }

    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed) || parsed.length !== lines.length) {
      return jsonResponse({ ok: false, error: "LENGTH_MISMATCH" }, 200);
    }
    return jsonResponse({ ok: true, translations: parsed.map(x => String(x || "").trim()) }, 200);
  } catch (err) {
    return jsonResponse({ ok: false, error: err?.message || "TRANSLATE_ERROR" }, 200);
  }
}

async function handleAIRequest(request, env) {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ ok: false, error: "MISSING_GEMINI_KEY" }, 200);
  }
  try {
    const body = await request.json();
    const mode = body.mode || "chat";
    const movieTitle = body.movieTitle || "Phim đang chiếu";
    const genre = body.genre || "";
    const synopsis = body.synopsis || "";
    const cast = body.cast || "";
    const question = body.question || "";
    const availableTitles = Array.isArray(body.availableTitles) ? body.availableTitles : [];

    let prompt = "";
    let wantJson = false;
    if (mode === "trivia") {
      wantJson = true;
      prompt = `Hãy tạo 4 câu hỏi trắc nghiệm đố vui thú vị bằng tiếng Việt về bộ phim "${movieTitle}" (Thể loại: ${genre}, Diễn viên: ${cast}, Tóm tắt: ${synopsis}). Trả về đúng JSON mảng gồm 4 phần tử theo mẫu: [{"q":"câu hỏi","options":["A","B","C","D"],"answer":0}] với answer là chỉ số 0..3 của đáp án đúng.`;
    } else if (mode === "recommend") {
      wantJson = true;
      prompt = `Khán giả vừa xem "${movieTitle}" (${genre}). Trong danh sách video sẵn có sau: ${JSON.stringify(availableTitles.slice(0, 30))}, hãy chọn ra 3-4 video phù hợp nhất để đề xuất xem tiếp (nếu là phim bộ hãy ưu tiên tập tiếp theo). Trả về đúng JSON mảng gồm các object: [{"title":"tên chính xác trong danh sách","reason":"lý do ngắn gọn bằng tiếng Việt"}].`;
    } else {
      prompt = `Bạn là Trợ lý Điện ảnh thông minh trong rạp CineVerse Lotte. Phim đang chiếu là "${movieTitle}" (Thể loại: ${genre}, Diễn viên: ${cast}, Tóm tắt: ${synopsis}). Hãy trả lời câu hỏi sau của khán giả bằng tiếng Việt ngắn gọn, tự nhiên và chính xác (2-5 câu): ${question}`;
    }

    const baseGenConfig = wantJson
      ? { responseMimeType: "application/json", temperature: 0.8 }
      : { temperature: 0.7 };

    const modelsToTry = ["gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
    let rawText = "";
    let lastError = "EMPTY_RESPONSE";

    for (const modelName of modelsToTry) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
      try {
        const gemRes = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: baseGenConfig
          })
        });
        const gemData = await gemRes.json();
        rawText = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (rawText) break;
        lastError = gemData?.error?.message || lastError;
      } catch (e) {
        lastError = e?.message || lastError;
      }
    }
    if (!rawText) {
      return jsonResponse({ ok: false, error: lastError }, 200);
    }

    if (wantJson) {
      const parsed = JSON.parse(rawText);
      return jsonResponse({ ok: true, mode, items: parsed }, 200);
    }
    return jsonResponse({ ok: true, mode, reply: rawText.trim() }, 200);
  } catch (err) {
    return jsonResponse({ ok: false, error: err?.message || "AI_ERROR" }, 200);
  }
}

async function extractCleanMovieMetaWithAI(rawTitle, env) {
  const fallback = {
    query: String(rawTitle || "")
      .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
      .replace(/(vietsub|thuyết minh|lồng tiếng|full hd|1080p|720p|4k|webrip|bluray|motchill|motphim|8phimx|ani-one|tập\s*\d+)/gi, " ")
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    type: /tập\s*\d+|season|s\d+|anime|phần\s*\d+/i.test(rawTitle || "") ? "tv" : "movie",
    year: ""
  };
  if (!env.GEMINI_API_KEY || !rawTitle) return fallback;
  try {
    const prompt = `Từ tên file phim sau: "${rawTitle}". Hãy trích xuất tên phim/anime gốc chuẩn quốc tế (tiếng Anh hoặc tên chính thức để tìm poster), loại ("movie" hoặc "tv" hoặc "anime"), và năm phát hành nếu có. Trả về đúng JSON: {"query":"...","type":"movie","year":""}`;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
      })
    });
    const data = await res.json();
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (txt) {
      const parsed = JSON.parse(txt);
      if (parsed && parsed.query) {
        return {
          query: String(parsed.query).trim(),
          type: String(parsed.type || fallback.type),
          year: String(parsed.year || "")
        };
      }
    }
  } catch (e) {}
  return fallback;
}

async function handlePosterLookup(request, env) {
  const url = new URL(request.url);
  const rawTitle = (url.searchParams.get("title") || "").trim();
  if (!rawTitle) return jsonResponse({ ok: false, error: "MISSING_TITLE" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const meta = await extractCleanMovieMetaWithAI(rawTitle, env);
  const q = meta.query || rawTitle;
  let posterUrl = "";
  let source = "";

  // 1. TMDB (nếu có TMDB_API_KEY)
  if (!posterUrl && env.TMDB_API_KEY) {
    try {
      const tmdbRes = await fetch(
        `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&query=${encodeURIComponent(q)}&language=vi-VN`,
        { signal: AbortSignal.timeout(6000) }
      );
      const tmdbData = await tmdbRes.json();
      const hit = (tmdbData.results || []).find(r => r.poster_path);
      if (hit?.poster_path) {
        posterUrl = `https://image.tmdb.org/t/p/w780${hit.poster_path}`;
        source = "tmdb";
      }
    } catch (e) {}
  }

  // 2. IMDb Suggestion API (Miễn phí, không cần key, poster chuẩn cho hầu hết phim lẻ/series)
  if (!posterUrl) {
    try {
      const imdbSlug = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const firstChar = /^[a-z0-9]/.test(imdbSlug) ? imdbSlug[0] : "x";
      const imdbRes = await fetch(
        `https://v3.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(imdbSlug)}.json`,
        {
          headers: { "User-Agent": "CineVerseLotte/1.0" },
          signal: AbortSignal.timeout(6000)
        }
      );
      const imdbData = await imdbRes.json();
      const hit = (imdbData.d || []).find(item => item?.i?.imageUrl && (!item.qid || /movie|tvSeries|tvMiniSeries/i.test(item.qid)));
      if (hit?.i?.imageUrl) {
        posterUrl = hit.i.imageUrl.replace(/\._V1_\./i, "._V1_UX600_.");
        source = "imdb";
      }
    } catch (e) {}
  }

  // 3. Jikan (MyAnimeList) cho Anime
  if (!posterUrl && (meta.type === "anime" || /chú thuật|jujutsu|anime|tập/i.test(rawTitle))) {
    try {
      const jikanRes = await fetch(
        `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=1`,
        { headers: { "User-Agent": "CineVerseLotte/1.0" }, signal: AbortSignal.timeout(6000) }
      );
      const jikanData = await jikanRes.json();
      const img = jikanData?.data?.[0]?.images?.jpg?.large_image_url || jikanData?.data?.[0]?.images?.jpg?.image_url;
      if (img) {
        posterUrl = img;
        source = "jikan";
      }
    } catch (e) {}
  }

  // 4. iTunes Search API (Miễn phí, không cần API key, poster phim lẻ HD)
  if (!posterUrl) {
    try {
      const itunesRes = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=movie&country=US&limit=1`,
        { headers: { "User-Agent": "CineVerseLotte/1.0" }, signal: AbortSignal.timeout(6000) }
      );
      const itunesData = await itunesRes.json();
      const art = itunesData?.results?.[0]?.artworkUrl100;
      if (art) {
        posterUrl = art.replace(/100x100bb\./i, "600x600bb.");
        source = "itunes";
      }
    } catch (e) {}
  }

  // 4. TVMaze API (Miễn phí, không cần API key, cho phim bộ/series)
  if (!posterUrl) {
    try {
      const tvRes = await fetch(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(6000) }
      );
      const tvData = await tvRes.json();
      const img = tvData?.[0]?.show?.image?.original || tvData?.[0]?.show?.image?.medium;
      if (img) {
        posterUrl = img;
        source = "tvmaze";
      }
    } catch (e) {}
  }

  const response = new Response(
    JSON.stringify({ ok: Boolean(posterUrl), query: q, poster: posterUrl, source }),
    {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": posterUrl ? "public, max-age=604800" : "no-store",
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
  if (posterUrl) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

async function handleWorkerFetch(request, env, corsHdrs) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHdrs });
    }

    const clientIp = getClientIp(request);
    const contentLen = Number(request.headers.get("content-length") || 0);
    if (contentLen > 65536) {
      return new Response(
        JSON.stringify({ ok: false, error: "PAYLOAD_TOO_LARGE", maxBytes: 65536 }),
        { status: 413, headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    const globalRl = checkRateLimit(clientIp, "global", 120, 60000);
    if (!globalRl.allowed) {
      return new Response(
        JSON.stringify({ ok: false, error: "RATE_LIMIT_EXCEEDED", retryAfterSec: globalRl.retryAfterSec }),
        {
          status: 429,
          headers: { ...corsHdrs, "Retry-After": String(globalRl.retryAfterSec), "Content-Type": "application/json; charset=utf-8" }
        }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && (path.endsWith("/ai") || path.endsWith("/translate-srt"))) {
      const aiRl = checkRateLimit(clientIp, "ai", 20, 60000);
      if (!aiRl.allowed) {
        return new Response(
          JSON.stringify({ ok: false, error: "AI_RATE_LIMIT_EXCEEDED", retryAfterSec: aiRl.retryAfterSec }),
          {
            status: 429,
            headers: { ...corsHdrs, "Retry-After": String(aiRl.retryAfterSec), "Content-Type": "application/json; charset=utf-8" }
          }
        );
      }
    }

    if (request.method === "POST" && (path === "/auth/send-otp" || path === "/booking/send-host-key" || path.endsWith("/notify-admin-booking"))) {
      const mailRl = checkRateLimit(clientIp, "mail", 6, 600000);
      if (!mailRl.allowed) {
        return new Response(
          JSON.stringify({ ok: false, error: "EMAIL_RATE_LIMIT_EXCEEDED", retryAfterSec: mailRl.retryAfterSec }),
          {
            status: 429,
            headers: { ...corsHdrs, "Retry-After": String(mailRl.retryAfterSec), "Content-Type": "application/json; charset=utf-8" }
          }
        );
      }
    }
    if (request.method === "GET" && url.pathname.endsWith("/sub")) {
      const srtUrl = (url.searchParams.get("url") || "").trim();
      let objectKey = (url.searchParams.get("key") || "").trim();
      if (!objectKey && srtUrl.startsWith(R2_PUBLIC_BASE + "/")) {
        try {
          objectKey = decodeURIComponent(srtUrl.slice(R2_PUBLIC_BASE.length + 1).split("?")[0]);
        } catch (e) {}
      }
      if (env.MY_BUCKET && objectKey) {
        try {
          const obj = await env.MY_BUCKET.get(objectKey);
          if (obj) {
            return new Response(await obj.arrayBuffer(), {
              status: 200,
              headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
            });
          }
        } catch (e) {}
      }
      if (srtUrl.startsWith(R2_PUBLIC_BASE + "/")) {
        try {
          const upstream = await fetch(srtUrl, { signal: AbortSignal.timeout(8000) });
          if (upstream.ok) {
            return new Response(await upstream.arrayBuffer(), {
              status: 200,
              headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" }
            });
          }
        } catch (e) {}
      }
      return new Response("Subtitle not found", { status: 404, headers: CORS_HEADERS });
    }
    if (request.method === "GET" && url.pathname.endsWith("/poster")) {
      return handlePosterLookup(request, env);
    }
    if (request.method === "GET" && url.pathname.endsWith("/turn")) {
      // 1. Cloudflare Realtime TURN (Miễn phí 1.000 GB/tháng trong Cloudflare Dashboard -> Calls / Realtime -> TURN)
      if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
        try {
          const cfRes = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.CF_TURN_API_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ ttl: 86400 }),
              signal: AbortSignal.timeout(6000)
            }
          );
          const cfData = await cfRes.json();
          if (cfData?.iceServers) {
            const list = Array.isArray(cfData.iceServers) ? cfData.iceServers : [cfData.iceServers];
            return jsonResponse({ ok: true, provider: "cloudflare", iceServers: list }, 200);
          }
          return jsonResponse({ ok: false, error: "CF_TURN_API_ERROR", status: cfRes.status, detail: cfData }, 200);
        } catch (e) {
          return jsonResponse({ ok: false, error: e?.message || "CF_TURN_FETCH_ERROR" }, 200);
        }
      }
      // 2. Metered TURN (nếu cấu hình METERED_SUBDOMAIN + METERED_API_KEY)
      if (env.METERED_SUBDOMAIN && env.METERED_API_KEY) {
        try {
          const mRes = await fetch(
            `https://${encodeURIComponent(env.METERED_SUBDOMAIN)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`,
            { signal: AbortSignal.timeout(6000) }
          );
          const mData = await mRes.json();
          if (Array.isArray(mData) && mData.length > 0) {
            return jsonResponse({ ok: true, provider: "metered", iceServers: mData }, 200);
          }
        } catch (e) {}
      }
      return jsonResponse({ ok: false, error: "NO_TURN_CONFIGURED", iceServers: [] }, 200);
    }
    if (request.method === "GET" && url.pathname.endsWith("/ai-models")) {
      if (!env.GEMINI_API_KEY) return jsonResponse({ ok: false, error: "MISSING_GEMINI_KEY" }, 200);
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
          signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        const names = (data.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map(m => m.name);
        return jsonResponse({ ok: true, count: names.length, models: names }, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: e?.message || "ERR" }, 200);
      }
    }
    if (request.method === "POST" && url.pathname.endsWith("/ai")) {
      return handleAIRequest(request, env);
    }
    if (request.method === "POST" && url.pathname.endsWith("/translate-srt")) {
      return handleTranslateSrtRequest(request, env);
    }
    if ((request.method === "POST" || request.method === "GET") && url.pathname.endsWith("/livekit-token")) {
      return handleLiveKitTokenRequest(request, env);
    }
    if (request.method === "POST" && url.pathname.endsWith("/admin-verify")) {
      const ban = checkAdminBan(clientIp);
      if (ban.banned) {
        return jsonResponse({ ok: false, error: "TOO_MANY_FAILED_ATTEMPTS", retryAfterSec: ban.retryAfterSec }, 429);
      }
      try {
        const body = await request.json();
        const pin = String(body?.pin || "").trim();
        const expected = String(env.ADMIN_PIN || "2026").trim();
        const valid = Boolean(pin && (await constantTimeEqual(pin, expected)));
        if (!valid) recordAdminFail(clientIp);
        else ADMIN_FAIL_BUCKETS.delete(clientIp);
        return jsonResponse({ ok: valid, usingSecret: Boolean(env.ADMIN_PIN) }, 200);
      } catch (e) {
        recordAdminFail(clientIp);
        return jsonResponse({ ok: false }, 200);
      }
    }
    if (request.method === "POST" && url.pathname.endsWith("/room-lock-seal")) {
      try {
        const body = await request.json();
        const roomId = String(body?.roomId || "").trim();
        const pin = String(body?.pin || "").trim();
        if (!roomId || !pin) return jsonResponse({ ok: false }, 200);
        const sealed = await sealRoomPin(env, roomId, pin);
        return jsonResponse({ ok: true, sealed }, 200);
      } catch (e) {
        return jsonResponse({ ok: false }, 200);
      }
    }
    if (request.method === "POST" && url.pathname.endsWith("/room-locks-unseal")) {
      const ban = checkAdminBan(clientIp);
      if (ban.banned) {
        return jsonResponse({ ok: false, error: "TOO_MANY_FAILED_ATTEMPTS", retryAfterSec: ban.retryAfterSec }, 429);
      }
      try {
        const body = await request.json();
        const adminPin = String(body?.adminPin || "").trim();
        const expected = String(env.ADMIN_PIN || "2026").trim();
        if (!adminPin || !(await constantTimeEqual(adminPin, expected))) {
          recordAdminFail(clientIp);
          return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 200);
        }
        ADMIN_FAIL_BUCKETS.delete(clientIp);
        const locks = body?.locks && typeof body.locks === "object" ? body.locks : {};
        const pins = {};
        for (const [rId, sealed] of Object.entries(locks)) {
          try {
            const p = await unsealRoomPin(env, sealed, rId);
            if (p) pins[rId] = p;
          } catch (e) {}
        }
        return jsonResponse({ ok: true, pins }, 200);
      } catch (e) {
        return jsonResponse({ ok: false }, 200);
      }
    }

    if (request.method === "POST" && url.pathname.endsWith("/notify-admin-booking")) {
      try {
        const body = await request.json();
        const userName = String(body?.userName || "Khách").slice(0, 60);
        const roomNumber = String(body?.roomNumber || body?.roomId || "Phòng chiếu").slice(0, 40);
        const movieTitle = String(body?.movieTitle || "").slice(0, 120);
        const seatId = String(body?.seatId || "").slice(0, 16);
        const tier = String(body?.tier || "").slice(0, 32);
        const comboName = String(body?.comboName || "Không combo").slice(0, 80);
        const totalAmount = Number(body?.totalAmount) || 0;
        const formattedTotal = new Intl.NumberFormat("vi-VN").format(totalAmount) + "đ";
        const timeStr = new Date(body?.createdAt || Date.now()).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

        const results = { ok: true, channels: [] };

        if (env.RESEND_API_KEY && env.ADMIN_EMAIL) {
          const fromEmail = String(env.RESEND_FROM || "CineVerse Lotte <onboarding@resend.dev>").trim();
          const emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [String(env.ADMIN_EMAIL).trim()],
              subject: `[CineVerse] ${userName} vừa đặt vé ${roomNumber} • Ghế ${seatId} (${formattedTotal})`,
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:20px;background:#111;color:#f8fafc;border-radius:16px;border:1px solid #333;">
                  <h2 style="color:#fbbf24;margin:0 0 12px;">🎟️ Có khách đặt vé mới!</h2>
                  <p style="margin:6px 0;"><strong>Khách hàng:</strong> ${userName}</p>
                  <p style="margin:6px 0;"><strong>Phòng chiếu:</strong> ${roomNumber} ${movieTitle ? `(${movieTitle})` : ""}</p>
                  <p style="margin:6px 0;"><strong>Ghế ngồi:</strong> ${seatId} ${tier ? `(${tier})` : ""}</p>
                  <p style="margin:6px 0;"><strong>Combo:</strong> ${comboName}</p>
                  <p style="margin:10px 0;font-size:18px;color:#34d399;"><strong>Tổng thanh toán: ${formattedTotal}</strong></p>
                  <p style="margin:6px 0;color:#94a3b8;font-size:12px;">Thời gian: ${timeStr}</p>
                </div>
              `
            })
          });
          results.channels.push({ type: "email", status: emailRes.status });
        }

        if (env.ADMIN_WEBHOOK_URL) {
          const hookRes = await fetch(String(env.ADMIN_WEBHOOK_URL).trim(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `🎟️ **Khách mới đặt vé!**\n• Khách: **${userName}**\n• Phòng: **${roomNumber}** (${movieTitle})\n• Ghế: **${seatId}** (${tier})\n• Combo: ${comboName}\n• Tổng tiền: **${formattedTotal}**\n• Lúc: ${timeStr}`
            })
          });
          results.channels.push({ type: "webhook", status: hookRes.status });
        }

        if (results.channels.length === 0) {
          results.skipped = "NO_ADMIN_EMAIL_OR_WEBHOOK_SECRET";
        }
        return jsonResponse(results, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e?.message || e) }, 200);
      }
    }

    // Gmail OTP Auth (stateless HMAC-SHA256 signed token + Resend)
    if (request.method === "POST" && url.pathname === "/auth/send-otp") {
      try {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const displayName = String(body.displayName || "").trim().slice(0, 30);
        if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(email)) {
          return jsonResponse({ ok: false, error: "Vui lòng nhập địa chỉ Gmail hợp lệ (@gmail.com)." }, 400);
        }
        if (!env.RESEND_API_KEY) {
          return jsonResponse({ ok: false, error: "Worker chưa cấu hình RESEND_API_KEY." }, 500);
        }
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        const otp = String(100000 + (arr[0] % 900000));
        const exp = Date.now() + 5 * 60 * 1000;
        const secret = env.OTP_SECRET || env.ADMIN_PIN || env.RESEND_API_KEY || "cineverse-otp-fallback";
        const enc = new TextEncoder();

        const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(`${email}:${otp}:${secret}`));
        const otpHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");

        const payloadJson = JSON.stringify({ email, otpHash, exp });
        const payloadB64 = btoa(unescape(encodeURIComponent(payloadJson)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        const key = await crypto.subtle.importKey(
          "raw",
          enc.encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
        const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        const otpToken = `${payloadB64}.${sigB64}`;

        const mailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: env.RESEND_FROM || "CineVerse Security <onboarding@resend.dev>",
            to: [email],
            subject: `[CineVerse] Mã xác thực đăng nhập: ${otp}`,
            html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#0c0a09;color:#f8fafc;border-radius:16px;border:1px solid #292524">
              <h2 style="margin:0 0 8px;color:#fbbf24">🔐 Xác thực tài khoản CineVerse</h2>
              <p style="font-size:14px;color:#cbd5e1;margin:0 0 16px">Xin chào ${displayName || "bạn"}, mã xác thực 6 số của bạn là:</p>
              <div style="font-size:32px;font-weight:900;letter-spacing:8px;text-align:center;padding:16px;background:#1c1917;border:1px solid #f59e0b;border-radius:12px;color:#fbbf24">${otp}</div>
              <p style="font-size:12px;color:#94a3b8;margin:16px 0 0">Mã có hiệu lực trong <b>5 phút</b>. Nếu bạn không yêu cầu đăng nhập, vui lòng bỏ qua email này.</p>
            </div>`
          })
        });
        const mailJson = await mailRes.json().catch(() => ({}));
        if (!mailRes.ok) {
          return jsonResponse({
            ok: false,
            error: mailJson?.message || `Không thể gửi email (${mailRes.status}).`,
            resendStatus: mailRes.status
          }, 400);
        }
        return jsonResponse({ ok: true, email, otpToken, expiresInSec: 300 }, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/auth/verify-otp") {
      try {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const otp = String(body.otp || "").trim();
        const otpToken = String(body.otpToken || "").trim();
        if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(email) || !/^\d{6}$/.test(otp) || !otpToken.includes(".")) {
          return jsonResponse({ ok: false, error: "Thông tin xác thực không hợp lệ (cần Gmail & mã 6 số)." }, 400);
        }
        const [payloadB64, sigB64] = otpToken.split(".");
        const secret = env.OTP_SECRET || env.ADMIN_PIN || env.RESEND_API_KEY || "cineverse-otp-fallback";
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          enc.encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const expectedSigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
        const expectedSigB64 = btoa(String.fromCharCode(...new Uint8Array(expectedSigBuf)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        if (sigB64 !== expectedSigB64) {
          return jsonResponse({ ok: false, error: "Phiên OTP không hợp lệ hoặc đã bị chỉnh sửa." }, 400);
        }
        const b64Norm = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(decodeURIComponent(escape(atob(b64Norm))));
        if (!payload || payload.email !== email) {
          return jsonResponse({ ok: false, error: "Gmail không khớp với mã OTP đã gửi." }, 400);
        }
        if (Date.now() > Number(payload.exp || 0)) {
          return jsonResponse({ ok: false, error: "Mã OTP đã hết hạn (5 phút). Vui lòng bấm gửi lại mã." }, 400);
        }
        const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(`${email}:${otp}:${secret}`));
        const otpHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
        if (otpHash !== payload.otpHash) {
          return jsonResponse({ ok: false, error: "Mã OTP không đúng. Vui lòng kiểm tra lại Gmail." }, 400);
        }
        const uidBuf = await crypto.subtle.digest("SHA-256", enc.encode(`uid:${email}:${secret}`));
        const verifiedUid = "gm_" + Array.from(new Uint8Array(uidBuf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
        return jsonResponse({ ok: true, email, verifiedUid, verifiedAt: Date.now() }, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    // Tự động kiểm tra chuyển khoản ngân hàng qua SePay API (nếu đã gắn SEPAY_API_TOKEN)
    if (request.method === "POST" && url.pathname === "/payment/check") {
      try {
        const body = await request.json().catch(() => ({}));
        const orderCode = String(body.orderCode || "").trim().toUpperCase();
        const amount = Number(body.amount || 0);
        if (!orderCode || amount <= 0) {
          return jsonResponse({ ok: false, error: "Thiếu mã đơn hoặc số tiền." }, 400);
        }
        if (!env.SEPAY_API_TOKEN) {
          return jsonResponse({ ok: true, paid: false, mode: "admin_realtime" }, 200);
        }
        const sepayRes = await fetch("https://my.sepay.vn/userapi/transactions/list?account_number=99999920072&limit=20", {
          headers: {
            "Authorization": `Bearer ${env.SEPAY_API_TOKEN}`,
            "Content-Type": "application/json"
          }
        });
        const sepayJson = await sepayRes.json().catch(() => ({}));
        const txs = Array.isArray(sepayJson?.transactions) ? sepayJson.transactions : [];
        const matched = txs.find((tx) => {
          const content = String(tx?.transaction_content || "").toUpperCase();
          const inAmt = Number(tx?.amount_in || 0);
          return inAmt >= amount && content.includes(orderCode);
        });
        if (matched) {
          return jsonResponse({ ok: true, paid: true, txId: matched.id, amountIn: matched.amount_in }, 200);
        }
        return jsonResponse({ ok: true, paid: false, mode: "sepay_polling" }, 200);
      } catch (e) {
        return jsonResponse({ ok: true, paid: false, error: String(e?.message || e) }, 200);
      }
    }

    // Gửi Key Chủ Trì về Gmail tài khoản người đặt vé khi chọn Bao Nguyên Rạp
    if (request.method === "POST" && url.pathname === "/booking/send-host-key") {
      try {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const userName = String(body.userName || "Khán giả").trim();
        const roomNumber = String(body.roomNumber || "Phòng chiếu").trim();
        const movieTitle = String(body.movieTitle || "").trim();
        const hostKey = String(body.hostKey || "").trim().toUpperCase();
        const totalAmount = Number(body.totalAmount || 0);
        if (!email || !hostKey) {
          return jsonResponse({ ok: false, error: "Thiếu email hoặc hostKey." }, 400);
        }
        if (!env.RESEND_API_KEY) {
          return jsonResponse({ ok: false, error: "Chưa cấu hình RESEND_API_KEY." }, 500);
        }
        const formattedTotal = totalAmount.toLocaleString("vi-VN") + "đ";
        const mailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: env.RESEND_FROM || "CineVerse Box Office <onboarding@resend.dev>",
            to: [email],
            subject: `[CineVerse] Xác nhận Bao Nguyên Rạp & Key Chủ Trì: ${hostKey}`,
            html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0c0a09;color:#f8fafc;border-radius:16px;border:1px solid #f59e0b">
              <h2 style="margin:0 0 8px;color:#fbbf24">👑 Xác Nhận Bao Nguyên Rạp CineVerse</h2>
              <p style="font-size:14px;color:#cbd5e1;margin:0 0 14px">Xin chào <b>${userName}</b>, cảm ơn bạn đã đặt gói <b>Bao Nguyên Rạp</b>!</p>
              <div style="background:#1c1917;padding:14px;border-radius:12px;border:1px solid #292524;font-size:13px;line-height:1.7">
                <div>• <b>Phòng:</b> ${roomNumber}</div>
                <div>• <b>Phim:</b> ${movieTitle}</div>
                <div>• <b>Tổng thanh toán:</b> <span style="color:#34d399;font-weight:bold">${formattedTotal}</span></div>
              </div>
              <p style="font-size:13px;color:#cbd5e1;margin:16px 0 8px">🔑 <b>Key Chủ Trì Phòng Của Bạn (dùng để mở khóa điều khiển &amp; tua phim đồng bộ):</b></p>
              <div style="font-size:28px;font-weight:900;letter-spacing:4px;text-align:center;padding:14px;background:#1c1917;border:2px dashed #fbbf24;border-radius:12px;color:#fbbf24">${hostKey}</div>
              <p style="font-size:12px;color:#94a3b8;margin:14px 0 0">Khi vào phòng, hãy bấm nút <b>Làm Chủ Trì</b> và nhập mã Key trên để toàn quyền phát/dừng/tua phim đồng bộ với cả rạp.</p>
            </div>`
          })
        });
        const mailJson = await mailRes.json().catch(() => ({}));
        if (!mailRes.ok) {
          return jsonResponse({ ok: false, error: mailJson?.message || `Resend ${mailRes.status}` }, 400);
        }
        return jsonResponse({ ok: true, id: mailJson?.id || "" }, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    if (!env.MY_BUCKET) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Chưa gắn R2 Bucket Binding tên 'MY_BUCKET' trong Settings -> Bindings của Worker."
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
        }
      );
    }

    if (url.pathname === "/hanoi-showtimes" && request.method === "GET") {
      try {
        const res = await fetch("https://moveek.com/dang-chieu/", {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; CineVerseBot/1.0)" }
        });
        if (res.ok) {
          const html = await res.text();
          const titleMatches = [...html.matchAll(/<a[^>]+href="\/phim\/[^"]+"[^>]*title="([^"]{2,80})"/gi)];
          const seen = new Set();
          const movies = [];
          const defaultSlots = ["10:00", "12:20", "14:40", "17:05", "19:25", "21:40", "23:10"];
          for (const m of titleMatches) {
            const t = (m[1] || "").replace(/\s+/g, " ").trim();
            if (!t || seen.has(t.toLowerCase())) continue;
            seen.add(t.toLowerCase());
            movies.push({ title: t, format: "2D Phụ đề • Rạp Hà Nội", slots: defaultSlots });
            if (movies.length >= 6) break;
          }
          if (movies.length > 0) {
            return new Response(
              JSON.stringify({ ok: true, source: "Moveek Hà Nội (Live)", movies }),
              { status: 200, headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=900" } }
            );
          }
        }
      } catch (_) {}
      return new Response(
        JSON.stringify({ ok: false, movies: [] }),
        { status: 200, headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    const forceRefresh = url.searchParams.get("refresh") === "1";
    const nowTs = Date.now();
    if (!forceRefresh && R2_CATALOG_CACHE.data && nowTs - R2_CATALOG_CACHE.ts < 30000) {
      return new Response(
        JSON.stringify({ ok: true, cached: true, count: R2_CATALOG_CACHE.data.length, videos: R2_CATALOG_CACHE.data }),
        {
          status: 200,
          headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
        }
      );
    }

    const videos = [];
    let cursor = undefined;

    do {
      const listed = await env.MY_BUCKET.list({ cursor, limit: 1000 });
      for (const obj of listed.objects) {
        if (!VIDEO_EXT_RE.test(obj.key)) continue;

        const fileName = obj.key.split("/").pop() || obj.key;
        const cleanTitle = fileName
          .replace(VIDEO_EXT_RE, "")
          .replace(/\s+/g, " ")
          .trim();

        const encodedPath = obj.key
          .split("/")
          .map(seg => encodeURIComponent(seg))
          .join("/");

        videos.push({
          key: obj.key,
          title: cleanTitle,
          size: obj.size || 0,
          uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
          url: `${R2_PUBLIC_BASE}/${encodedPath}`
        });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    videos.sort((a, b) => a.key.localeCompare(b.key, "vi"));
    R2_CATALOG_CACHE = { ts: Date.now(), data: videos };

    return new Response(
      JSON.stringify({ ok: true, count: videos.length, videos }),
      {
        status: 200,
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
      }
    );
}

export default {
  async fetch(request, env) {
    const corsHdrs = getCorsHeaders(request, env);
    const raw = await handleWorkerFetch(request, env, corsHdrs);
    const res = new Response(raw.body, raw);
    for (const [k, v] of Object.entries(corsHdrs)) {
      res.headers.set(k, v);
    }
    return res;
  }
};
