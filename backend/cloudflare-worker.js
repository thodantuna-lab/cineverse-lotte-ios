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
  "Permissions-Policy": "geolocation=(self), payment=()"
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
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
const USED_OTP_TOKENS = new Map();
const AI_RESPONSE_CACHE = new Map();
let R2_CATALOG_CACHE = { ts: 0, data: null };

function timingSafeEqualStr(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function getOtpSecret(env) {
  const secret = String(env?.OTP_SECRET || env?.ADMIN_PIN || env?.RESEND_API_KEY || "").trim();
  if (!secret) throw new Error("OTP_SECRET_NOT_CONFIGURED");
  return secret;
}

function isOtpTokenUsed(token) {
  const now = Date.now();
  if (USED_OTP_TOKENS.size > 400) {
    for (const [k, exp] of USED_OTP_TOKENS.entries()) {
      if (exp <= now) USED_OTP_TOKENS.delete(k);
    }
  }
  const exp = USED_OTP_TOKENS.get(token);
  return Boolean(exp && exp > now);
}

function markOtpTokenUsed(token, ttlMs = 600000) {
  USED_OTP_TOKENS.set(token, Date.now() + ttlMs);
}

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
  const windowMs = 15 * 60 * 1000;
  const rec = ADMIN_FAIL_BUCKETS.get(ip);
  if (!rec || now >= rec.until) {
    ADMIN_FAIL_BUCKETS.set(ip, { count: 1, until: now + windowMs });
  } else {
    rec.count += 1;
    if (rec.count >= 5) rec.until = now + windowMs;
  }
}

function getExpectedAdminPin(env) {
  return String(env?.ADMIN_PIN || "").trim();
}

async function getAdminSessionKey(env) {
  const secretBase = String(env?.ADMIN_SESSION_SECRET || env?.ADMIN_PIN || "").trim();
  if (!secretBase) throw new Error("ADMIN_PIN_NOT_CONFIGURED");
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(`${secretBase}::cineverse-admin-session-v1`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signAdminSessionToken(env, ttlMs = 8 * 60 * 60 * 1000) {
  const key = await getAdminSessionKey(env);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const rand = new Uint8Array(12);
  crypto.getRandomValues(rand);
  const nonce = Array.from(rand).map((b) => b.toString(16).padStart(2, "0")).join("");
  const payload = { role: "admin", iat: now, exp: expiresAt, nonce };
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));
  return { token: `${payloadB64}.${sigB64}`, expiresAt };
}

async function verifyAdminSessionToken(env, token) {
  const raw = String(token || "").trim();
  if (!raw || !raw.includes(".")) return { ok: false };
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { ok: false };
  try {
    const key = await getAdminSessionKey(env);
    const expectedSigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
    const expectedSigB64 = base64UrlEncode(new Uint8Array(expectedSigBuf));
    const sigOk = await constantTimeEqual(sigB64, expectedSigB64);
    if (!sigOk) return { ok: false };
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(b64 + pad));
    if (payload?.role !== "admin" || typeof payload.exp !== "number" || Date.now() >= payload.exp) {
      return { ok: false };
    }
    return { ok: true, expiresAt: payload.exp };
  } catch (_) {
    return { ok: false };
  }
}

function extractAdminToken(request, body) {
  const auth = String(request?.headers?.get("Authorization") || "").trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return String(body?.token || "").trim();
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
    const identity = String(body?.uid || url.searchParams.get("uid") || "").trim().slice(0, 64);
    const name = String(body?.name || url.searchParams.get("name") || identity).trim().slice(0, 40);
    if (!room || !identity) {
      return jsonResponse({ ok: false, error: "MISSING_ROOM_OR_UID" }, 200);
    }
    if (!/^(cineverse_)?(room-[1-8]|stream-[1-8])$/i.test(room)) {
      return jsonResponse({ ok: false, error: "INVALID_ROOM_ID" }, 400);
    }
    const token = await signLiveKitJwt(apiKey, apiSecret, { room, identity, name, ttlSeconds: 14400 });
    return jsonResponse({ ok: true, url: livekitUrl, token }, 200);
  } catch (e) {
    return jsonResponse({ ok: false, error: e?.message || "LIVEKIT_TOKEN_ERROR" }, 200);
  }
}

