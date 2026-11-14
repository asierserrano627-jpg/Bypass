// api/bypass.js — AsierBot Bypass Worker (Vercel)
// El bot llama: GET /api/bypass?url=LINK_A_BYPASSEAR
// Responde:     { ok: true,  destination: "URL_REAL" }
//           o   { ok: false, error: "motivo" }
//
// Soporta:
//   • links.lootlabs.gg/s?...  (formato cifrado nuevo)
//   • lootlabs.gg/land?l=ID    (formato clásico)
//   • lootdest.com/s/ID        (alias de lootlabs)
//   • lootdest.org/s/ID        (otro alias)
//   • Cualquier otro link: intenta seguir redirecciones HTTP
//
// Despliegue:
//   1. Sube esta carpeta a GitHub (api/bypass.js + vercel.json)
//   2. Importa el repo en vercel.com → despliega automático
//   3. Copia la URL del deploy (ej. https://asierbot-bypass.vercel.app)
//   4. En Discord: /settings4 → Bypass Link → Configurar worker → pega la URL
//
// Token opcional: si defines la variable BYPASS_TOKEN en Vercel,
// el bot tendrá que mandarlo en el header X-Bypass-Token o ?token=
// Déjalo vacío si no quieres protección.

const TOKEN = process.env.BYPASS_TOKEN || "";

// ── Utilidades ──────────────────────────────────────────────────────────────

function checkToken(req) {
  if (!TOKEN) return true; // sin protección configurada
  const t = req.headers["x-bypass-token"] || req.query?.token || "";
  return t === TOKEN;
}

// fetch con timeout y headers de navegador
async function get(url, extraHeaders = {}, { follow = true, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: follow ? "follow" : "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.9",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        ...extraHeaders,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
}

// Extrae el ID de lootlabs de cualquiera de sus formatos
function lootlabsId(url) {
  // links.lootlabs.gg/s?fJjn&data=...  → fJjn es el shortcode
  const m1 = url.match(/links\.lootlabs\.gg\/s\?([A-Za-z0-9_-]+)/i);
  if (m1) return { type: "short", id: m1[1] };

  // lootlabs.gg/land?l=XXXXXX
  const m2 = url.match(/lootlabs\.gg\/land\?l=([A-Za-z0-9_-]+)/i);
  if (m2) return { type: "land", id: m2[1] };

  // lootdest.com/s/XXXXXX  o  lootdest.org/s/XXXXXX
  const m3 = url.match(/lootdest\.[a-z]+\/s\/([A-Za-z0-9_-]+)/i);
  if (m3) return { type: "land", id: m3[1] };

  return null;
}

// ── Estrategias de bypass ───────────────────────────────────────────────────

// 1) links.lootlabs.gg/s?SHORTCODE  → resolve redirect → luego API de journey
async function bypassLootlabsShort(shortcode, rawUrl) {
  // Paso 1: resolver el shortlink para obtener el content_id real
  // El shortlink redirige a lootlabs.gg/land?l=ID o a lootdest
  try {
    const r = await get(rawUrl, {
      "Referer": "https://lootlabs.gg/",
    }, { follow: false });

    const loc = r.headers.get("location") || "";
    if (loc) {
      // Redirige a la página de lootlabs normal
      const inner = lootlabsId(loc);
      if (inner) return bypassLootlabsLand(inner.id);

      // Redirige directamente al destino (raro pero posible)
      if (/^https?:\/\//i.test(loc) && !loc.includes("lootlabs") && !loc.includes("lootdest")) {
        return { ok: true, destination: loc, via: "shortlink redirect" };
      }
    }

    // Si no hubo redirect 301/302, intentar leer el body para sacar el content_id
    const html = await r.text();
    const cidMatch = html.match(/content_id["\s:=]+([A-Za-z0-9_-]{4,})/i)
      || html.match(/land\?l=([A-Za-z0-9_-]+)/i);
    if (cidMatch) return bypassLootlabsLand(cidMatch[1]);
  } catch {}

  // Fallback: intentar con el shortcode como content_id directamente
  return bypassLootlabsLand(shortcode);
}

// 2) lootlabs API de journey (content_id conocido)
async function bypassLootlabsLand(contentId) {
  // Intentar la API de journey de LootLabs
  try {
    const r = await get(`https://lootlabs.gg/api/journey?content_id=${contentId}`, {
      "Referer": "https://lootlabs.gg/",
      "Origin": "https://lootlabs.gg",
      "Accept": "application/json",
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const steps = j?.journey_steps || j?.steps || [];
      const dest =
        steps.findLast?.((s) => s?.destination_url || s?.url)?.destination_url ||
        steps.findLast?.((s) => s?.destination_url || s?.url)?.url ||
        j?.destination_url || j?.url || j?.destination;
      if (dest && /^https?:\/\//i.test(dest)) return { ok: true, destination: dest, via: "LootLabs API journey" };
    }
  } catch {}

  // Fallback: scraping de la página de land
  try {
    const html = await (await get(`https://lootlabs.gg/land?l=${contentId}`, {
      "Referer": "https://lootlabs.gg/",
      "Cookie": "cf_clearance=bypass; ll_bypass=1",
    })).text();
    const dest =
      html.match(/destination[_-]?url["']?\s*[:=]\s*["']([^"']+)/i)?.[1] ||
      html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']{10,})/)?.[1] ||
      html.match(/href=["']([^"']{15,})[^>]*>\s*(?:claim|continue|get|skip|descargar|download)/i)?.[1] ||
      html.match(/data-url=["']([^"']{15,})["']/i)?.[1];
    if (dest && /^https?:\/\//i.test(dest) && !dest.includes("lootlabs") && !dest.includes("lootdest")) {
      return { ok: true, destination: dest, via: "LootLabs scrape" };
    }
  } catch {}

  return null;
}

// 3) Seguir redirecciones HTTP (para links genéricos o como último recurso)
async function bypassFollowRedirects(url) {
  try {
    const r = await get(url, {}, { follow: true });
    const final = r.url;
    if (final && final !== url && /^https?:\/\//i.test(final)) {
      return { ok: true, destination: final, via: "redirect chain" };
    }
  } catch {}
  return null;
}

// ── Handler principal ────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  if (!checkToken(req)) {
    return res.status(401).json({ ok: false, error: "Token incorrecto" });
  }

  const rawUrl = (req.query?.url || "").trim();
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ ok: false, error: "Falta el parámetro url o no es válido" });
  }

  let result = null;

  // ── Detectar tipo de link ──
  const llInfo = lootlabsId(rawUrl);

  if (llInfo?.type === "short") {
    result = await bypassLootlabsShort(llInfo.id, rawUrl);
  } else if (llInfo?.type === "land") {
    result = await bypassLootlabsLand(llInfo.id);
  }

  // Si no es lootlabs o falló, intenta seguir redirecciones
  if (!result) {
    result = await bypassFollowRedirects(rawUrl);
  }

  if (result?.ok && result.destination) {
    return res.json({
      ok: true,
      destination: result.destination,
      url: result.destination,     // compatibilidad con el bot
      result: result.destination,  // compatibilidad extra
      via: result.via || "worker",
    });
  }

  return res.json({
    ok: false,
    error: "No se pudo resolver el link (puede requerir Turnstile interactivo)",
    original: rawUrl,
  });
};
