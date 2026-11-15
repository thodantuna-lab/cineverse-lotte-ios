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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
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
      try {
        const body = await request.json();
        const pin = String(body?.pin || "").trim();
        const expected = String(env.ADMIN_PIN || "2026").trim();
        return jsonResponse({ ok: Boolean(pin && pin === expected), usingSecret: Boolean(env.ADMIN_PIN) }, 200);
      } catch (e) {
        return jsonResponse({ ok: false }, 200);
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

    return new Response(
      JSON.stringify({ ok: true, count: videos.length, videos }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
      }
    );
  }
};