async function getRoomSealKey(env) {
  const adminPin = getExpectedAdminPin(env);
  if (!adminPin) throw new Error("ADMIN_PIN_NOT_CONFIGURED");
  const secret = adminPin + "::cineverse-room-seal-v1";
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

const RTDB_GEMINI_TELEMETRY_BASE = "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app/lobby_config/gemini_usage_logs";
const GEMINI_COOLDOWN_UNTIL = new Map();
const POSTER_META_CACHE = new Map();
let GEMINI_REGION_BLOCKED_UNTIL = 0;

function logGeminiTelemetry(entry, ctx) {
  const promise = fetch(`${RTDB_GEMINI_TELEMETRY_BASE}/${entry.id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry)
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise);
  }
}

/**
 * Shared Gemini generateContent caller with non-blocking RTDB telemetry.
 */
async function callGeminiWithTelemetry(modelName, payload, timeoutMs, featureTag, env, ctx, colo = "EDGE") {
  const now = Date.now();
  if (GEMINI_REGION_BLOCKED_UNTIL > now) {
    return { text: "", errorMsg: `User location is not supported [Edge: ${colo}]`, status: 400 };
  }
  const cooldownUntil = GEMINI_COOLDOWN_UNTIL.get(modelName) || 0;
  if (cooldownUntil > now) {
    return { text: "", errorMsg: "MODEL_COOLDOWN_429", status: 429 };
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const startedAt = Date.now();
  const logId = `g_${startedAt}_${Math.random().toString(36).slice(2, 7)}`;
  let status = 0;
  let text = "";
  let errorMsg = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  try {
    const gemRes = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(payload)
    });
    status = gemRes.status || 0;
    const gemData = await gemRes.json().catch(() => ({}));
    text = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const usage = gemData?.usageMetadata || {};
    inputTokens = Number(usage.promptTokenCount || 0);
    outputTokens = Number(usage.candidatesTokenCount || 0);
    totalTokens = Number(usage.totalTokenCount || (inputTokens + outputTokens));
    if (!text) {
      const raw = String(gemData?.error?.message || `HTTP_${status || "EMPTY"}`);
      if (raw.includes("User location is not supported")) {
        errorMsg = `User location is not supported [Edge: ${colo}]`;
        GEMINI_REGION_BLOCKED_UNTIL = Date.now() + 300000;
      } else {
        errorMsg = raw.slice(0, 140);
      }
      if (status === 429) {
        GEMINI_COOLDOWN_UNTIL.set(modelName, Date.now() + 60000);
      }
    }
  } catch (e) {
    status = e?.name === "TimeoutError" ? 408 : 0;
    errorMsg = String(e?.message || "FETCH_ERROR").slice(0, 140);
  }

  logGeminiTelemetry({
    id: logId,
    ts: startedAt,
    model: modelName,
    feature: featureTag,
    status,
    ok: Boolean(text),
    latencyMs: Date.now() - startedAt,
    inputTokens,
    outputTokens,
    totalTokens,
    colo,
    error: errorMsg
  }, ctx);

  return { text, errorMsg, status };
}

async function handleTranslateSrtRequest(request, env, ctx) {
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

    const modelsToTry = [
      "gemini-flash-lite-latest",
      "gemini-3.5-flash-lite",
      "gemini-2.0-flash-lite",
      "gemini-flash-latest"
    ];
    let rawText = "";
    let lastError = "EMPTY_RESPONSE";

    const colo = request?.cf?.colo || "EDGE";
    for (let idx = 0; idx < modelsToTry.length; idx++) {
      const modelName = modelsToTry[idx];
      if (idx > 0) await new Promise(r => setTimeout(r, 1200));
      const genCfg = {
        responseMimeType: "application/json",
        temperature: 0.3
      };
      if (modelName === "gemini-flash-latest") {
        genCfg.thinkingConfig = { thinkingBudget: 0 };
      }
      const res = await callGeminiWithTelemetry(modelName, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: genCfg
      }, 30000, "translate-srt", env, ctx, colo);
      if (res.text) {
        rawText = res.text;
        break;
      }
      if (res.errorMsg) lastError = res.errorMsg;
      if (res.errorMsg && res.errorMsg.includes("User location is not supported")) {
        break;
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

function cleanPlainReply(text) {
  return String(text || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildConciseSupportFallback(qTrim, body) {
  const q = String(qTrim || "");
  const isPaid = body?.paymentMode === "paid";
  const rooms = Array.isArray(body?.availableRooms) ? body.availableRooms : [];

  const numM = q.match(/phòng(?:\s*chiếu)?\s*0?([1-8])\b/i) || q.match(/\b(?:p|rm)[-\s]?0?([1-8])\b/i);
  const wantCouple = /phòng\s*đôi/i.test(q);
  const wantStream = /phòng\s*stream/i.test(q);
  const targetNum = numM ? numM[1] : (wantCouple ? "7" : (wantStream ? "8" : ""));

  if (targetNum) {
    const matched = rooms.find(r => {
      const lbl = String(r?.room || "");
      const m = lbl.match(/0?([1-8])/);
      if (m && m[1] === targetNum) return true;
      if (targetNum === "7" && /đôi/i.test(lbl)) return true;
      if (targetNum === "8" && /stream/i.test(lbl)) return true;
      return false;
    });
    if (matched) {
      const st = matched.status === "upcoming" ? "sắp chiếu" : "đang chiếu";
      return `${matched.room} hiện ${st}: ${matched.title || "đang cập nhật"}. Vé đang ${isPaid ? "thu phí VietQR" : "Miễn Phí"}, bạn bấm vào ${matched.room} ở Sảnh chính để chọn ghế nhé.`;
    }
    return `Bạn chọn Phòng 0${targetNum} ở Sảnh chính để xem lịch chiếu và đặt ghế nhé.`;
  }

  if (/doanh\s*thu|thống\s*kê|lợi\s*nhuận/i.test(q)) {
    return isPaid
      ? "Số liệu doanh thu là thông tin nội bộ nên không công khai ạ."
      : "Rạp hiện đang mở Miễn Phí toàn bộ nên không phát sinh doanh thu vé ạ.";
  }
  if (/giá\s*vé|mua\s*vé|đặt\s*vé|thanh\s*toán|vietqr|mất\s*phí|bao\s*nhiêu\s*tiền/i.test(q)) {
    return isPaid
      ? "Rạp đang áp dụng thu phí VietQR, bạn chọn ghế rồi quét mã QR để Admin duyệt nhé."
      : "Hiện rạp đang mở Miễn Phí, bạn chỉ cần chọn phòng và ghế để vào xem ngay nhé.";
  }
  if (/đổi\s*phim|yêu\s*cầu\s*phim|chiếu\s*phim\s*khác/i.test(q)) {
    return "Trong phòng chiếu, bạn bấm vào phim ở cột Phim Đang Có bên trái để gửi yêu cầu Chủ Rạp duyệt đổi phim nhé.";
  }
  if (/\bmic\b|micro|âm\s*thanh|nói\s*chuyện/i.test(q)) {
    return "Bạn bấm nút Bật Mic ở thanh điều khiển dưới màn hình và cấp quyền micro cho trình duyệt nhé.";
  }
  if (/phụ\s*đề|vietsub|\bsub\b|\bsrt\b/i.test(q)) {
    return "Phụ đề chỉ hiển thị với phim có file .srt trên máy chủ; phim đã có Vietsub cứng sẽ tự ẩn nút phụ đề ạ.";
  }
  if (/tìm\s*rạp|hà\s*nội|\bcgv\b|\bbeta\b|\blotte\b/i.test(q)) {
    return "Bạn bấm nút Tìm Rạp Hà Nội trên thanh menu để xem các cụm rạp gần nhất và lịch chiếu nhé.";
  }
  if (/(chủ\s*rạp|\badmin\b|khiếu\s*nại|tài\s*khoản|mở\s*khóa)/iu.test(q)) {
    return "Chủ Rạp đã nhận được tin nhắn của bạn và sẽ phản hồi sớm nhất nhé.";
  }
  if (/(phòng\s*(?:nào|gì|mấy|chiếu)|đang\s*chiếu|sắp\s*chiếu|xem\s*gì|gợi\s*ý|(?<![\p{L}\p{N}])(?:kho|list)(?![\p{L}\p{N}])|danh\s*sách|có\s*phim|phim\s*gì|phim\s*nào)/iu.test(q) && rooms.length > 0) {
    return `Rạp đang có: ${rooms.slice(0, 4).map(r => `${r.room} (${r.title})`).join(", ")}. Bạn xem đủ các phòng ở Sảnh chính nhé.`;
  }
  return "Chủ Rạp đã nhận được tin nhắn của bạn và sẽ phản hồi sớm nhất nhé.";
}

const HOST_KEY_ROOMS = [
  { id: "room-1", name: "Phòng 01" },
  { id: "room-2", name: "Phòng 02" },
  { id: "room-3", name: "Phòng 03" },
  { id: "room-4", name: "Phòng 04" },
  { id: "room-5", name: "Phòng 05" },
  { id: "room-6", name: "Phòng 06" },
  { id: "room-7", name: "Phòng Đôi" },
  { id: "room-8", name: "Phòng Stream" }
];

function extractTargetRoomIdForHostKey(qTrim, body) {
  const q = String(qTrim || "").toLowerCase();
  if (/ph[oò]ng\s*[đd][oô]i/i.test(q) || /\broom[-_\s]?7\b/i.test(q)) return "room-7";
  if (/ph[oò]ng\s*stream/i.test(q) || /\broom[-_\s]?8\b/i.test(q)) return "room-8";
  const m = q.match(/(?:ph[oò]ng|room|\bp)\s*[-_#]?\s*0?([1-8])\b/i);
  if (m) return `room-${m[1]}`;

  const curId = String(body?.currentRoomId || "").trim();
  if (/^room-[1-8]$/i.test(curId)) return curId.toLowerCase();

  const curLabel = String(body?.currentRoom || "").toLowerCase();
  if (/ph[oò]ng\s*[đd][oô]i/i.test(curLabel)) return "room-7";
  if (/ph[oò]ng\s*stream/i.test(curLabel)) return "room-8";
  const mCur = curLabel.match(/ph[oò]ng\s*0?([1-8])\b/i);
  if (mCur) return `room-${mCur[1]}`;

  return "";
}

async function handleHostKeyChatRequest(qTrim, body, env) {
  const wantsHostKey =
    /(xin|l[aấ]y|c[aấ]p|cho|g[uử]i|mu[oố]n|h[oỏ]i|nh[aậ]n).*(key|ch[uủ]\s*tr[iì]|host)/i.test(qTrim) ||
    /(key\s*(ph[oò]ng|ch[uủ]\s*tr[iì]|host|stream|[đd][oô]i)|m[aã]\s*ch[uủ]\s*tr[iì])/i.test(qTrim);
  if (!wantsHostKey) return null;

  const rtdbBase = String(env?.FIREBASE_RTDB_URL || "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, "");

  // Tự động tắt tính năng xin Key khi rạp đang bật chế độ Trả phí
  try {
    const payRes = await fetch(`${rtdbBase}/lobby_config/payment_mode.json`, { cache: "no-store" });
    const payData = payRes.ok ? await payRes.json().catch(() => null) : null;
    if (payData?.mode === "paid" || body?.paymentMode === "paid") {
      return "Rạp hiện đang bật chế độ Trả phí nên tính năng xin Key Chủ Trì tự động tạm tắt. Vui lòng đặt vé/bao rạp qua VietQR hoặc liên hệ Chủ Rạp!";
    }
  } catch (_) {
    if (body?.paymentMode === "paid") {
      return "Rạp hiện đang bật chế độ Trả phí nên tính năng xin Key Chủ Trì tự động tạm tắt. Vui lòng đặt vé/bao rạp qua VietQR hoặc liên hệ Chủ Rạp!";
    }
  }

  const targetRoomId = extractTargetRoomIdForHostKey(qTrim, body);

  const hostPairs = await Promise.all(
    HOST_KEY_ROOMS.map(async (r) => {
      try {
        const res = await fetch(`${rtdbBase}/host/${encodeURIComponent(r.id)}.json`, { cache: "no-store" });
        const val = res.ok ? await res.json().catch(() => null) : null;
        return [r.id, val && val.uid ? val : null];
      } catch (_) {
        return [r.id, null];
      }
    })
  );
  const hostMap = Object.fromEntries(hostPairs);
  const freeRooms = HOST_KEY_ROOMS.filter((r) => !hostMap[r.id]);
  const freeText = freeRooms.length > 0 ? freeRooms.map((r) => r.name).join(", ") : "";

  if (!targetRoomId) {
    if (freeRooms.length === 0) {
      return "Hiện tất cả các phòng đều đang có người chủ trì nên bạn chưa thể xin key lúc này. Vui lòng đợi người chủ trì nhường quyền nhé!";
    }
    return `Bạn muốn xin key phòng nào? Hiện các phòng đang trống Chủ Trì gồm: ${freeText}. Hãy nhắn cụ thể ví dụ: "xin key phòng 1" nhé!`;
  }

  const targetMeta = HOST_KEY_ROOMS.find((r) => r.id === targetRoomId) || { id: targetRoomId, name: targetRoomId };
  const currentHost = hostMap[targetRoomId];
  if (currentHost && currentHost.uid) {
    const hostName = String(currentHost.userName || "Chủ Trì").trim();
    if (freeText) {
      return `${targetMeta.name} đang có người chủ trì (${hostName}) nên bạn không thể xin key. Vui lòng qua phòng trống (${freeText}) hoặc đợi người chủ trì nhường quyền!`;
    }
    return `${targetMeta.name} đang có người chủ trì (${hostName}) nên bạn không thể xin key. Hiện tất cả các phòng khác cũng đã có chủ trì, vui lòng đợi người chủ trì nhường quyền!`;
  }

  try {
    const keyRes = await fetch(`${rtdbBase}/host_keys/${encodeURIComponent(targetRoomId)}.json`, { cache: "no-store" });
    const keyData = keyRes.ok ? await keyRes.json().catch(() => null) : null;
    const keyVal = String(keyData?.key || "").trim().toUpperCase();
    if (!keyVal) {
      return `Admin chưa tạo Key Chủ Trì cho ${targetMeta.name}. Vui lòng chọn phòng trống khác${freeText ? ` (${freeText})` : ""} hoặc đợi Chủ Rạp cấp nhé!`;
    }
    return `Key Chủ Trì ${targetMeta.name} (đang trống): ${keyVal}. Bạn vào ${targetMeta.name}, bấm nút "Nhận Chủ Trì" và nhập mã này để làm Chủ Trì nhé!`;
  } catch (_) {
    return "Không thể kiểm tra Key Chủ Trì lúc này, vui lòng thử lại sau giây lát.";
  }
}

async function handleAIRequest(request, env, ctx) {
  try {
    const body = await request.json();
    const mode = body.mode || "chat";
    const qTrim = String(body.question || "").trim().slice(0, 350);

    if ((mode === "support" || mode === "chat") && qTrim) {
      const hostKeyReply = await handleHostKeyChatRequest(qTrim, body, env);
      if (hostKeyReply) {
        return jsonResponse({ ok: true, mode, reply: hostKeyReply, zeroToken: true }, 200);
      }
    }

    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ ok: false, error: "MISSING_GEMINI_API_KEY" }, 200);
    }
    const movieTitle = body.movieTitle || "Phim đang chiếu";
    const genre = body.genre || "";
    const synopsis = body.synopsis || "";
    const cast = body.cast || "";
    const availableTitles = Array.isArray(body.availableTitles) ? body.availableTitles : [];
    const availableRooms = Array.isArray(body.availableRooms) ? body.availableRooms : [];
    const history = Array.isArray(body.history)
      ? body.history.slice(-4).map(h => ({ sender: h?.sender, text: String(h?.text || "").slice(0, 140) }))
      : [];

    // Cache AI kết quả cho các chế độ lặp lại (trivia / recommend) trong 30 phút để tiết kiệm quota Gemini
    const cacheableAiMode = mode === "trivia" || mode === "recommend";
    const aiCacheKey = cacheableAiMode ? `${mode}:${String(movieTitle || "").trim().toLowerCase()}` : "";
    if (cacheableAiMode && aiCacheKey) {
      const cached = AI_RESPONSE_CACHE.get(aiCacheKey);
      if (cached && Date.now() - cached.ts < 1800000) {
        return jsonResponse({ ok: true, mode, items: cached.items, cached: true }, 200);
      }
    }

    if (mode === "support") {
      const qNorm = qTrim.toLowerCase().replace(/[!.,?~…]+$/g, "").replace(/\s+/g, " ");
      if (!qNorm) {
        return jsonResponse({ ok: true, mode, reply: "Bạn cần hỗ trợ gì ạ?", zeroToken: true }, 200);
      }
      if (/^(ok|oke|okie|oki|okela|uk|uh|ừ|ừm|uhm|vâng|dạ|da|rồi|roi|được|duoc|đã hiểu|hieu roi|hiểu rồi|biết rồi|biet roi|👍|👌)$/.test(qNorm)) {
        return jsonResponse({ ok: true, mode, reply: "Dạ vâng ạ, cần hỗ trợ gì cứ nhắn nhé.", zeroToken: true }, 200);
      }
      if (/^(cảm ơn|cam on|cảm ơn nhé|cam on nhe|cảm ơn bạn|cảm ơn shop|cảm ơn ad|thanks|thank you|tks|tk|ty|❤️|🙏)$/.test(qNorm)) {
        return jsonResponse({ ok: true, mode, reply: "Không có gì ạ, chúc bạn xem phim vui vẻ.", zeroToken: true }, 200);
      }
      if (/^(hi|hello|alo|chào|chao|xin chào|xin chao|ad ơi|admin ơi|shop ơi|hey)$/.test(qNorm)) {
        return jsonResponse({ ok: true, mode, reply: "Chào bạn! Bạn cần hỗ trợ về phim, phòng chiếu hay vé ạ?", zeroToken: true }, 200);
      }
    }

    const asksCatalog = /(xem gì|gợi ý|(?<![\p{L}\p{N}])(?:kho|list)(?![\p{L}\p{N}])|danh sách|có phim|phim gì|phim nào|các phim|những phim|mấy phim|đổi phim|tìm phim|thể loại|anime|hành động|kinh dị)/iu.test(qTrim);
    const asksRooms = /(phòng|room|đang chiếu|sắp chiếu|lịch|xem gì|chỗ nào|vào đâu)/i.test(qTrim);
    const asksGuide = /(cách|làm sao|hướng dẫn|đặt vé|chọn ghế|đổi phim|phụ đề|sub|srt|tìm rạp|hà nội|mic|âm thanh|tiếng|lỗi|không xem|lag|giật|vé|tiền|qr)/i.test(qTrim);

    let prompt = "";
    let wantJson = false;
    if (mode === "trivia") {
      wantJson = true;
      prompt = `Bạn là chuyên gia điện ảnh. Hãy tạo 4 câu hỏi trắc nghiệm đố vui CHÍNH XÁC 100% về bộ phim thực tế "${movieTitle}"${genre ? ` (Thể loại: ${genre})` : ""}${cast ? ` (Diễn viên: ${cast})` : ""}${synopsis ? ` (Tóm tắt: ${synopsis})` : ""}.
Quy tắc bắt buộc:
- Chỉ hỏi sự thật chính xác về đúng bộ phim "${movieTitle}" (diễn viên, đạo diễn, nhân vật, cốt truyện thật). TUYỆT ĐỐI KHÔNG bịa đặt hoặc trộn nội dung phim khác.
- Đáp án đúng phải khớp chính xác với chỉ số answer (0..3).
Trả về đúng JSON mảng 4 phần tử: [{"q":"câu hỏi","options":["A","B","C","D"],"answer":0}]`;
    } else if (mode === "recommend") {
      wantJson = true;
      prompt = `Khán giả vừa xem "${movieTitle}" (${genre}). Trong danh sách video sẵn có sau: ${JSON.stringify(availableTitles.slice(0, 25))}, chọn 3-4 video phù hợp nhất để đề xuất xem tiếp (ưu tiên tập tiếp theo nếu là phim bộ). Trả về đúng JSON mảng: [{"title":"tên chính xác trong danh sách","reason":"lý do cực ngắn <= 10 từ"}]`;
    } else if (mode === "support") {
      const roomsLine = (asksRooms || asksCatalog) && availableRooms.length
        ? `\nPhòng: ${availableRooms.map(r => `${r.room}: ${r.title} (${r.status === "upcoming" ? "Sắp chiếu" : "Đang chiếu"})`).join(" | ")}`
        : "";
      const titlesLine = asksCatalog && availableTitles.length
        ? `\nKho (${availableTitles.length}): ${availableTitles.slice(0, 20).join(", ")}`
        : "";
      const guideLine = asksGuide
        ? `\nTính năng: Chọn phòng -> chọn ghế (48 ghế/phòng, Stream 10 ghế). Bấm phim ở "Phim Đang Có" gửi Admin duyệt đổi phim. Phụ đề chỉ hiện với phim có file .srt. "Tìm Rạp Hà Nội" để xem cụm rạp. Bấm "Bật Mic" dưới màn hình để nói chuyện.`
        : "";
      const histText = history.length
        ? `\nHội thoại gần nhất:\n${history.map(h => `${h.sender === "user" ? "Khách" : "CSKH"}: ${h.text}`).join("\n")}`
        : "";
      const payModeLabel = body.paymentMode === "paid" ? "Trả phí VietQR (cần Admin duyệt)" : "Miễn phí";
      prompt = `Bạn là CSKH của rạp trực tuyến CineVerse Lotte.
Ngữ cảnh hiện tại: Vé=${payModeLabel} | Vị trí=${body.currentRoom || "Sảnh chính"}${roomsLine}${titlesLine}${guideLine}${histText}
Quy tắc BẮT BUỘC:
- Trả lời thẳng vào câu hỏi, đủ ý, NGẮN GỌN NHẤT (1–2 câu, tối đa ~40 từ; chỉ liệt kê gọn nếu khách hỏi danh sách).
- KHÔNG lòng vòng, KHÔNG nhắc lại phim/phòng khi không cần, KHÔNG thêm câu mời chào/chúc xem phim cuối câu.
- KHÔNG dùng Markdown (*, **, #, \`).
- KHÔNG bịa đặt. Hỏi dữ liệu nội bộ (doanh thu, thống kê quản trị) -> trả lời 1 câu rõ thông tin nội bộ không công khai (hoặc rạp đang miễn phí nếu hỏi về vé). Cần Chủ Rạp xử lý thủ công -> 1 câu ngắn báo Chủ Rạp đã nhận tin.
Khách (${body.userName || "Khách"}): ${qTrim}`;
    } else {
      const roomsLine = (asksRooms || asksCatalog) && availableRooms.length
        ? `\nPhòng: ${availableRooms.map(r => `${r.room}: ${r.title} (${r.status === "upcoming" ? "Sắp chiếu" : "Đang chiếu"})`).join(" | ")}`
        : "";
      const catalogLine = asksCatalog && availableTitles.length
        ? `\nKho (${availableTitles.length}): ${availableTitles.slice(0, 20).join(", ")}`
        : "";
      prompt = `Bạn là Trợ lý Điện ảnh rạp CineVerse Lotte.
Phim hiện tại: "${movieTitle}"${genre ? ` (${genre})` : ""}${cast ? ` | Cast: ${cast}` : ""}${synopsis ? ` | ${synopsis}` : ""}.${roomsLine}${catalogLine}
Quy tắc BẮT BUỘC:
1. Trả lời đúng sự thật, thẳng vào trọng tâm bằng tiếng Việt ngắn gọn (1–3 câu), KHÔNG lòng vòng, KHÔNG thêm câu chào/chúc cuối câu.
2. KHÔNG dùng Markdown (*, **, #, \`). KHÔNG bịa chi tiết; nếu chưa có thông tin thì nói ngắn gọn là chưa có.
3. Hỏi lịch/kho phim thì liệt kê gọn từ dữ liệu trên.
Khán giả: ${qTrim}`;
    }

    const baseGenConfig = wantJson
      ? {
          responseMimeType: "application/json",
          temperature: mode === "trivia" ? 0.25 : 0.2,
          maxOutputTokens: mode === "trivia" ? 520 : 260
        }
      : {
          temperature: mode === "support" ? 0.2 : 0.25,
          maxOutputTokens: mode === "support" ? 120 : 180
        };

    const modelsToTry = [
      "gemini-flash-lite-latest",
      "gemini-3.5-flash-lite",
      "gemini-2.0-flash-lite",
      "gemini-flash-latest"
    ];
    let rawText = "";
    let lastError = "EMPTY_RESPONSE";

    const colo = request?.cf?.colo || "EDGE";
    for (let idx = 0; idx < modelsToTry.length; idx++) {
      const modelName = modelsToTry[idx];
      if (idx > 0) await new Promise(r => setTimeout(r, 1200));
      const genCfg = { ...baseGenConfig };
      if (modelName === "gemini-flash-latest") {
        genCfg.thinkingConfig = { thinkingBudget: 0 };
      }
      const res = await callGeminiWithTelemetry(modelName, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: genCfg
      }, 15000, `ai-${mode}`, env, ctx, colo);
      if (res.text) {
        rawText = res.text;
        break;
      }
      if (res.errorMsg) lastError = res.errorMsg;
      if (res.errorMsg && res.errorMsg.includes("User location is not supported")) {
        break;
      }
    }
    if (!rawText) {
      if (mode === "support") {
        return jsonResponse({
          ok: true,
          mode,
          reply: buildConciseSupportFallback(qTrim, body),
          fallback: true,
          upstreamError: lastError
        }, 200);
      }
      return jsonResponse({ ok: false, error: lastError }, 200);
    }

    if (wantJson) {
      const parsed = JSON.parse(rawText);
      if (cacheableAiMode && aiCacheKey && Array.isArray(parsed) && parsed.length > 0) {
        if (AI_RESPONSE_CACHE.size > 200) {
          const firstKey = AI_RESPONSE_CACHE.keys().next().value;
          if (firstKey) AI_RESPONSE_CACHE.delete(firstKey);
        }
        AI_RESPONSE_CACHE.set(aiCacheKey, { ts: Date.now(), items: parsed });
      }
      return jsonResponse({ ok: true, mode, items: parsed }, 200);
    }
    return jsonResponse({ ok: true, mode, reply: cleanPlainReply(rawText) }, 200);
  } catch (err) {
    return jsonResponse({ ok: false, error: err?.message || "AI_ERROR" }, 200);
  }
}

function buildRegexMovieMeta(rawTitle) {
  const s = String(rawTitle || "");
  const norm = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase();
  const canonicalAliases = [
    [/chua te cua nhung chiec nhan.*quyen nang|rings of power/i, "The Lord of the Rings: The Rings of Power", "tv", "2022"],
    [/chua te cua nhung chiec nhan.*hai toa thap|two towers/i, "The Lord of the Rings: The Two Towers", "movie", "2002"],
    [/chua te cua nhung chiec nhan.*su tro lai|return of the king/i, "The Lord of the Rings: The Return of the King", "movie", "2003"],
    [/chua te cua nhung chiec nhan.*rohirrim|rohirrim/i, "The Lord of the Rings: The War of the Rohirrim", "movie", "2024"],
    [/chu he trong canh dong ngo|clown in a cornfield/i, "Clown in a Cornfield", "movie", "2025"],
    [/chu thuat hoi chien\s*0|jujutsu kaisen\s*0/i, "Jujutsu Kaisen 0", "anime", "2021"],
    [/chu thuat hoi chien|jujutsu kaisen|tu diet hoi du/i, "Jujutsu Kaisen", "anime", "2020"],
    [/biet doi danh thue\s*4|expend4bles/i, "Expend4bles", "movie", "2023"],
    [/biet doi danh thue\s*3|expendables\s*3/i, "The Expendables 3", "movie", "2014"],
    [/wakanda bat diet|wakanda forever/i, "Black Panther: Wakanda Forever", "movie", "2022"],
    [/venom.*doi mat tu thu|carnage/i, "Venom: Let There Be Carnage", "movie", "2021"],
    [/venom.*keo cuoi|last dance/i, "Venom: The Last Dance", "movie", "2024"],
    [/bi kip luyen rong|how to train your dragon/i, "How to Train Your Dragon", "movie", "2025"],
    [/transformers.*bai binh phuc han|revenge of the fallen/i, "Transformers: Revenge of the Fallen", "movie", "2009"],
    [/vung dat quy du.*dao tu than|death island/i, "Resident Evil: Death Island", "movie", "2023"],
    [/vung dat quy du.*2026|resident evil.*2026/i, "Resident Evil: Welcome to Raccoon City", "movie", "2021"]
  ];
  for (const [re, aliasQ, aliasType, aliasYear] of canonicalAliases) {
    if (re.test(norm)) {
      return { query: aliasQ, type: aliasType, year: aliasYear };
    }
  }

  const yearMatch = s.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : "";
  // Ưu tiên tên tiếng Anh nằm trong ngoặc đơn (vd: "(The Nun 2)", "(Clown in a Cornfield)", "(Resident Evil 2026)")
  const parenMatches = [...s.matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
  const parenTitle = parenMatches.find(p =>
    !/^\d{4}$/.test(p) &&
    !/^(vietsub|thuyết minh|lồng tiếng|full|phần\s*\d+|tập\s*\d+|1080p|720p|4k|bluray|webrip|x264|x265|hevc)/i.test(p) &&
    /[a-zA-Z]{2,}/.test(p)
  );
  const baseStr = parenTitle || s.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  const query = baseStr
    .replace(/^xem\s+/i, " ")
    .replace(/\b(phimmoi(?:\.fun|z)?|tập\s*full|tập\s*\d+|phần\s*\d+|vietsub|thuyết\s*minh|lồng\s*tiếng|miễn\s*phí|full\s*hd|full|fhd|1080p|720p|4k|webrip|bluray|x264|x265|hevc|aac5?\.1|hindi|ozlem|rarbg|upco\s*cinema|mọt\s*chill|motchill|motphim|8phimx|ani-one(?:\s*vietnam)?|yts\.(?:mx|gg|bz))\b/gi, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    query,
    type: /tập\s*\d+|season|s\d+|anime|phần\s*\d+/i.test(s) ? "tv" : "movie",
    year
  };
}

async function extractCleanMovieMetaWithAI(rawTitle, env, ctx, colo = "EDGE") {
  const fallback = buildRegexMovieMeta(rawTitle);
  if (!env.GEMINI_API_KEY || !rawTitle) return fallback;
  const cacheKey = rawTitle.toLowerCase().trim();
  const cached = POSTER_META_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.meta;
  }
  const prompt = `Từ tên file phim sau: "${rawTitle}". Hãy trích xuất tên phim/anime gốc chuẩn quốc tế (tiếng Anh hoặc tên chính thức để tìm poster), loại ("movie" hoặc "tv" hoặc "anime"), và năm phát hành nếu có. Trả về đúng JSON: {"query":"...","type":"movie","year":""}`;
  const models = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-2.0-flash-lite"];
  for (const modelName of models) {
    try {
      const genCfg = { responseMimeType: "application/json", temperature: 0.1 };
      const res = await callGeminiWithTelemetry(modelName, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: genCfg
      }, 15000, "poster-meta", env, ctx, colo);
      if (res.text) {
        const parsed = JSON.parse(res.text);
        if (parsed && parsed.query) {
          const meta = {
            query: String(parsed.query).trim(),
            type: String(parsed.type || fallback.type),
            year: String(parsed.year || fallback.year || "")
          };
          if (POSTER_META_CACHE.size > 500) {
            const first = POSTER_META_CACHE.keys().next().value;
            if (first) POSTER_META_CACHE.delete(first);
          }
          POSTER_META_CACHE.set(cacheKey, { meta, expiresAt: Date.now() + 86400000 });
          return meta;
        }
      }
      if (res.errorMsg && res.errorMsg.includes("User location is not supported")) {
        break;
      }
    } catch (e) {}
  }
  POSTER_META_CACHE.set(cacheKey, { meta: fallback, expiresAt: Date.now() + 300000 });
  return fallback;
}

async function lookupPosterByMeta(q, type, rawTitle, env) {
  let posterUrl = "";
  let backdropUrl = "";
  let source = "";

  // 1. TMDB (nếu có TMDB_API_KEY) — ưu tiên artwork chuẩn studio gốc (original 2000x3000 & 3840x2160)
  if (!posterUrl && env.TMDB_API_KEY) {
    for (const lang of ["en-US", "vi-VN"]) {
      try {
        const tmdbRes = await fetch(
          `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&query=${encodeURIComponent(q)}&language=${lang}`,
          { signal: AbortSignal.timeout(6000) }
        );
        const tmdbData = await tmdbRes.json();
        const hit = (tmdbData.results || []).find(r => r.poster_path || r.backdrop_path);
        if (hit) {
          if (hit.poster_path) posterUrl = `https://image.tmdb.org/t/p/original${hit.poster_path}`;
          if (hit.backdrop_path) backdropUrl = `https://image.tmdb.org/t/p/original${hit.backdrop_path}`;
          source = "tmdb";
          if (posterUrl) break;
        }
      } catch (e) {}
    }
  }

  // 2. IMDb Suggestion API (Miễn phí, lấy chuẩn UX1280 QL90)
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
        posterUrl = hit.i.imageUrl.replace(/\._V1_.*$/i, "._V1_FMjpg_QL90_UX1280_.jpg");
        source = "imdb";
      }
    } catch (e) {}
  }

  // 3. Jikan (MyAnimeList) cho Anime
  if (!posterUrl && (type === "anime" || /chú thuật|jujutsu|anime|tập/i.test(rawTitle))) {
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

  // 4. iTunes Search API (Poster chuẩn phim lẻ 1200x1800)
  if (!posterUrl) {
    try {
      const itunesRes = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=movie&country=US&limit=1`,
        { headers: { "User-Agent": "CineVerseLotte/1.0" }, signal: AbortSignal.timeout(6000) }
      );
      const itunesData = await itunesRes.json();
      const art = itunesData?.results?.[0]?.artworkUrl100;
      if (art) {
        posterUrl = art.replace(/100x100bb\./i, "1200x1800bb.");
        source = "itunes";
      }
    } catch (e) {}
  }

  // 5. TVMaze API (Miễn phí cho series: lấy cả poster dọc & backdrop 16:9 gốc)
  if (!posterUrl || (!backdropUrl && type === "tv")) {
    try {
      const tvRes = await fetch(
        `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(q)}&embed=images`,
        { signal: AbortSignal.timeout(6000) }
      );
      const tvData = await tvRes.json();
      if (!posterUrl) {
        const img = tvData?.image?.original || tvData?.image?.medium;
        if (img) {
          posterUrl = img;
          source = source || "tvmaze";
        }
      }
      if (!backdropUrl && Array.isArray(tvData?._embedded?.images)) {
        const bgs = tvData._embedded.images
          .filter(x => x.type === "background" && x.resolutions?.original?.url)
          .sort((a, b) => (b.resolutions.original.width || 0) - (a.resolutions.original.width || 0));
        if (bgs[0]?.resolutions?.original?.url) {
          backdropUrl = bgs[0].resolutions.original.url;
        }
      }
    } catch (e) {}
  }

  return { posterUrl, backdropUrl, source };
}

async function handlePosterLookup(request, env, ctx) {
  const url = new URL(request.url);
  const rawTitle = (url.searchParams.get("title") || "").trim();
  if (!rawTitle) return jsonResponse({ ok: false, error: "MISSING_TITLE" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Ưu tiên làm sạch tên bằng regex trước để tiết kiệm Gemini RPM
  const regexMeta = buildRegexMovieMeta(rawTitle);
  let q = regexMeta.query || rawTitle;
  let { posterUrl, backdropUrl, source } = await lookupPosterByMeta(q, regexMeta.type, rawTitle, env);

  // Chỉ gọi Gemini AI trích xuất tên quốc tế khi fast-path regex không tìm được poster
  if (!posterUrl) {
    const colo = request?.cf?.colo || "EDGE";
    const aiMeta = await extractCleanMovieMetaWithAI(rawTitle, env, ctx, colo);
    if (aiMeta.query && aiMeta.query.toLowerCase() !== q.toLowerCase()) {
      q = aiMeta.query;
      ({ posterUrl, backdropUrl, source } = await lookupPosterByMeta(q, aiMeta.type, rawTitle, env));
    }
  }

  const response = new Response(
    JSON.stringify({ ok: Boolean(posterUrl || backdropUrl), query: q, poster: posterUrl, backdrop: backdropUrl, source }),
    {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": (posterUrl || backdropUrl) ? "public, max-age=604800" : "public, max-age=3600",
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
  await cache.put(cacheKey, response.clone());
  return response;
}

const DEFAULT_TOP10_CONFIG = {
  minValidSeconds: 600,
  maxHeartbeatDeltaSec: 90,
  timezone: "Asia/Ho_Chi_Minh",
  tzOffsetMs: 7 * 60 * 60 * 1000,
  excludedAccounts: [
    "test@",
    "qa@",
    "demo@",
    "bot@",
    "noreply@",
    "@test.",
    "@example.",
    "test_",
    "qa_",
    "admin_test",
    "guest_"
  ]
};

function sanitizeRtdbKey(raw = "") {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]\s]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 96);
}

function getVietnamWeekWindow(nowMs = Date.now(), overrideWeekKey = "") {
  const tzOffsetMs = DEFAULT_TOP10_CONFIG.tzOffsetMs;
  let mondayVnUtcMidnightMs;
  const match = String(overrideWeekKey || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const parsed = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const d = new Date(parsed);
    const daysSinceMon = (d.getUTCDay() + 6) % 7;
    mondayVnUtcMidnightMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMon);
  } else {
    const vnDate = new Date(Number(nowMs || Date.now()) + tzOffsetMs);
    const daysSinceMon = (vnDate.getUTCDay() + 6) % 7;
    mondayVnUtcMidnightMs = Date.UTC(
      vnDate.getUTCFullYear(),
      vnDate.getUTCMonth(),
      vnDate.getUTCDate() - daysSinceMon
    );
  }
  const sundayVnUtcMidnightMs = mondayVnUtcMidnightMs + 6 * 86400000;
  const prevMondayVnUtcMidnightMs = mondayVnUtcMidnightMs - 7 * 86400000;

  const fmtIsoDate = (utcMs) => {
    const d = new Date(utcMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const fmtVnOffsetIso = (vnUtcMs) => {
    const d = new Date(vnUtcMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${y}-${m}-${day}T${hh}:${mm}:${ss}+07:00`;
  };

  const monD = new Date(mondayVnUtcMidnightMs);
  const sunD = new Date(sundayVnUtcMidnightMs);
  const sDay = monD.getUTCDate();
  const sMon = monD.getUTCMonth() + 1;
  const sYear = monD.getUTCFullYear();
  const eDay = sunD.getUTCDate();
  const eMon = sunD.getUTCMonth() + 1;
  const eYear = sunD.getUTCFullYear();

  const weekRangeLabel =
    sMon === eMon && sYear === eYear
      ? `${sDay}–${eDay} tháng ${eMon}`
      : sYear === eYear
      ? `${String(sDay).padStart(2, "0")}/${String(sMon).padStart(2, "0")}–${String(eDay).padStart(2, "0")}/${String(eMon).padStart(2, "0")}`
      : `${String(sDay).padStart(2, "0")}/${String(sMon).padStart(2, "0")}/${sYear}–${String(eDay).padStart(2, "0")}/${String(eMon).padStart(2, "0")}/${eYear}`;

  return {
    timezone: DEFAULT_TOP10_CONFIG.timezone,
    weekKey: fmtIsoDate(mondayVnUtcMidnightMs),
    prevWeekKey: fmtIsoDate(prevMondayVnUtcMidnightMs),
    weekStart: fmtVnOffsetIso(mondayVnUtcMidnightMs),
    weekEnd: fmtVnOffsetIso(sundayVnUtcMidnightMs + 86399000),
    weekStartDateLabel: `${String(sDay).padStart(2, "0")}/${String(sMon).padStart(2, "0")}/${sYear}`,
    weekEndDateLabel: `${String(eDay).padStart(2, "0")}/${String(eMon).padStart(2, "0")}/${eYear}`,
    weekRangeLabel
  };
}

