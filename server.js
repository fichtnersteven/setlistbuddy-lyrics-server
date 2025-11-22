require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────
// 1. Middleware / Basis
// ──────────────────────────────────────

app.use(cors());
app.use(express.json());

// Einfaches Request-Logging
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} – query:`,
    req.query
  );
  next();
});

// Rate-Limit speziell für /lyrics
const lyricsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 Minute
  max: 30, // 30 Requests pro Minute pro IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/lyrics", lyricsLimiter);

// ──────────────────────────────────────
// 2. In-Memory Cache
// ──────────────────────────────────────

const CACHE_TTL = 1000 * 60 * 60; // 1 Stunde
const lyricsCache = new Map();

function makeCacheKey(title, artist) {
  return `${title.toLowerCase().trim()}::${(artist || "")
    .toLowerCase()
    .trim()}`;
}

function getFromCache(title, artist) {
  const key = makeCacheKey(title, artist);
  const entry = lyricsCache.get(key);
  if (!entry) return null;

  const isExpired = Date.now() - entry.createdAt > CACHE_TTL;
  if (isExpired) {
    lyricsCache.delete(key);
    return null;
  }
  return entry.data;
}

function saveToCache(title, artist, data) {
  const key = makeCacheKey(title, artist);
  lyricsCache.set(key, { createdAt: Date.now(), data });
}

// gelegentlich Cache aufräumen
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of lyricsCache.entries()) {
    if (now - entry.createdAt > CACHE_TTL) {
      lyricsCache.delete(key);
    }
  }
}, 30 * 60 * 1000); // alle 30 Minuten

// ──────────────────────────────────────
// 3. Axios-Client + Retry
// ──────────────────────────────────────

const http = axios.create({
  timeout: 8000, // 8 Sekunden Timeout
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

/**
 * Einfacher GET mit Retry-Logik
 */
async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await http.get(url, options);
      return res;
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      console.log(
        `⚠️ Fehler bei Request (${url}), Retry ${attempt + 1}/${retries}:`,
        err.message
      );
      await new Promise((r) => setTimeout(r, 300 + attempt * 400));
    }
  }
}

// ──────────────────────────────────────
// 4. Genius – Helper
// ──────────────────────────────────────

async function searchWithGenius(query) {
  const apiKey = process.env.GENIUS_API_KEY;
  if (!apiKey) {
    console.log("⚠️ Keine GENIUS_API_KEY gesetzt. Überspringe Genius-Suche.");
    return null;
  }

  try {
    console.log("➜ Genius API Suche:", query);
    const response = await axios.get("https://api.genius.com/search", {
      params: { q: query },
      headers: {
        Authorization: "Bearer " + apiKey,
      },
      timeout: 5000,
    });

    const hits = response?.data?.response?.hits || [];
    console.log("➜ Genius hits:", hits.length);
    if (!hits.length) return null;

    const best = hits[0]?.result;
    if (!best) return null;

    return {
      title: best.title || null,
      artist: best.primary_artist?.name || null,
      url: best.url || null,
    };
  } catch (err) {
    console.log("⚠️ Genius API Fehler:", err.message);
    return null; // wir behandeln das als optionalen Bonus, kein Hard-Fail
  }
}

// ──────────────────────────────────────
// 5. songtexte.com – Helpers
// ──────────────────────────────────────

function buildSongtexteSearchUrl(query) {
  // Du hattest: /search?q= – das lassen wir so, da es bei dir bereits funktioniert
  return "https://www.songtexte.com/search?q=" + encodeURIComponent(query);
}

async function findFirstSongtexteLink(finalQuery) {
  const searchUrl = buildSongtexteSearchUrl(finalQuery);
  console.log("➜ songtexte.com Search URL:", searchUrl);

  const searchResponse = await fetchWithRetry(searchUrl);

  console.log(
    "➜ songtexte.com Search HTML length:",
    typeof searchResponse.data === "string"
      ? searchResponse.data.length
      : "n/a"
  );

  const $search = cheerio.load(searchResponse.data);

  // Deine bisherigen Selektoren + etwas flexibler
  let firstLink =
    $search('a[href^="/songtext/"]').attr("href") ||
    $search(".songs a[href^='/songtext/']").attr("href") ||
    $search(".content a[href^='/songtext/']").attr("href");

  console.log("➜ songtexte.com firstLink:", firstLink || "none");

  if (!firstLink) {
    return null;
  }

  return "https://www.songtexte.com" + firstLink;
}

async function extractSongtexteLyrics(lyricsUrl) {
  console.log("➜ songtexte.com Lyrics URL:", lyricsUrl);

  const lyricsResponse = await fetchWithRetry(lyricsUrl);

  console.log(
    "➜ songtexte.com Lyrics HTML length:",
    typeof lyricsResponse.data === "string"
      ? lyricsResponse.data.length
      : "n/a"
  );

  const $lyrics = cheerio.load(lyricsResponse.data);

  // 1) Bevorzugte Container
  const possibleSelectors = ["#lyrics", ".lyrics", ".songtext", ".content .lyrics"];
  let lyricsText = "";

  for (const sel of possibleSelectors) {
    const txt = $lyrics(sel).text().trim();
    if (txt) {
      lyricsText = txt;
      break;
    }
  }

  // 2) Fallback: <p>-Sammlung (mit kleinen Filtern)
  if (!lyricsText) {
    const collected = [];
    $lyrics("p").each((_, el) => {
      const t = $lyrics(el).text().trim();
      if (!t) return;
      const lower = t.toLowerCase();
      if (
        lower.includes("cookies") ||
        lower.includes("datenschutz") ||
        lower.includes("privacy")
      ) {
        return;
      }
      collected.push(t);
    });
    if (collected.length) {
      lyricsText = collected.join("\n\n");
    }
  }

  console.log(
    "➜ Extracted lyrics length:",
    lyricsText ? lyricsText.length : 0
  );

  return lyricsText || null;
}

// ──────────────────────────────────────
// 6. Routes
// ──────────────────────────────────────

app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Genius + songtexte.com) ✅");
});

// einfache Health-Route (z.B. für Render Healthchecks)
app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.get("/lyrics", async (req, res) => {
  const rawTitle = req.query.title || "";
  const rawArtist = req.query.artist || "";

  const title = rawTitle.toString().trim();
  const artist = rawArtist.toString().trim();

  if (!title) {
    return res.status(400).json({
      success: false,
      error: "Parameter 'title' fehlt.",
    });
  }

  const baseQuery = artist ? `${title} ${artist}` : title;
  console.log("➜ /lyrics request", { title, artist, query: baseQuery });

  // 1) Cache-Check
  const cached = getFromCache(title, artist);
  if (cached) {
    console.log("➜ Cache-Hit");
    return res.json({
      ...cached,
      cache: true,
    });
  }

  try {
    // 2) Genius (optional) → bessere Query
    let finalTitle = title;
    let finalArtist = artist;
    let geniusUrl = null;

    const geniusResult = await searchWithGenius(baseQuery);
    if (geniusResult) {
      finalTitle = geniusResult.title || finalTitle;
      finalArtist = geniusResult.artist || finalArtist;
      geniusUrl = geniusResult.url || null;
    } else {
      console.log("➜ Keine oder fehlerhafte Genius-Ergebnisse, nutze Fallback-Query (Rohdaten)");
    }

    const finalQuery = `${finalTitle} ${finalArtist}`.trim();
    console.log("➜ Finaler Suchbegriff für songtexte.com:", finalQuery);

    // 3) songtexte.com – Suche
    const lyricsUrl = await findFirstSongtexteLink(finalQuery);
    if (!lyricsUrl) {
      return res.status(404).json({
        success: false,
        error: "songtexte.com hat keinen passenden Song gefunden.",
      });
    }

    // 4) songtexte.com – Lyrics extrahieren
    const lyricsText = await extractSongtexteLyrics(lyricsUrl);

    if (!lyricsText) {
      return res.status(404).json({
        success: false,
        error: "songtexte.com hat keine Lyrics extrahiert.",
      });
    }

    // 5) Erfolgreiche Antwort bauen
    const responsePayload = {
      success: true,
      source: "genius + songtexte.com",
      title: finalTitle,
      artist: finalArtist,
      lyrics: lyricsText,
      geniusUrl: geniusUrl || undefined,
      lyricsUrl,
      cache: false,
    };

    // Im Cache speichern
    saveToCache(title, artist, responsePayload);

    return res.json(responsePayload);
  } catch (err) {
    console.log("❌ SERVER FEHLER /lyrics:");

    if (err.response) {
      console.log("Status:", err.response.status);
      console.log(
        "Response snippet:",
        typeof err.response.data === "string"
          ? err.response.data.slice(0, 300)
          : err.response.data
      );
    } else {
      console.log(String(err));
    }

    return res.status(500).json({
      success: false,
      error: "Serverfehler bei der Lyrics-Suche",
    });
  }
});

// ──────────────────────────────────────
// 7. Start
// ──────────────────────────────────────

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