function isExcludedTestAccount(accountKey = "", accountEmail = "", excludedPatterns = DEFAULT_TOP10_CONFIG.excludedAccounts) {
  const key = String(accountKey || "").trim().toLowerCase();
  const email = String(accountEmail || "").trim().toLowerCase();
  const target = email || key;
  if (!target) return true;
  if (key.startsWith("guest_") || key.startsWith("anon_") || key === "guest") return true;
  const patterns = Array.isArray(excludedPatterns) && excludedPatterns.length
    ? excludedPatterns
    : DEFAULT_TOP10_CONFIG.excludedAccounts;
  return patterns.some((rawPat) => {
    const pat = String(rawPat || "").trim().toLowerCase();
    if (!pat) return false;
    return target === pat || target.startsWith(pat) || target.includes(pat) || key === pat || key.startsWith(pat);
  });
}

async function loadTop10Config(env, rtdbBase) {
  const cfg = {
    minValidSeconds: DEFAULT_TOP10_CONFIG.minValidSeconds,
    maxHeartbeatDeltaSec: DEFAULT_TOP10_CONFIG.maxHeartbeatDeltaSec,
    timezone: DEFAULT_TOP10_CONFIG.timezone,
    excludedAccounts: [...DEFAULT_TOP10_CONFIG.excludedAccounts]
  };
  const envMinSec = Number(env?.TOP10_MIN_VALID_SECONDS || 0);
  if (Number.isFinite(envMinSec) && envMinSec >= 10) {
    cfg.minValidSeconds = Math.round(envMinSec);
  }
  const envExcl = String(env?.TOP10_EXCLUDED_ACCOUNTS || "").trim();
  if (envExcl) {
    const extras = envExcl.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    cfg.excludedAccounts = Array.from(new Set([...cfg.excludedAccounts, ...extras]));
  }
  try {
    const res = await fetch(`${rtdbBase}/lobby_config/weekly_top10_v1/config.json`, { cache: "no-store" });
    if (res.ok) {
      const remote = await res.json().catch(() => null);
      if (remote && typeof remote === "object") {
        const rMin = Number(remote.minValidSeconds);
        if (Number.isFinite(rMin) && rMin >= 10) cfg.minValidSeconds = Math.round(rMin);
        const rMaxDelta = Number(remote.maxHeartbeatDeltaSec);
        if (Number.isFinite(rMaxDelta) && rMaxDelta >= 5 && rMaxDelta <= 300) {
          cfg.maxHeartbeatDeltaSec = Math.round(rMaxDelta);
        }
        if (Array.isArray(remote.excludedAccounts)) {
          const rExcl = remote.excludedAccounts.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
          cfg.excludedAccounts = Array.from(new Set([...cfg.excludedAccounts, ...rExcl]));
        }
      }
    }
  } catch (_) {}
  return cfg;
}

function computeWeeklyRanking(weekData, config = DEFAULT_TOP10_CONFIG) {
  const minSec = Math.max(10, Number(config?.minValidSeconds || DEFAULT_TOP10_CONFIG.minValidSeconds));
  const excluded = config?.excludedAccounts || DEFAULT_TOP10_CONFIG.excludedAccounts;
  const moviesObj = weekData && typeof weekData === "object" ? (weekData.movies || weekData) : {};
  if (!moviesObj || typeof moviesObj !== "object") return [];

  const ranked = [];
  for (const [safeKey, entry] of Object.entries(moviesObj)) {
    if (!entry || typeof entry !== "object") continue;
    const meta = entry.meta && typeof entry.meta === "object" ? entry.meta : {};
    const movieId = String(meta.movieId || safeKey || "").trim();
    const title = String(meta.title || "").trim();
    if (!movieId || !title) continue;

    const accounts = entry.accounts && typeof entry.accounts === "object" ? entry.accounts : {};
    let validViews = 0;
    let totalQualifiedWatchSec = 0;
    let earliestQualifiedAt = Number.MAX_SAFE_INTEGER;

    for (const [accKey, accRec] of Object.entries(accounts)) {
      if (!accRec || typeof accRec !== "object") continue;
      if (accRec.isGuest) continue;
      if (isExcludedTestAccount(accKey, accRec.emailHint || "", excluded)) continue;
      const watchedSec = Number(accRec.sec || 0);
      if (watchedSec >= minSec) {
        validViews += 1;
        totalQualifiedWatchSec += watchedSec;
        const qualAt = Number(accRec.firstQualifiedAt || accRec.lastBeatAt || Number.MAX_SAFE_INTEGER);
        if (Number.isFinite(qualAt) && qualAt < earliestQualifiedAt) {
          earliestQualifiedAt = qualAt;
        }
      }
    }

    if (validViews <= 0) continue;
    ranked.push({
      safeKey,
      movieId,
      title,
      poster: String(meta.poster || ""),
      genre: String(meta.genre || ""),
      year: String(meta.year || ""),
      lastRoomId: String(meta.lastRoomId || ""),
      validViews,
      totalQualifiedWatchSec,
      earliestQualifiedAt,
      updatedAt: Number(meta.updatedAt || 0)
    });
  }

  // Quy tắc sắp xếp & phá hòa cố định (không bao giờ thay đổi ngẫu nhiên):
  // 1. Lượt xem hợp lệ giảm dần
  // 2. Tổng thời gian xem của các tài khoản đạt chuẩn giảm dần
  // 3. Mốc thời gian đầu tiên có tài khoản đạt chuẩn (tăng dần - sớm hơn đứng trên)
  // 4. movieId theo thứ tự từ điển (tăng dần)
  ranked.sort((a, b) => {
    if (b.validViews !== a.validViews) return b.validViews - a.validViews;
    if (b.totalQualifiedWatchSec !== a.totalQualifiedWatchSec) return b.totalQualifiedWatchSec - a.totalQualifiedWatchSec;
    if (a.earliestQualifiedAt !== b.earliestQualifiedAt) return a.earliestQualifiedAt - b.earliestQualifiedAt;
    return a.movieId.localeCompare(b.movieId, "en");
  });

  return ranked.map((item, idx) => ({
    ...item,
    rank: idx + 1
  }));
}

function buildTop10ApiPayload(currentWeekData, prevWeekData, weekWindow, config, nowMs = Date.now()) {
  const currentRanked = computeWeeklyRanking(currentWeekData, config);
  const prevRanked = computeWeeklyRanking(prevWeekData, config);
  const hasPreviousWeekData = prevRanked.length > 0;
  const prevRankMap = new Map(prevRanked.map((item) => [item.movieId, item.rank]));

  let latestUpdatedAt = Number(currentWeekData?.updatedAt || 0);
  currentRanked.forEach((m) => {
    if (m.updatedAt > latestUpdatedAt) latestUpdatedAt = m.updatedAt;
  });
  if (!latestUpdatedAt) latestUpdatedAt = nowMs;

  const minValidSeconds = Number(config?.minValidSeconds || DEFAULT_TOP10_CONFIG.minValidSeconds);
  const minValidMinutes = Math.round((minValidSeconds / 60) * 10) / 10;

  const items = currentRanked.slice(0, 10).map((item) => {
    let movementType = "none";
    let movementLabel = "";
    let delta = null;
    if (hasPreviousWeekData) {
      if (!prevRankMap.has(item.movieId)) {
        movementType = "new";
        movementLabel = "Mới";
      } else {
        const prevRank = prevRankMap.get(item.movieId);
        delta = prevRank - item.rank;
        if (delta > 0) {
          movementType = "up";
          movementLabel = `↑ ${delta} bậc`;
        } else if (delta < 0) {
          movementType = "down";
          movementLabel = `↓ ${Math.abs(delta)} bậc`;
        } else {
          movementType = "same";
          movementLabel = "—";
        }
      }
    }
    return {
      rank: item.rank,
      movieId: item.movieId,
      title: item.title,
      poster: item.poster,
      genre: item.genre,
      year: item.year,
      lastRoomId: item.lastRoomId,
      validViews: item.validViews,
      totalQualifiedWatchSec: item.totalQualifiedWatchSec,
      delta,
      movementType,
      movementLabel
    };
  });

  return {
    ok: true,
    board: "cineverse_weekly",
    boardLabel: "Được xem nhiều trong CineVerse",
    timezone: weekWindow.timezone,
    weekKey: weekWindow.weekKey,
    prevWeekKey: weekWindow.prevWeekKey,
    weekStart: weekWindow.weekStart,
    weekEnd: weekWindow.weekEnd,
    weekStartDateLabel: weekWindow.weekStartDateLabel,
    weekEndDateLabel: weekWindow.weekEndDateLabel,
    weekRangeLabel: weekWindow.weekRangeLabel,
    updatedAt: latestUpdatedAt,
    updatedAtIso: new Date(latestUpdatedAt + DEFAULT_TOP10_CONFIG.tzOffsetMs).toISOString().replace("Z", "+07:00"),
    config: {
      minValidSeconds,
      minValidMinutes,
      oneViewPerAccountPerMoviePerWeek: true,
      testAccountsExcluded: true,
      tieBreakerOrder: [
        "validViews DESC",
        "totalQualifiedWatchSec DESC",
        "earliestQualifiedAt ASC",
        "movieId ASC"
      ]
    },
    hasPreviousWeekData,
    totalEligibleMovies: currentRanked.length,
    items
  };
}

async function handleTop10HeartbeatRequest(request, env, corsHdrs) {
  try {
    const body = await request.json().catch(() => ({}));
    const movieId = String(body.movieId || "").trim();
    const title = String(body.title || "").trim().slice(0, 140);
    const poster = String(body.poster || "").trim().slice(0, 500);
    const genre = String(body.genre || "").trim().slice(0, 120);
    const year = String(body.year || "").trim().slice(0, 16);
    const roomId = String(body.roomId || "").trim().slice(0, 32);
    const accountKeyRaw = String(body.accountEmail || body.accountKey || "").trim().toLowerCase();
    const accountEmail = String(body.accountEmail || "").trim().toLowerCase();
    const isGuest = Boolean(body.isGuest);

    if (!movieId || !title) {
      return new Response(JSON.stringify({ ok: false, error: "MISSING_MOVIE_INFO" }), {
        status: 400,
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
      });
    }
    if (isGuest || !accountKeyRaw || !accountEmail) {
      return new Response(JSON.stringify({ ok: false, ignored: true, reason: "GUEST_OR_UNAUTHENTICATED" }), {
        status: 200,
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const rtdbBase = String(env?.FIREBASE_RTDB_URL || "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, "");
    const config = await loadTop10Config(env, rtdbBase);

    if (isExcludedTestAccount(accountKeyRaw, accountEmail, config.excludedAccounts)) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: "EXCLUDED_TEST_ACCOUNT" }), {
        status: 200,
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const nowMs = Date.now();
    const weekWindow = getVietnamWeekWindow(nowMs);
    const safeMovieKey = sanitizeRtdbKey(movieId);
    const safeAccountKey = sanitizeRtdbKey(accountKeyRaw);
    if (!safeMovieKey || !safeAccountKey) {
      return new Response(JSON.stringify({ ok: false, error: "INVALID_KEY" }), {
        status: 400,
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const moviePath = `${rtdbBase}/lobby_config/weekly_top10_v1/weeks/${encodeURIComponent(weekWindow.weekKey)}/movies/${encodeURIComponent(safeMovieKey)}`;
    const accUrl = `${moviePath}/accounts/${encodeURIComponent(safeAccountKey)}.json`;

    const existingRes = await fetch(accUrl, { cache: "no-store" });
    const existing = existingRes.ok ? await existingRes.json().catch(() => null) : null;

    const requestedDelta = Math.max(1, Math.min(config.maxHeartbeatDeltaSec, Math.round(Number(body.deltaSec) || 0)));
    let safeDelta = requestedDelta;
    if (existing && Number(existing.lastBeatAt) > 0) {
      const elapsedSec = Math.max(0, Math.floor((nowMs - Number(existing.lastBeatAt)) / 1000));
      const maxAllowed = Math.min(config.maxHeartbeatDeltaSec, elapsedSec + 5);
      safeDelta = Math.min(requestedDelta, Math.max(0, maxAllowed));
    }

    const prevSec = Number(existing?.sec || 0);
    const nextSec = prevSec + safeDelta;
    const qualified = nextSec >= config.minValidSeconds;
    const firstQualifiedAt = qualified
      ? (Number(existing?.firstQualifiedAt || 0) > 0 ? Number(existing.firstQualifiedAt) : nowMs)
      : 0;

    const accPayload = {
      sec: nextSec,
      qualified,
      firstQualifiedAt,
      lastBeatAt: nowMs,
      emailHint: accountEmail.slice(0, 80)
    };
    const metaPayload = {
      movieId,
      title,
      poster,
      genre,
      year,
      lastRoomId: roomId,
      updatedAt: nowMs
    };

    await Promise.all([
      fetch(accUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accPayload)
      }),
      fetch(`${moviePath}/meta.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metaPayload)
      }),
      fetch(`${rtdbBase}/lobby_config/weekly_top10_v1/weeks/${encodeURIComponent(weekWindow.weekKey)}/updatedAt.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nowMs)
      })
    ]);

    return new Response(
      JSON.stringify({
        ok: true,
        weekKey: weekWindow.weekKey,
        watchedSec: nextSec,
        qualified,
        minValidSeconds: config.minValidSeconds
      }),
      { status: 200, headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
    });
  }
}

async function handleTop10WeeklyGetRequest(request, env, corsHdrs) {
  try {
    const reqUrl = new URL(request.url);
    const overrideWeekKey = String(reqUrl.searchParams.get("week") || "").trim();
    const nowMs = Date.now();
    const weekWindow = getVietnamWeekWindow(nowMs, overrideWeekKey);
    const rtdbBase = String(env?.FIREBASE_RTDB_URL || "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, "");

    const [config, curRes, prevRes] = await Promise.all([
      loadTop10Config(env, rtdbBase),
      fetch(`${rtdbBase}/lobby_config/weekly_top10_v1/weeks/${encodeURIComponent(weekWindow.weekKey)}.json`, { cache: "no-store" }),
      fetch(`${rtdbBase}/lobby_config/weekly_top10_v1/weeks/${encodeURIComponent(weekWindow.prevWeekKey)}.json`, { cache: "no-store" })
    ]);

    if (!curRes.ok) {
      return new Response(JSON.stringify({ ok: false, error: `RTDB_${curRes.status}` }), {
        status: 502,
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const currentWeekData = await curRes.json().catch(() => null);
    const prevWeekData = prevRes.ok ? await prevRes.json().catch(() => null) : null;
    const payload = buildTop10ApiPayload(currentWeekData, prevWeekData, weekWindow, config, nowMs);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHdrs,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30, s-maxage=30"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8" }
    });
  }
}

export {
  DEFAULT_TOP10_CONFIG,
  sanitizeRtdbKey,
  getVietnamWeekWindow,
  isExcludedTestAccount,
  computeWeeklyRanking,
  buildTop10ApiPayload,
  DEFAULT_WATCH_PARTY_CONFIG,
  computeWatchPartyEndsAt,
  getWatchPartyMemberStats,
  isAccountApprovedForWatchParty,
  provisionWatchPartyRoomOnServer,
  closeWatchPartyEventOnServer,
  reconcileSingleWatchParty,
  reconcileAllWatchParties,
  handleWatchPartyCreate,
  handleWatchPartyUpdate,
  handleWatchPartyRsvp,
  handleWatchPartyApprove,
  handleWatchPartyEnter,
  handleWatchPartyEndGroup,
  handleWatchPartyRetryRoom,
  handleWatchPartyList,
  handleWatchPartyInviteGet,
  handleWatchPartyRoomGet
};

// =========================================================
// WATCH PARTY ("HẸN XEM CÙNG BẠN BÈ") — SERVER ENGINE
// =========================================================
const DEFAULT_WATCH_PARTY_CONFIG = {
  defaultBufferMinutes: 10,
  minBufferMinutes: 0,
  maxBufferMinutes: 30,
  maxRetries: 3,
  timezone: "Asia/Ho_Chi_Minh",
  roomTypes: {
    private_cinema: { key: "private_cinema", label: "Buổi xem riêng", minCap: 2, maxCap: 48, isCoupleRoom: false, isDiscordRoom: false },
    sweetbox: { key: "sweetbox", label: "Sweetbox", minCap: 2, maxCap: 2, isCoupleRoom: true, isDiscordRoom: false },
    stream_party: { key: "stream_party", label: "Phòng Stream Nhóm", minCap: 2, maxCap: 10, isCoupleRoom: false, isDiscordRoom: true }
  }
};

const WP_EVENT_LOCKS = new Map();

async function withWatchPartyLock(eventId, fn) {
  const key = String(eventId || "global");
  const prev = WP_EVENT_LOCKS.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((res) => { release = res; });
  const tail = prev.then(() => gate).catch(() => gate);
  WP_EVENT_LOCKS.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (WP_EVENT_LOCKS.get(key) === tail) {
      WP_EVENT_LOCKS.delete(key);
    }
  }
}

function wpJson(payload, status = 200, corsHdrs = CORS_HEADERS) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function getWatchPartyRtdbBase(env) {
  return String(env?.FIREBASE_RTDB_URL || "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, "");
}

async function loadWatchPartyConfig(env, rtdbBase) {
  const cfg = {
    defaultBufferMinutes: DEFAULT_WATCH_PARTY_CONFIG.defaultBufferMinutes,
    maxRetries: DEFAULT_WATCH_PARTY_CONFIG.maxRetries,
    timezone: DEFAULT_WATCH_PARTY_CONFIG.timezone,
    roomTypes: DEFAULT_WATCH_PARTY_CONFIG.roomTypes
  };
  const envBuf = Number(env?.WATCH_PARTY_BUFFER_MINUTES);
  if (Number.isFinite(envBuf) && envBuf >= 0 && envBuf <= 30) {
    cfg.defaultBufferMinutes = Math.round(envBuf);
  }
  try {
    const res = await fetch(`${rtdbBase}/lobby_config/watch_parties_v1/config.json`, { cache: "no-store" });
    if (res.ok) {
      const remote = await res.json().catch(() => null);
      if (remote && typeof remote === "object") {
        const rBuf = Number(remote.defaultBufferMinutes);
        if (Number.isFinite(rBuf) && rBuf >= 0 && rBuf <= 30) cfg.defaultBufferMinutes = Math.round(rBuf);
        const rMaxRet = Number(remote.maxRetries);
        if (Number.isFinite(rMaxRet) && rMaxRet >= 1 && rMaxRet <= 10) cfg.maxRetries = Math.round(rMaxRet);
      }
    }
  } catch (_) {}
  return cfg;
}

function randomAlphaNum(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function generateInviteToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateEventId() {
  return `ev_${Date.now().toString(36)}_${randomAlphaNum(6).toLowerCase()}`;
}

function generateInviteCode() {
  return `CV-${randomAlphaNum(4)}`;
}

function computeWatchPartyEndsAt(startsAtMs, durationSec, bufferMinutes = DEFAULT_WATCH_PARTY_CONFIG.defaultBufferMinutes) {
  const start = Number(startsAtMs) || 0;
  const durMs = Math.max(30, Math.round(Number(durationSec) || 0)) * 1000;
  const bufMs = Math.max(0, Math.round(Number(bufferMinutes) || 0)) * 60 * 1000;
  return start + durMs + bufMs;
}

function getWatchPartyMemberStats(event) {
  const membersObj = event && typeof event.members === "object" && event.members ? event.members : {};
  let approvedGoingCount = 0;
  let pendingCount = 0;
  let maybeCount = 0;
  let declinedCount = 0;
  let hasOrganizerEntry = false;

  for (const [k, m] of Object.entries(membersObj)) {
    if (!m || typeof m !== "object") continue;
    if (k === event.organizerId || m.isOrganizer) hasOrganizerEntry = true;
    const rsvp = String(m.rsvp || "");
    const apv = String(m.approvalStatus || "");
    if (apv === "approved" && rsvp === "going") approvedGoingCount += 1;
    else if (apv === "pending" && (rsvp === "going" || rsvp === "maybe")) pendingCount += 1;
    if (rsvp === "maybe") maybeCount += 1;
    if (rsvp === "declined") declinedCount += 1;
  }

  // Bảo đảm người tổ chức luôn được tính vào sức chứa thực
  if (!hasOrganizerEntry && event?.organizerId) {
    approvedGoingCount += 1;
  }

  const capacity = Math.max(2, Number(event?.capacity || 2));
  const remainingSlots = Math.max(0, capacity - approvedGoingCount);
  return {
    approvedGoingCount,
    pendingCount,
    maybeCount,
    declinedCount,
    capacity,
    remainingSlots,
    isFull: remainingSlots <= 0
  };
}

function isAccountApprovedForWatchParty(event, accountKey = "") {
  const cleanKey = sanitizeRtdbKey(accountKey);
  if (!event || !cleanKey) return false;
  if (cleanKey === event.organizerId) return true;
  const member = event.members?.[cleanKey];
  if (!member) return false;
  return member.approvalStatus === "approved" && member.rsvp === "going";
}

function formatWatchPartyEventForClient(event, viewerAccountKey = "", serverNow = Date.now()) {
  if (!event || typeof event !== "object") return null;
  const cleanViewer = sanitizeRtdbKey(viewerAccountKey);
  const stats = getWatchPartyMemberStats(event);
  const isOrganizer = Boolean(cleanViewer && cleanViewer === event.organizerId);
  const viewerMember = cleanViewer ? (event.members?.[cleanViewer] || null) : null;
  const approvedMembers = [];
  const pendingRequests = [];
  const allMembers = [];

  for (const m of Object.values(event.members || {})) {
    if (!m || typeof m !== "object") continue;
    const safeMember = {
      accountKey: m.accountKey,
      name: m.name || "Khán giả",
      rsvp: m.rsvp || "pending",
      approvalStatus: m.approvalStatus || "pending",
      isOrganizer: Boolean(m.isOrganizer),
      respondedAt: Number(m.respondedAt || 0)
    };
    allMembers.push(safeMember);
    if (safeMember.approvalStatus === "approved" && safeMember.rsvp === "going") {
      approvedMembers.push(safeMember);
    } else if (safeMember.approvalStatus === "pending" && (safeMember.rsvp === "going" || safeMember.rsvp === "maybe")) {
      pendingRequests.push(safeMember);
    }
  }

  approvedMembers.sort((a, b) => (b.isOrganizer ? 1 : 0) - (a.isOrganizer ? 1 : 0) || a.respondedAt - b.respondedAt);

  return {
    eventId: event.eventId,
    organizerId: event.organizerId,
    organizerName: event.organizerName || "Chủ buổi hẹn",
    movieId: event.movieId,
    movieTitle: event.movieTitle,
    poster: event.poster || "assets/web-logo.png",
    videoUrl: isAccountApprovedForWatchParty(event, cleanViewer) ? (event.videoUrl || "") : "",
    youtubeId: isAccountApprovedForWatchParty(event, cleanViewer) ? (event.youtubeId || "") : "",
    genre: event.genre || "Điện ảnh • Chiếu riêng",
    ageRating: event.ageRating || "T13+",
    year: event.year || "",
    durationSec: Number(event.durationSec || 0),
    bufferMinutes: Number(event.bufferMinutes ?? DEFAULT_WATCH_PARTY_CONFIG.defaultBufferMinutes),
    startsAt: Number(event.startsAt || 0),
    endsAt: Number(event.endsAt || 0),
    timezone: event.timezone || DEFAULT_WATCH_PARTY_CONFIG.timezone,
    roomType: event.roomType || "private_cinema",
    roomTypeLabel: DEFAULT_WATCH_PARTY_CONFIG.roomTypes[event.roomType]?.label || "Buổi xem riêng",
    capacity: stats.capacity,
    approvedCount: stats.approvedGoingCount,
    pendingCount: stats.pendingCount,
    remainingSlots: stats.remainingSlots,
    isFull: stats.isFull,
    visibility: event.visibility || "invite_approval",
    status: event.status || "scheduled",
    roomId: isAccountApprovedForWatchParty(event, cleanViewer) && event.status === "open" ? (event.roomId || "") : "",
    scheduleVersion: Number(event.scheduleVersion || 1),
    inviteCode: event.inviteCode || "",
    inviteToken: isOrganizer ? (event.inviteToken || "") : undefined,
    inviteRevoked: Boolean(event.inviteRevoked),
    lastError: event.lastError || "",
    retryCount: Number(event.retryCount || 0),
    endedAt: Number(event.endedAt || 0),
    endedReason: event.endedReason || "",
    createdAt: Number(event.createdAt || 0),
    updatedAt: Number(event.updatedAt || 0),
    isOrganizer,
    canEnterRoom: Boolean(event.status === "open" && isAccountApprovedForWatchParty(event, cleanViewer)),
    myMember: viewerMember
      ? {
          accountKey: viewerMember.accountKey,
          name: viewerMember.name || "",
          rsvp: viewerMember.rsvp,
          approvalStatus: viewerMember.approvalStatus,
          isOrganizer: Boolean(viewerMember.isOrganizer)
        }
      : null,
    approvedMembers,
    pendingRequests: isOrganizer ? pendingRequests : [],
    serverNow
  };
}

async function rtdbFetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`RTDB_READ_${res.status}`);
  return await res.json().catch(() => null);
}

async function rtdbPutJson(url, data) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`RTDB_WRITE_${res.status}`);
  return data;
}

async function rtdbDeletePath(url) {
  await fetch(url, { method: "DELETE" }).catch(() => {});
}

async function provisionWatchPartyRoomOnServer(env, rtdbBase, eventInput, serverNow = Date.now(), expectedVersion = null) {
  const eventId = String(eventInput?.eventId || "").trim();
  if (!eventId) return { ok: false, skipped: true, reason: "MISSING_EVENT_ID" };

  return await withWatchPartyLock(eventId, async () => {
    const eventUrl = `${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`;
    const event = (await rtdbFetchJson(eventUrl)) || eventInput;
    if (!event || !event.eventId) return { ok: false, skipped: true, reason: "EVENT_NOT_FOUND" };

    if (expectedVersion !== null && Number(event.scheduleVersion || 1) !== Number(expectedVersion)) {
      return { ok: false, skipped: true, reason: "STALE_SCHEDULE_VERSION", currentVersion: event.scheduleVersion };
    }
    if (event.status === "cancelled" || event.status === "ended") {
      return { ok: false, skipped: true, reason: `EVENT_ALREADY_${event.status.toUpperCase()}` };
    }
    if (serverNow >= Number(event.endsAt || 0)) {
      return await closeWatchPartyEventOnServerUnsafe(rtdbBase, event, "expired", serverNow);
    }
    if (serverNow < Number(event.startsAt || 0)) {
      return { ok: false, skipped: true, reason: "NOT_STARTED_YET" };
    }

    const roomId = event.roomId && String(event.roomId).startsWith("wp_")
      ? String(event.roomId)
      : `wp_${eventId}`;

    // Idempotent: nếu phòng đã mở đúng roomId + scheduleVersion rồi -> không tạo lại trùng
    const roomUrl = `${rtdbBase}/lobby_config/watch_parties_v1/rooms/${encodeURIComponent(roomId)}.json`;
    const existingRoom = await rtdbFetchJson(roomUrl).catch(() => null);
    if (
      event.status === "open" &&
      existingRoom &&
      existingRoom.eventId === eventId &&
      Number(existingRoom.scheduleVersion || 1) === Number(event.scheduleVersion || 1) &&
      !existingRoom.closed
    ) {
      return { ok: true, idempotent: true, roomId, event, room: existingRoom };
    }

    const cfg = await loadWatchPartyConfig(env, rtdbBase);
    if (Number(event.retryCount || 0) >= cfg.maxRetries && event.status === "create_failed" && !eventInput?._manualRetry) {
      return { ok: false, skipped: true, reason: "MAX_RETRIES_EXCEEDED", event };
    }

    try {
      // Trạng thái chuyển tiếp "creating" theo state machine
      event.status = "creating";
      event.updatedAt = serverNow;
      await rtdbPutJson(eventUrl, event);

      const typeMeta = DEFAULT_WATCH_PARTY_CONFIG.roomTypes[event.roomType] || DEFAULT_WATCH_PARTY_CONFIG.roomTypes.private_cinema;
      const roomPayload = {
        id: roomId,
        roomId,
        eventId,
        isWatchParty: true,
        isPrivate: true,
        number: event.inviteCode ? `Phòng Riêng ${event.inviteCode}` : "Phòng Hẹn Riêng",
        movieId: event.movieId || "",
        movieTitle: event.movieTitle || "Buổi chiếu riêng",
        poster: event.poster || "assets/web-logo.png",
        videoUrl: event.youtubeId ? "" : (event.videoUrl || ""),
        youtubeId: event.youtubeId || "",
        genre: event.genre || "Điện ảnh • Phòng Riêng",
        ageRating: event.ageRating || "T13+",
        year: event.year || "",
        durationSec: Number(event.durationSec || 0),
        roomType: event.roomType || "private_cinema",
        isCoupleRoom: Boolean(typeMeta.isCoupleRoom),
        isDiscordRoom: Boolean(typeMeta.isDiscordRoom),
        maxSeats: Number(event.capacity || typeMeta.maxCap || 48),
        isCustomStartZero: true,
        cinemaScheduleMode: true,
        allowSeek: false,
        status: "showing",
        closed: false,
        organizerId: event.organizerId,
        organizerName: event.organizerName || "Chủ buổi hẹn",
        startsAt: Number(event.startsAt || 0),
        endsAt: Number(event.endsAt || 0),
        scheduleVersion: Number(event.scheduleVersion || 1),
        createdAt: Number(existingRoom?.createdAt || serverNow),
        updatedAt: serverNow
      };

      const elapsedSinceStartSec = Math.max(0, (serverNow - Number(event.startsAt || serverNow)) / 1000);
      const initialSyncPayload = {
        youtubeId: roomPayload.youtubeId,
        videoUrl: roomPayload.videoUrl,
        movieTitle: roomPayload.movieTitle,
        poster: roomPayload.poster,
        isPlaying: true,
        currentTime: elapsedSinceStartSec,
        action: "play",
        cinemaScheduleMode: true,
        allowSeek: false,
        startsAt: roomPayload.startsAt,
        roomClosed: false,
        endsAt: roomPayload.endsAt,
        scheduleVersion: roomPayload.scheduleVersion,
        uid: event.organizerUid || event.organizerId,
        userName: event.organizerName || "Chủ buổi hẹn",
        updatedAt: serverNow
      };

      const initialHostPayload = {
        uid: event.organizerUid || event.organizerId,
        accountKey: event.organizerId,
        userName: event.organizerName || "Chủ buổi hẹn",
        claimedAt: serverNow,
        updatedAt: serverNow
      };

      await Promise.all([
        rtdbPutJson(roomUrl, roomPayload),
        rtdbPutJson(`${rtdbBase}/sync/${encodeURIComponent(roomId)}.json`, initialSyncPayload),
        rtdbPutJson(`${rtdbBase}/host/${encodeURIComponent(roomId)}.json`, initialHostPayload)
      ]);

      event.status = "open";
      event.roomId = roomId;
      event.roomCreatedAt = event.roomCreatedAt || serverNow;
      event.lastError = "";
      event.updatedAt = serverNow;
      await rtdbPutJson(eventUrl, event);

      return { ok: true, idempotent: false, roomId, event, room: roomPayload };
    } catch (err) {
      const nextRetry = Number(event.retryCount || 0) + 1;
      event.retryCount = nextRetry;
      event.lastError = String(err?.message || err || "PROVISION_FAILED");
      event.status = "create_failed";
      event.updatedAt = serverNow;
      await rtdbPutJson(eventUrl, event).catch(() => {});
      return { ok: false, error: event.lastError, retryCount: nextRetry, event };
    }
  });
}

async function closeWatchPartyEventOnServerUnsafe(rtdbBase, eventInput, reason = "ended", serverNow = Date.now(), expectedVersion = null) {
  const eventId = String(eventInput?.eventId || "").trim();
  if (!eventId) return { ok: false, skipped: true };

  const eventUrl = `${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`;
  const event = (await rtdbFetchJson(eventUrl)) || eventInput;
  if (!event) return { ok: false, skipped: true };

  if (expectedVersion !== null && Number(event.scheduleVersion || 1) !== Number(expectedVersion)) {
    return { ok: false, skipped: true, reason: "STALE_SCHEDULE_VERSION" };
  }
  if (event.status === "ended" && event.roomCleanedUp === true) {
    return { ok: true, idempotent: true, event };
  }

  const roomId = event.roomId || `wp_${eventId}`;
  const roomUrl = `${rtdbBase}/lobby_config/watch_parties_v1/rooms/${encodeURIComponent(roomId)}.json`;
  const existingRoom = await rtdbFetchJson(roomUrl).catch(() => null);

  if (existingRoom) {
    await rtdbPutJson(roomUrl, {
      ...existingRoom,
      status: "ended",
      closed: true,
      closedAt: serverNow,
      closedReason: reason,
      videoUrl: "",
      youtubeId: ""
    }).catch(() => {});
  }

  await rtdbPutJson(`${rtdbBase}/sync/${encodeURIComponent(roomId)}.json`, {
    isPlaying: false,
    currentTime: 0,
    roomClosed: true,
    closedReason: reason === "organizer_ended" ? "Chủ buổi hẹn đã kết thúc buổi chiếu" : "Buổi chiếu đã kết thúc",
    endsAt: Number(event.endsAt || 0),
    scheduleVersion: Number(event.scheduleVersion || 1),
    updatedAt: serverNow
  }).catch(() => {});

  const encRoom = encodeURIComponent(roomId);
  await Promise.all([
    rtdbDeletePath(`${rtdbBase}/seats/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/host/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/voice/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/typing/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/webrtc_voice/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/webrtc_screen/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/webrtc_cam/${encRoom}.json`),
    rtdbDeletePath(`${rtdbBase}/reactions/${encRoom}.json`)
  ]);

  const updatedEvent = {
    ...event,
    status: "ended",
    roomCleanedUp: true,
    endedAt: Number(event.endedAt || serverNow),
    endedReason: reason,
    updatedAt: serverNow
  };
  await rtdbPutJson(eventUrl, updatedEvent);
  return { ok: true, idempotent: false, roomId, event: updatedEvent };
}

async function closeWatchPartyEventOnServer(env, rtdbBase, eventInput, reason = "ended", serverNow = Date.now(), expectedVersion = null) {
  const eventId = String(eventInput?.eventId || "").trim();
  if (!eventId) return { ok: false, skipped: true };
  return await withWatchPartyLock(eventId, async () => {
    return await closeWatchPartyEventOnServerUnsafe(rtdbBase, eventInput, reason, serverNow, expectedVersion);
  });
}

async function reconcileSingleWatchParty(env, rtdbBase, event, serverNow = Date.now(), expectedVersion = null) {
  if (!event || !event.eventId) return { ok: false, skipped: true };
  if (expectedVersion !== null && Number(event.scheduleVersion || 1) !== Number(expectedVersion)) {
    return { ok: false, skipped: true, reason: "STALE_SCHEDULE_VERSION" };
  }
  if (event.status === "cancelled") {
    return { ok: true, skipped: true, reason: "CANCELLED", event };
  }
  if (serverNow >= Number(event.endsAt || 0)) {
    return await closeWatchPartyEventOnServer(env, rtdbBase, event, "expired", serverNow, expectedVersion);
  }
  if (event.status === "ended") {
    if (!event.roomCleanedUp) {
      return await closeWatchPartyEventOnServer(env, rtdbBase, event, event.endedReason || "ended", serverNow, expectedVersion);
    }
    return { ok: true, idempotent: true, event };
  }
  if (serverNow >= Number(event.startsAt || 0) && (event.status === "scheduled" || event.status === "create_failed" || event.status === "creating" || event.status === "open")) {
    return await provisionWatchPartyRoomOnServer(env, rtdbBase, event, serverNow, expectedVersion);
  }
  return { ok: true, action: "none", event };
}

async function reconcileAllWatchParties(env, serverNow = Date.now()) {
  const rtdbBase = getWatchPartyRtdbBase(env);
  const eventsObj = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events.json`).catch(() => null);
  if (!eventsObj || typeof eventsObj !== "object") {
    return { ok: true, checked: 0, opened: 0, closed: 0 };
  }
  let checked = 0;
  let opened = 0;
  let closed = 0;

  for (const ev of Object.values(eventsObj)) {
    if (!ev || !ev.eventId) continue;
    checked += 1;
    if (ev.status === "cancelled") continue;
    if (ev.status === "ended" && ev.roomCleanedUp) continue;
    const res = await reconcileSingleWatchParty(env, rtdbBase, ev, serverNow);
    if (res?.ok && !res.idempotent && res.event?.status === "open") opened += 1;
    if (res?.ok && !res.idempotent && res.event?.status === "ended") closed += 1;
  }
  return { ok: true, checked, opened, closed };
}

function getValidatedActorAccount(body = {}) {
  const email = String(body.accountEmail || body.organizerEmail || body.email || "").trim().toLowerCase();
  const uid = String(body.uid || "").trim();
  const name = String(body.userName || body.displayName || "").trim().slice(0, 40);
  const accountKey = sanitizeRtdbKey(email || body.accountKey || "");
  if (!email || !accountKey || isExcludedTestAccount(accountKey, email, ["guest_", "anon_"])) {
    return null;
  }
  return {
    accountKey,
    email,
    uid: uid || accountKey,
    name: name || email.split("@")[0]
  };
}

async function handleWatchPartyCreate(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    if (!actor) {
      return wpJson({ ok: false, error: "AUTH_REQUIRED" }, 401, corsHdrs);
    }

    const movieId = String(body.movieId || "").trim();
    const movieTitle = String(body.movieTitle || "").trim().slice(0, 140);
    const durationSec = Math.round(Number(body.durationSec || 0));
    const startsAt = Math.round(Number(body.startsAt || 0));
    const roomType = DEFAULT_WATCH_PARTY_CONFIG.roomTypes[body.roomType] ? body.roomType : "private_cinema";
    const typeMeta = DEFAULT_WATCH_PARTY_CONFIG.roomTypes[roomType];
    const requestedCap = Math.round(Number(body.capacity || typeMeta.maxCap));
    const capacity = Math.min(typeMeta.maxCap, Math.max(typeMeta.minCap, requestedCap));
    const visibility = body.visibility === "invite_direct" ? "invite_direct" : "invite_approval";

    if (!movieId || !movieTitle) {
      return wpJson({ ok: false, error: "MISSING_MOVIE" }, 400, corsHdrs);
    }
    if (!Number.isFinite(durationSec) || durationSec < 30 || durationSec > 36000) {
      return wpJson({ ok: false, error: "INVALID_DURATION_SECONDS" }, 400, corsHdrs);
    }
    if (!Number.isFinite(startsAt) || startsAt < serverNow - 15000) {
      return wpJson({ ok: false, error: "INVALID_STARTS_AT" }, 400, corsHdrs);
    }

    const rtdbBase = getWatchPartyRtdbBase(env);
    const clientRequestId = String(body.clientRequestId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    if (clientRequestId) {
      const idemKey = `${actor.accountKey}__${clientRequestId}`;
      const existingIdem = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/idempotency/${encodeURIComponent(idemKey)}.json`).catch(() => null);
      if (existingIdem?.eventId) {
        const existingEv = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(existingIdem.eventId)}.json`).catch(() => null);
        if (existingEv && existingEv.organizerId === actor.accountKey) {
          return wpJson({
            ok: true,
            idempotent: true,
            event: formatWatchPartyEventForClient(existingEv, actor.accountKey, serverNow),
            serverNow
          }, 200, corsHdrs);
        }
      }
    }

    const cfg = await loadWatchPartyConfig(env, rtdbBase);
    const bufferMinutes = Number.isFinite(Number(body.bufferMinutes))
      ? Math.min(30, Math.max(0, Math.round(Number(body.bufferMinutes))))
      : cfg.defaultBufferMinutes;
    const endsAt = computeWatchPartyEndsAt(startsAt, durationSec, bufferMinutes);

    const eventId = generateEventId();
    const inviteCode = generateInviteCode();
    const inviteToken = generateInviteToken();

    const eventDoc = {
      eventId,
      clientRequestId: clientRequestId || "",
      organizerId: actor.accountKey,
      organizerEmail: actor.email,
      organizerUid: actor.uid,
      organizerName: actor.name,
      movieId,
      movieTitle,
      poster: String(body.poster || "").trim().slice(0, 500),
      videoUrl: String(body.videoUrl || "").trim().slice(0, 800),
      youtubeId: String(body.youtubeId || "").trim().slice(0, 40),
      genre: String(body.genre || "").trim().slice(0, 120),
      ageRating: String(body.ageRating || "T13+").trim().slice(0, 16),
      year: String(body.year || "").trim().slice(0, 12),
      durationSec,
      bufferMinutes,
      startsAt,
      endsAt,
      timezone: cfg.timezone,
      roomType,
      capacity,
      visibility,
      status: "scheduled",
      roomId: `wp_${eventId}`,
      scheduleVersion: 1,
      inviteCode,
      inviteToken,
      inviteRevoked: false,
      retryCount: 0,
      lastError: "",
      roomCleanedUp: false,
      createdAt: serverNow,
      updatedAt: serverNow,
      members: {
        [actor.accountKey]: {
          accountKey: actor.accountKey,
          email: actor.email,
          uid: actor.uid,
          name: actor.name,
          rsvp: "going",
          approvalStatus: "approved",
          isOrganizer: true,
          respondedAt: serverNow,
          updatedAt: serverNow
        }
      }
    };

    const writeOps = [
      rtdbPutJson(`${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`, eventDoc),
      rtdbPutJson(`${rtdbBase}/lobby_config/watch_parties_v1/invites/${encodeURIComponent(inviteToken)}.json`, {
        eventId,
        inviteCode,
        revoked: false,
        createdAt: serverNow
      })
    ];
    if (clientRequestId) {
      const idemKey = `${actor.accountKey}__${clientRequestId}`;
      writeOps.push(
        rtdbPutJson(`${rtdbBase}/lobby_config/watch_parties_v1/idempotency/${encodeURIComponent(idemKey)}.json`, {
          eventId,
          organizerId: actor.accountKey,
          createdAt: serverNow
        })
      );
    }
    await Promise.all(writeOps);

    // Nếu người tổ chức chọn bắt đầu ngay lập tức (startsAt <= serverNow), mở phòng ngay
    if (serverNow >= startsAt) {
      const rec = await reconcileSingleWatchParty(env, rtdbBase, eventDoc, serverNow, eventDoc.scheduleVersion);
      return wpJson({
        ok: true,
        event: formatWatchPartyEventForClient(rec?.event || eventDoc, actor.accountKey, serverNow),
        serverNow
      }, 201, corsHdrs);
    }

    return wpJson({
      ok: true,
      event: formatWatchPartyEventForClient(eventDoc, actor.accountKey, serverNow),
      serverNow
    }, 201, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyUpdate(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    const eventId = String(body.eventId || "").trim();
    const action = String(body.action || "edit").trim(); // "edit" | "cancel" | "regenerate_link" | "revoke_link"
    if (!actor || !eventId) {
      return wpJson({ ok: false, error: "MISSING_AUTH_OR_EVENT" }, 400, corsHdrs);
    }

    const rtdbBase = getWatchPartyRtdbBase(env);
    return await withWatchPartyLock(eventId, async () => {
      const eventUrl = `${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`;
      const ev = await rtdbFetchJson(eventUrl);
      if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);
      if (ev.organizerId !== actor.accountKey) {
        return wpJson({ ok: false, error: "ONLY_ORGANIZER_ALLOWED" }, 403, corsHdrs);
      }

      if (action === "revoke_link" || action === "regenerate_link") {
        if (ev.inviteToken) {
          await rtdbPutJson(`${rtdbBase}/lobby_config/watch_parties_v1/invites/${encodeURIComponent(ev.inviteToken)}.json`, {
            eventId,
            inviteCode: ev.inviteCode,
            revoked: true,
            revokedAt: serverNow
          });
        }
        if (action === "revoke_link") {
          ev.inviteRevoked = true;
          ev.updatedAt = serverNow;
          await rtdbPutJson(eventUrl, ev);
        } else {
          const newToken = generateInviteToken();
          const newCode = generateInviteCode();
          ev.inviteToken = newToken;
          ev.inviteCode = newCode;
          ev.inviteRevoked = false;
          ev.updatedAt = serverNow;
          await Promise.all([
            rtdbPutJson(eventUrl, ev),
            rtdbPutJson(`${rtdbBase}/lobby_config/watch_parties_v1/invites/${encodeURIComponent(newToken)}.json`, {
              eventId,
              inviteCode: newCode,
              revoked: false,
              createdAt: serverNow
            })
          ]);
        }
        return wpJson({ ok: true, event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow), serverNow }, 200, corsHdrs);
      }

      if (ev.status === "ended" || ev.status === "cancelled") {
        return wpJson({ ok: false, error: "EVENT_ALREADY_FINALIZED" }, 409, corsHdrs);
      }

      if (action === "cancel") {
        if (serverNow >= Number(ev.startsAt || 0) && ev.status === "open") {
          return wpJson({ ok: false, error: "USE_END_GROUP_INSTEAD" }, 409, corsHdrs);
        }
        ev.status = "cancelled";
        ev.scheduleVersion = Number(ev.scheduleVersion || 1) + 1;
        ev.endedReason = "cancelled_by_organizer";
        ev.updatedAt = serverNow;
        if (ev.inviteToken) {
          await rtdbPutJson(`${rtdbBase}/lobby_config/watch_parties_v1/invites/${encodeURIComponent(ev.inviteToken)}.json`, {
            eventId,
            inviteCode: ev.inviteCode,
            revoked: true,
            revokedAt: serverNow
          }).catch(() => {});
        }
        await rtdbPutJson(eventUrl, ev);
        return wpJson({ ok: true, event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow), serverNow }, 200, corsHdrs);
      }

      // action === "edit" -> chỉ cho sửa trước startsAt
      if (serverNow >= Number(ev.startsAt || 0) || ev.status === "open") {
        return wpJson({ ok: false, error: "CANNOT_EDIT_AFTER_START" }, 409, corsHdrs);
      }

      const nextMovieTitle = String(body.movieTitle || ev.movieTitle).trim().slice(0, 140);
      const nextMovieId = String(body.movieId || ev.movieId).trim();
      const nextDurationSec = body.durationSec ? Math.round(Number(body.durationSec)) : ev.durationSec;
      const nextStartsAt = body.startsAt ? Math.round(Number(body.startsAt)) : ev.startsAt;
      const nextRoomType = DEFAULT_WATCH_PARTY_CONFIG.roomTypes[body.roomType] ? body.roomType : ev.roomType;
      const typeMeta = DEFAULT_WATCH_PARTY_CONFIG.roomTypes[nextRoomType];
      const nextCapacity = body.capacity
        ? Math.min(typeMeta.maxCap, Math.max(typeMeta.minCap, Math.round(Number(body.capacity))))
        : Math.min(typeMeta.maxCap, Math.max(typeMeta.minCap, ev.capacity));

      const stats = getWatchPartyMemberStats(ev);
      if (nextCapacity < stats.approvedGoingCount) {
        return wpJson({ ok: false, error: "CAPACITY_BELOW_APPROVED_COUNT" }, 400, corsHdrs);
      }
      if (!Number.isFinite(nextDurationSec) || nextDurationSec < 30) {
        return wpJson({ ok: false, error: "INVALID_DURATION_SECONDS" }, 400, corsHdrs);
      }
      if (!Number.isFinite(nextStartsAt) || nextStartsAt < serverNow - 15000) {
        return wpJson({ ok: false, error: "INVALID_STARTS_AT" }, 400, corsHdrs);
      }

      const nextEndsAt = computeWatchPartyEndsAt(nextStartsAt, nextDurationSec, ev.bufferMinutes);
      ev.movieId = nextMovieId;
      ev.movieTitle = nextMovieTitle;
      if (body.poster !== undefined) ev.poster = String(body.poster || "").trim().slice(0, 500);
      if (body.videoUrl !== undefined) ev.videoUrl = String(body.videoUrl || "").trim().slice(0, 800);
      if (body.youtubeId !== undefined) ev.youtubeId = String(body.youtubeId || "").trim().slice(0, 40);
      if (body.genre !== undefined) ev.genre = String(body.genre || "").trim().slice(0, 120);
      ev.durationSec = nextDurationSec;
      ev.startsAt = nextStartsAt;
      ev.endsAt = nextEndsAt;
      ev.roomType = nextRoomType;
      ev.capacity = nextCapacity;
      if (body.visibility === "invite_direct" || body.visibility === "invite_approval") {
        ev.visibility = body.visibility;
      }
      ev.scheduleVersion = Number(ev.scheduleVersion || 1) + 1;
      ev.lastChangeNotice = `Chủ buổi hẹn đã cập nhật lịch (#v${ev.scheduleVersion})`;
      ev.updatedAt = serverNow;
      await rtdbPutJson(eventUrl, ev);

      return wpJson({ ok: true, event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow), serverNow }, 200, corsHdrs);
    });
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function resolveEventIdByTokenOrCode(rtdbBase, token = "", eventId = "") {
  if (eventId) return eventId;
  if (!token) return "";
  const inv = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/invites/${encodeURIComponent(token)}.json`).catch(() => null);
  if (inv && inv.eventId && !inv.revoked) return inv.eventId;
  if (inv && inv.revoked) return "__REVOKED__";
  return "";
}

async function handleWatchPartyRsvp(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    const token = String(body.token || "").trim();
    const rsvp = String(body.rsvp || "").trim(); // "going" | "maybe" | "declined"
    if (!actor) return wpJson({ ok: false, error: "AUTH_REQUIRED" }, 401, corsHdrs);
    if (!["going", "maybe", "declined"].includes(rsvp)) {
      return wpJson({ ok: false, error: "INVALID_RSVP" }, 400, corsHdrs);
    }

    const rtdbBase = getWatchPartyRtdbBase(env);
    const resolvedId = await resolveEventIdByTokenOrCode(rtdbBase, token, String(body.eventId || "").trim());
    if (resolvedId === "__REVOKED__") {
      return wpJson({ ok: false, error: "INVITE_REVOKED" }, 403, corsHdrs);
    }
    if (!resolvedId) {
      return wpJson({ ok: false, error: "INVITE_NOT_FOUND" }, 404, corsHdrs);
    }

    return await withWatchPartyLock(resolvedId, async () => {
      const eventUrl = `${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(resolvedId)}.json`;
      const ev = await rtdbFetchJson(eventUrl);
      if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);
      if (ev.inviteRevoked && actor.accountKey !== ev.organizerId) {
        return wpJson({ ok: false, error: "INVITE_REVOKED" }, 403, corsHdrs);
      }
      if (ev.status === "cancelled" || ev.status === "ended" || serverNow >= Number(ev.endsAt || 0)) {
        return wpJson({ ok: false, error: "EVENT_ENDED_OR_CANCELLED" }, 410, corsHdrs);
      }
      if (actor.accountKey === ev.organizerId) {
        return wpJson({ ok: false, error: "ORGANIZER_ALREADY_HOSTING" }, 400, corsHdrs);
      }

      if (!ev.members || typeof ev.members !== "object") ev.members = {};
      const existing = ev.members[actor.accountKey];
      const stats = getWatchPartyMemberStats(ev);

      if (rsvp === "declined") {
        ev.members[actor.accountKey] = {
          accountKey: actor.accountKey,
          email: actor.email,
          uid: actor.uid,
          name: actor.name,
          rsvp: "declined",
          approvalStatus: "rejected",
          isOrganizer: false,
          respondedAt: existing?.respondedAt || serverNow,
          updatedAt: serverNow
        };
      } else {
        const directApprove = ev.visibility === "invite_direct" && rsvp === "going";
        const alreadyApprovedGoing = Boolean(existing && existing.approvalStatus === "approved" && existing.rsvp === "going");

        if ((directApprove || rsvp === "going") && !alreadyApprovedGoing && stats.isFull) {
          return wpJson({ ok: false, error: "ROOM_CAPACITY_FULL", capacity: stats.capacity }, 409, corsHdrs);
        }

        const nextApproval = existing?.approvalStatus === "approved" && rsvp === "going"
          ? "approved"
          : (directApprove ? "approved" : "pending");

        ev.members[actor.accountKey] = {
          accountKey: actor.accountKey,
          email: actor.email,
          uid: actor.uid,
          name: actor.name,
          rsvp,
          approvalStatus: nextApproval,
          isOrganizer: false,
          respondedAt: existing?.respondedAt || serverNow,
          approvedAt: nextApproval === "approved" ? (existing?.approvedAt || serverNow) : 0,
          updatedAt: serverNow
        };
      }

      ev.updatedAt = serverNow;
      await rtdbPutJson(eventUrl, ev);
      return wpJson({ ok: true, event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow), serverNow }, 200, corsHdrs);
    });
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyApprove(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    const eventId = String(body.eventId || "").trim();
    const targetAccountKey = sanitizeRtdbKey(body.targetAccountKey || "");
    const decision = String(body.decision || "approve").trim(); // "approve" | "reject"
    if (!actor || !eventId || !targetAccountKey) {
      return wpJson({ ok: false, error: "MISSING_PARAMETERS" }, 400, corsHdrs);
    }

    const rtdbBase = getWatchPartyRtdbBase(env);
    return await withWatchPartyLock(eventId, async () => {
      const eventUrl = `${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`;
      const ev = await rtdbFetchJson(eventUrl);
      if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);
      if (ev.organizerId !== actor.accountKey) {
        return wpJson({ ok: false, error: "ONLY_ORGANIZER_CAN_APPROVE" }, 403, corsHdrs);
      }
      if (ev.status === "ended" || ev.status === "cancelled" || serverNow >= Number(ev.endsAt || 0)) {
        return wpJson({ ok: false, error: "EVENT_ENDED_OR_CANCELLED" }, 410, corsHdrs);
      }
      const targetMember = ev.members?.[targetAccountKey];
      if (!targetMember) {
        return wpJson({ ok: false, error: "MEMBER_NOT_FOUND" }, 404, corsHdrs);
      }

      if (decision === "approve") {
        const alreadyCounted = targetMember.approvalStatus === "approved" && targetMember.rsvp === "going";
        const stats = getWatchPartyMemberStats(ev);
        if (!alreadyCounted && stats.isFull) {
          return wpJson({ ok: false, error: "ROOM_CAPACITY_FULL", capacity: stats.capacity }, 409, corsHdrs);
        }
        targetMember.rsvp = "going";
        targetMember.approvalStatus = "approved";
        targetMember.approvedAt = serverNow;
        targetMember.updatedAt = serverNow;
      } else {
        targetMember.approvalStatus = "rejected";
        targetMember.updatedAt = serverNow;
      }

      ev.updatedAt = serverNow;
      await rtdbPutJson(eventUrl, ev);
      return wpJson({ ok: true, event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow), serverNow }, 200, corsHdrs);
    });
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyEnter(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    if (!actor) return wpJson({ ok: false, error: "AUTH_REQUIRED" }, 401, corsHdrs);

    const rawEventId = String(body.eventId || "").trim();
    const rawRoomId = String(body.roomId || "").trim();
    const eventId = rawEventId || (rawRoomId.startsWith("wp_") ? rawRoomId.slice(3) : "");
    if (!eventId) return wpJson({ ok: false, error: "MISSING_EVENT_OR_ROOM" }, 400, corsHdrs);

    const rtdbBase = getWatchPartyRtdbBase(env);
    const eventUrl = `${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`;
    let ev = await rtdbFetchJson(eventUrl);
    if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);

    // Reconcile trên máy chủ nếu đã tới giờ mở hoặc hết giờ
    const rec = await reconcileSingleWatchParty(env, rtdbBase, ev, serverNow);
    if (rec?.event) ev = rec.event;

    if (!isAccountApprovedForWatchParty(ev, actor.accountKey)) {
      return wpJson({ ok: false, error: "NOT_APPROVED_FOR_WATCH_PARTY" }, 403, corsHdrs);
    }
    if (ev.status === "cancelled") {
      return wpJson({ ok: false, error: "EVENT_CANCELLED" }, 410, corsHdrs);
    }
    if (ev.status === "ended" || serverNow >= Number(ev.endsAt || 0)) {
      return wpJson({ ok: false, error: "EVENT_ENDED", event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow) }, 410, corsHdrs);
    }
    if (serverNow < Number(ev.startsAt || 0)) {
      return wpJson({ ok: false, error: "NOT_STARTED_YET", startsAt: ev.startsAt, serverNow }, 403, corsHdrs);
    }
    if (ev.status !== "open") {
      return wpJson({ ok: false, error: "ROOM_NOT_READY", status: ev.status, lastError: ev.lastError || "" }, 503, corsHdrs);
    }

    const roomId = ev.roomId || `wp_${eventId}`;
    const room = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/rooms/${encodeURIComponent(roomId)}.json`);
    if (!room || room.closed) {
      return wpJson({ ok: false, error: "EVENT_ENDED" }, 410, corsHdrs);
    }

    return wpJson({
      ok: true,
      room,
      event: formatWatchPartyEventForClient(ev, actor.accountKey, serverNow),
      serverNow
    }, 200, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyEndGroup(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    const rawEventId = String(body.eventId || "").trim();
    const rawRoomId = String(body.roomId || "").trim();
    const eventId = rawEventId || (rawRoomId.startsWith("wp_") ? rawRoomId.slice(3) : "");
    if (!actor || !eventId) return wpJson({ ok: false, error: "MISSING_AUTH_OR_EVENT" }, 400, corsHdrs);

    const rtdbBase = getWatchPartyRtdbBase(env);
    const ev = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`);
    if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);
    if (ev.organizerId !== actor.accountKey) {
      return wpJson({ ok: false, error: "ONLY_ORGANIZER_CAN_END_FOR_ALL" }, 403, corsHdrs);
    }

    const closed = await closeWatchPartyEventOnServer(env, rtdbBase, ev, "organizer_ended", serverNow);
    return wpJson({
      ok: true,
      event: formatWatchPartyEventForClient(closed?.event || ev, actor.accountKey, serverNow),
      serverNow
    }, 200, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyRetryRoom(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const body = await request.json().catch(() => ({}));
    const actor = getValidatedActorAccount(body);
    const eventId = String(body.eventId || "").trim();
    if (!actor || !eventId) return wpJson({ ok: false, error: "MISSING_AUTH_OR_EVENT" }, 400, corsHdrs);

    const rtdbBase = getWatchPartyRtdbBase(env);
    const ev = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`);
    if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);
    if (ev.organizerId !== actor.accountKey && !isAccountApprovedForWatchParty(ev, actor.accountKey)) {
      return wpJson({ ok: false, error: "FORBIDDEN" }, 403, corsHdrs);
    }
    const rec = await provisionWatchPartyRoomOnServer(env, rtdbBase, { ...ev, _manualRetry: true }, serverNow);
    return wpJson({
      ok: Boolean(rec?.ok),
      error: rec?.error || "",
      event: formatWatchPartyEventForClient(rec?.event || ev, actor.accountKey, serverNow),
      serverNow
    }, rec?.ok ? 200 : 500, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyList(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const url = new URL(request.url);
    const accountEmail = String(url.searchParams.get("accountEmail") || url.searchParams.get("accountKey") || "").trim().toLowerCase();
    const accountKey = sanitizeRtdbKey(accountEmail);
    const rtdbBase = getWatchPartyRtdbBase(env);

    const [cfg, eventsObj] = await Promise.all([
      loadWatchPartyConfig(env, rtdbBase),
      rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events.json`).catch(() => null)
    ]);

    const upcomingOrActive = [];
    const history = [];

    if (eventsObj && typeof eventsObj === "object" && accountKey) {
      for (const rawEv of Object.values(eventsObj)) {
        if (!rawEv || !rawEv.eventId) continue;
        const isRel = rawEv.organizerId === accountKey || Boolean(rawEv.members?.[accountKey]);
        if (!isRel) continue;

        let ev = rawEv;
        // Khi người dùng mở sảnh/lời mời -> tự kiểm tra khôi phục phòng đến hạn hoặc tự đóng nếu đã quá giờ
        const needReconcile =
          (ev.status !== "cancelled" && ev.status !== "ended" && serverNow >= Number(ev.endsAt || 0)) ||
          ((ev.status === "scheduled" || ev.status === "create_failed") && serverNow >= Number(ev.startsAt || 0) && serverNow < Number(ev.endsAt || 0));
        if (needReconcile) {
          const rec = await reconcileSingleWatchParty(env, rtdbBase, ev, serverNow);
          if (rec?.event) ev = rec.event;
        }

        const formatted = formatWatchPartyEventForClient(ev, accountKey, serverNow);
        if (!formatted) continue;
        if (formatted.status === "ended" || formatted.status === "cancelled") {
          history.push(formatted);
        } else {
          upcomingOrActive.push(formatted);
        }
      }
    }

    upcomingOrActive.sort((a, b) => a.startsAt - b.startsAt);
    history.sort((a, b) => b.startsAt - a.startsAt);

    return wpJson({
      ok: true,
      serverNow,
      config: cfg,
      upcoming: upcomingOrActive,
      history
    }, 200, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyInviteGet(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const url = new URL(request.url);
    const token = String(url.searchParams.get("token") || "").trim();
    const accountEmail = String(url.searchParams.get("accountEmail") || url.searchParams.get("accountKey") || "").trim().toLowerCase();
    const accountKey = sanitizeRtdbKey(accountEmail);
    const rtdbBase = getWatchPartyRtdbBase(env);

    let eventId = String(url.searchParams.get("eventId") || "").trim();
    if (!eventId && token) {
      const inv = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/invites/${encodeURIComponent(token)}.json`).catch(() => null);
      if (!inv) return wpJson({ ok: false, error: "INVITE_NOT_FOUND" }, 404, corsHdrs);
      if (inv.revoked) return wpJson({ ok: false, error: "INVITE_REVOKED" }, 403, corsHdrs);
      eventId = inv.eventId || "";
    }
    if (!eventId) return wpJson({ ok: false, error: "MISSING_INVITE" }, 400, corsHdrs);

    let ev = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`);
    if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);

    if (ev.inviteRevoked && accountKey !== ev.organizerId && token) {
      return wpJson({ ok: false, error: "INVITE_REVOKED" }, 403, corsHdrs);
    }

    // Khôi phục phòng đến hạn hoặc tự đóng khi mở lời mời
    if (ev.status !== "cancelled" && ev.status !== "ended") {
      const rec = await reconcileSingleWatchParty(env, rtdbBase, ev, serverNow);
      if (rec?.event) ev = rec.event;
    }

    return wpJson({
      ok: true,
      serverNow,
      event: formatWatchPartyEventForClient(ev, accountKey, serverNow)
    }, 200, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWatchPartyRoomGet(request, env, corsHdrs, serverNow = Date.now()) {
  try {
    const url = new URL(request.url);
    const roomId = String(url.searchParams.get("roomId") || "").trim();
    const accountEmail = String(url.searchParams.get("accountEmail") || url.searchParams.get("accountKey") || "").trim().toLowerCase();
    const accountKey = sanitizeRtdbKey(accountEmail);
    const eventId = roomId.startsWith("wp_") ? roomId.slice(3) : "";
    if (!accountKey || !eventId) return wpJson({ ok: false, error: "FORBIDDEN" }, 403, corsHdrs);

    const rtdbBase = getWatchPartyRtdbBase(env);
    let ev = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/events/${encodeURIComponent(eventId)}.json`);
    if (!ev) return wpJson({ ok: false, error: "EVENT_NOT_FOUND" }, 404, corsHdrs);
    if (!isAccountApprovedForWatchParty(ev, accountKey)) {
      return wpJson({ ok: false, error: "NOT_APPROVED_FOR_WATCH_PARTY" }, 403, corsHdrs);
    }
    const rec = await reconcileSingleWatchParty(env, rtdbBase, ev, serverNow);
    if (rec?.event) ev = rec.event;
    const room = await rtdbFetchJson(`${rtdbBase}/lobby_config/watch_parties_v1/rooms/${encodeURIComponent(roomId)}.json`);
    return wpJson({
      ok: true,
      serverNow,
      room,
      event: formatWatchPartyEventForClient(ev, accountKey, serverNow)
    }, 200, corsHdrs);
  } catch (e) {
    return wpJson({ ok: false, error: String(e?.message || e) }, 500, corsHdrs);
  }
}

async function handleWorkerFetch(request, env, corsHdrs, ctx) {
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
    if (request.method === "GET" && (path === "/geo" || path.endsWith("/geo"))) {
      const cf = request.cf || {};
      const lat = Number(cf.latitude);
      const lng = Number(cf.longitude);
      const city = String(cf.city || "").trim();
      const region = String(cf.region || "").trim();
      const country = String(cf.country || "").trim();
      const parts = [city, region && region !== city ? region : "", country === "VN" ? "Việt Nam" : country].filter(Boolean);
      return new Response(
        JSON.stringify({
          ok: true,
          source: "cloudflare_ip",
          city,
          region,
          country,
          label: parts.join(", ") || "Việt Nam",
          lat: Number.isFinite(lat) ? lat : null,
          lng: Number.isFinite(lng) ? lng : null,
          timezone: String(cf.timezone || ""),
          colo: String(cf.colo || "")
        }),
        { status: 200, headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }
      );
    }

    if (request.method === "GET" && (path === "/api/top10/weekly" || path.endsWith("/api/top10/weekly"))) {
      return await handleTop10WeeklyGetRequest(request, env, corsHdrs);
    }
    if (request.method === "POST" && (path === "/api/top10/heartbeat" || path.endsWith("/api/top10/heartbeat"))) {
      return await handleTop10HeartbeatRequest(request, env, corsHdrs);
    }

    // Watch Party ("Hẹn xem cùng bạn bè") API routes
    if (request.method === "GET" && path.endsWith("/api/watch-party/list")) {
      return await handleWatchPartyList(request, env, corsHdrs);
    }
    if (request.method === "GET" && path.endsWith("/api/watch-party/invite")) {
      return await handleWatchPartyInviteGet(request, env, corsHdrs);
    }
    if (request.method === "GET" && path.endsWith("/api/watch-party/room")) {
      return await handleWatchPartyRoomGet(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/create")) {
      return await handleWatchPartyCreate(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/update")) {
      return await handleWatchPartyUpdate(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/rsvp")) {
      return await handleWatchPartyRsvp(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/approve")) {
      return await handleWatchPartyApprove(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/enter")) {
      return await handleWatchPartyEnter(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/end-group")) {
      return await handleWatchPartyEndGroup(request, env, corsHdrs);
    }
    if (request.method === "POST" && path.endsWith("/api/watch-party/retry-room")) {
      return await handleWatchPartyRetryRoom(request, env, corsHdrs);
    }
    if ((request.method === "GET" || request.method === "POST") && path.endsWith("/api/watch-party/reconcile")) {
      const summary = await reconcileAllWatchParties(env, Date.now());
      return wpJson(summary, 200, corsHdrs);
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
      return handlePosterLookup(request, env, ctx);
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
      return handleAIRequest(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname.endsWith("/translate-srt")) {
      return handleTranslateSrtRequest(request, env, ctx);
    }
    if ((request.method === "POST" || request.method === "GET") && url.pathname.endsWith("/livekit-token")) {
      return handleLiveKitTokenRequest(request, env);
    }
    if (request.method === "POST" && url.pathname.endsWith("/admin-verify")) {
      const ban = checkAdminBan(clientIp);
      if (ban.banned) {
        return jsonResponse({ ok: false, error: "TOO_MANY_FAILED_ATTEMPTS", retryAfterSec: ban.retryAfterSec }, 429);
      }
      const expected = getExpectedAdminPin(env);
      if (!expected) {
        return jsonResponse({ ok: false, error: "ADMIN_PIN_NOT_CONFIGURED" }, 503);
      }
      try {
        const body = await request.json().catch(() => ({}));
        const token = extractAdminToken(request, body);
        if (token && !body?.pin) {
          const tv = await verifyAdminSessionToken(env, token);
          if (tv.ok) {
            return jsonResponse({ ok: true, validToken: true, expiresAt: tv.expiresAt, usingSecret: true }, 200);
          }
          return jsonResponse({ ok: false, error: "INVALID_OR_EXPIRED_TOKEN" }, 401);
        }
        const pin = String(body?.pin || "").trim();
        const valid = Boolean(pin && (await constantTimeEqual(pin, expected)));
        if (!valid) {
          recordAdminFail(clientIp);
          await new Promise((r) => setTimeout(r, 300));
          return jsonResponse({ ok: false, usingSecret: true }, 200);
        }
        ADMIN_FAIL_BUCKETS.delete(clientIp);
        const session = await signAdminSessionToken(env, 8 * 60 * 60 * 1000);
        return jsonResponse({
          ok: true,
          token: session.token,
          expiresAt: session.expiresAt,
          usingSecret: true
        }, 200);
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
        return jsonResponse({ ok: false, error: e?.message || "SEAL_ERROR" }, 200);
      }
    }
    if (request.method === "POST" && url.pathname.endsWith("/room-locks-unseal")) {
      const ban = checkAdminBan(clientIp);
      if (ban.banned) {
        return jsonResponse({ ok: false, error: "TOO_MANY_FAILED_ATTEMPTS", retryAfterSec: ban.retryAfterSec }, 429);
      }
      const expected = getExpectedAdminPin(env);
      if (!expected) {
        return jsonResponse({ ok: false, error: "ADMIN_PIN_NOT_CONFIGURED" }, 503);
      }
      try {
        const body = await request.json();
        const token = extractAdminToken(request, body);
        let authorized = false;
        if (token) {
          const tv = await verifyAdminSessionToken(env, token);
          authorized = tv.ok;
        }
        if (!authorized) {
          const adminPin = String(body?.adminPin || "").trim();
          authorized = Boolean(adminPin && (await constantTimeEqual(adminPin, expected)));
        }
        if (!authorized) {
          recordAdminFail(clientIp);
          return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 401);
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

    // Gmail OTP Auth (stateless HMAC-SHA256 signed token + Resend + per-email anti-bomb)
    if (request.method === "POST" && url.pathname === "/auth/send-otp") {
      try {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const displayName = String(body.displayName || "").trim().slice(0, 30);
        if (!/^[a-z0-9._%+-]+@gmail\.com$/i.test(email)) {
          return jsonResponse({ ok: false, error: "Vui lòng nhập địa chỉ Gmail hợp lệ (@gmail.com)." }, 400);
        }
        const emailRl = checkRateLimit(email, "otp_email", 3, 600000);
        if (!emailRl.allowed) {
          return jsonResponse({
            ok: false,
            error: `Gmail này đã yêu cầu quá nhiều mã OTP. Vui lòng thử lại sau ${emailRl.retryAfterSec} giây.`
          }, 429);
        }
        if (!env.RESEND_API_KEY) {
          return jsonResponse({ ok: false, error: "Worker chưa cấu hình RESEND_API_KEY." }, 500);
        }
        let secret;
        try {
          secret = getOtpSecret(env);
        } catch (_) {
          return jsonResponse({ ok: false, error: "OTP_SECRET_NOT_CONFIGURED" }, 503);
        }
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        const otp = String(100000 + (arr[0] % 900000));
        const exp = Date.now() + 5 * 60 * 1000;
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
        const verifyRl = checkRateLimit(`${clientIp}:${email}`, "otp_verify", 8, 600000);
        if (!verifyRl.allowed) {
          return jsonResponse({ ok: false, error: `Bạn thử sai quá nhiều lần. Thử lại sau ${verifyRl.retryAfterSec} giây.` }, 429);
        }
        if (isOtpTokenUsed(otpToken)) {
          return jsonResponse({ ok: false, error: "Mã OTP này đã được sử dụng. Vui lòng gửi mã mới." }, 400);
        }
        let secret;
        try {
          secret = getOtpSecret(env);
        } catch (_) {
          return jsonResponse({ ok: false, error: "OTP_SECRET_NOT_CONFIGURED" }, 503);
        }
        const [payloadB64, sigB64] = otpToken.split(".");
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
        if (!timingSafeEqualStr(sigB64, expectedSigB64)) {
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
        if (!timingSafeEqualStr(otpHash, payload.otpHash)) {
          return jsonResponse({ ok: false, error: "Mã OTP không đúng. Vui lòng kiểm tra lại Gmail." }, 400);
        }
        markOtpTokenUsed(otpToken, 600000);
        const uidBuf = await crypto.subtle.digest("SHA-256", enc.encode(`uid:${email}:${secret}`));
        const verifiedUid = "gm_" + Array.from(new Uint8Array(uidBuf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
        return jsonResponse({ ok: true, email, verifiedUid, verifiedAt: Date.now() }, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    // Xác thực Key Chủ Trì phía server (chống dò key & không cần client đọc trực tiếp host_keys)
    if (request.method === "POST" && url.pathname === "/host-claim") {
      try {
        const claimRl = checkRateLimit(clientIp, "host_claim", 8, 600000);
        if (!claimRl.allowed) {
          return jsonResponse({ ok: false, error: `Thử sai Key quá nhiều lần. Vui lòng đợi ${claimRl.retryAfterSec} giây.` }, 429);
        }
        const body = await request.json().catch(() => ({}));
        const roomId = String(body.roomId || "").trim();
        const enteredKey = String(body.key || "").trim().toUpperCase();
        if (!/^room-[1-8]$/.test(roomId) || !enteredKey) {
          return jsonResponse({ ok: false, error: "Thông tin phòng hoặc Key không hợp lệ." }, 400);
        }
        const rtdbBase = String(env.FIREBASE_RTDB_URL || "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, "");
        const keyRes = await fetch(`${rtdbBase}/host_keys/${encodeURIComponent(roomId)}.json`, { cache: "no-store" });
        const keyData = keyRes.ok ? await keyRes.json().catch(() => null) : null;
        const expectedKey = String(keyData?.key || "").trim().toUpperCase();
        if (!expectedKey) {
          return jsonResponse({ ok: false, error: "Admin chưa tạo Key Chủ Trì cho phòng này." }, 404);
        }
        if (!timingSafeEqualStr(enteredKey, expectedKey)) {
          return jsonResponse({ ok: false, error: "Key Chủ Trì không đúng." }, 403);
        }
        return jsonResponse({ ok: true, roomId }, 200);
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    // Xác thực vé Discord từ URL (chống giả mạo ?discordOrder=...&uid=... để vượt cổng đăng nhập)
    if (request.method === "POST" && url.pathname === "/discord-ticket/verify") {
      try {
        const body = await request.json().catch(() => ({}));
        const orderId = String(body.orderId || "").trim();
        const roomId = String(body.roomId || "").trim();
        const seatId = String(body.seatId || "").trim().toUpperCase();
        const uid = String(body.uid || "").trim();
        if (!orderId || !/^room-[1-8]$/.test(roomId) || !uid.startsWith("discord_")) {
          return jsonResponse({ ok: false, error: "Vé Discord không hợp lệ." }, 400);
        }
        const rtdbBase = String(env.FIREBASE_RTDB_URL || "https://cineverse-ea320-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/+$/, "");
        const ordRes = await fetch(`${rtdbBase}/revenue_orders/${encodeURIComponent(orderId)}.json`, { cache: "no-store" });
        const order = ordRes.ok ? await ordRes.json().catch(() => null) : null;
        if (!order || order.source !== "discord" || order.roomId !== roomId || order.uid !== uid) {
          return jsonResponse({ ok: false, error: "Không tìm thấy vé Discord hợp lệ trên hệ thống." }, 403);
        }
        if (seatId && String(order.seatId || "").toUpperCase() !== seatId) {
          return jsonResponse({ ok: false, error: "Số ghế không khớp với vé Discord." }, 403);
        }
        if (order.createdAt && Date.now() - Number(order.createdAt) > 24 * 60 * 60 * 1000) {
          return jsonResponse({ ok: false, error: "Vé Discord đã hết hạn (quá 24 giờ)." }, 403);
        }
        return jsonResponse({
          ok: true,
          orderId,
          roomId: order.roomId,
          seatId: order.seatId,
          uid: order.uid,
          userName: String(order.userName || "Thành viên Discord").slice(0, 28)
        }, 200);
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
    if (!forceRefresh && R2_CATALOG_CACHE.data && nowTs - R2_CATALOG_CACHE.ts < 60000) {
      return new Response(
        JSON.stringify({ ok: true, cached: true, count: R2_CATALOG_CACHE.data.length, videos: R2_CATALOG_CACHE.data }),
        {
          status: 200,
          headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=60" }
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
        headers: { ...corsHdrs, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=60" }
      }
    );
}

export default {
  async fetch(request, env, ctx) {
    const corsHdrs = getCorsHeaders(request, env);
    const raw = await handleWorkerFetch(request, env, corsHdrs, ctx);
    const res = new Response(raw.body, raw);
    for (const [k, v] of Object.entries(corsHdrs)) {
      res.headers.set(k, v);
    }
    return res;
  },
  async scheduled(controller, env, ctx) {
    const task = reconcileAllWatchParties(env, Date.now());
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    }
    await task;
  }
};
