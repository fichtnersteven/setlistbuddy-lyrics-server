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

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} – query:`,
    req.query
  );
  next();
});

const lyricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
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
  if (Date.now() - entry.createdAt > CACHE_TTL) {
    lyricsCache.delete(key);
    return null;
  }
  return entry.data;
}

function saveToCache(title, artist, data) {
  lyricsCache.set(makeCacheKey(title, artist), {
    createdAt: Date.now(),
    data,
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of lyricsCache.entries()) {
    if (now - entry.createdAt > CACHE_TTL) lyricsCache.delete(key);
  }
}, 30 * 60 * 1000);

// ──────────────────────────────────────
// 3. Axios-Client + Retry
// ──────────────────────────────────────

const http = axios.create({
  timeout: 8000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    Accept: "text/html,application/xhtml+xml",
  },
});

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await http.get(url, options);
    } catch (err) {
      if (i === retries) throw err;
      console.log(`Retry ${i + 1}/${retries} für ${url}:`, err.message);
      await new Promise((r) => setTimeout(r, 300 + i * 400));
    }
  }
}

// ──────────────────────────────────────
// 4. Genius API Helper
// ──────────────────────────────────────

async function searchWithGenius(query) {
  const apiKey = process.env.GENIUS_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.get("https://api.genius.com/search", {
      params: { q: query },
      headers: { Authorization: "Bearer " + apiKey },
      timeout: 5000,
    });

    const hits = response?.data?.response?.hits || [];
    if (!hits.length) return null;

    const best = hits[0]?.result;
    return {
      title: best.title,
      artist: best.primary_artist?.name,
      url: best.url,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────
// 5. songtexte.com Helpers
// ──────────────────────────────────────

function buildSongtexteSearchUrl(query) {
  return "https://www.songtexte.com/search?q=" + encodeURIComponent(query);
}

async function findSongtexteLink(finalQuery, expectedTitle, expectedArtist) {
  const searchUrl = buildSongtexteSearchUrl(finalQuery);
  console.log("➜ songtexte.com Search URL:", searchUrl);

  const searchResponse = await fetchWithRetry(searchUrl);
  const $ = cheerio.load(searchResponse.data);

  const links = [];
  $("a[href^='/songtext/']").each((i, el) => {
    links.push({
      href: $(el).attr("href"),
      text: $(el).text().trim().toLowerCase(),
    });
  });

  console.log("➜ Gefundene Treffer:", links.length);
  if (!links.length) return null;

  const artistNorm = (expectedArtist || "").toLowerCase();
  const titleNorm = (expectedTitle || "").toLowerCase();

  const filtered = links.filter(
    (l) => l.text.includes(artistNorm) || l.text.includes(titleNorm)
  );

  console.log("➜ Filtered Treffer:", filtered.length);

  const best = filtered[0] || links[0];
  if (!best) return null;

  return "https://www.songtexte.com" + best.href;
}

async function extractSongtexteLyrics(url) {
  const response = await fetchWithRetry(url);
  const $ = cheerio.load(response.data);

  const selectors = ["#lyrics", ".lyrics", ".songtext", ".content .lyrics"];
  for (const sel of selectors) {
    const txt = $(sel).text().trim();
    if (txt) return txt;
  }

  const collected = [];
  $("p").each((_, el) => {
    const t = $(el).text().trim();
    if (
      t &&
      !t.toLowerCase().includes("cookies") &&
      !t.toLowerCase().includes("privacy")
    ) {
      collected.push(t);
    }
  });

  return collected.join("\n\n") || null;
}

// ──────────────────────────────────────
// 6. Routes
// ──────────────────────────────────────

app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Genius + songtexte.com) ✅");
});

app.get("/lyrics", async (req, res) => {
  const rawTitle = req.query.title || "";
  const rawArtist = req.query.artist || "";

  const title = rawTitle.trim();
  const artist = rawArtist.trim();

  if (!title)
    return res.status(400).json({
      success: false,
      error: "Parameter 'title' fehlt.",
    });

  const cached = getFromCache(title, artist);
  if (cached) return res.json({ ...cached, cache: true });

  const baseQuery = artist ? `${title} ${artist}` : title;

  let finalTitle = title;
  let finalArtist = artist;
  let geniusUrl = null;

  const genius = await searchWithGenius(baseQuery);
  if (genius) {
    finalTitle = genius.title || finalTitle;
    finalArtist = genius.artist || finalArtist;
    geniusUrl = genius.url;
  }

  const finalQuery = `${finalTitle} ${finalArtist}`.trim();

  const lyricsUrl = await findSongtexteLink(
    finalQuery,
    finalTitle,
    finalArtist
  );

  if (!lyricsUrl)
    return res.status(404).json({
      success: false,
      error: "songtexte.com hat keinen passenden Song gefunden.",
    });

  const lyrics = await extractSongtexteLyrics(lyricsUrl);
  if (!lyrics)
    return res.status(404).json({
      success: false,
      error: "songtexte.com hat keine Lyrics extrahiert.",
    });

  const payload = {
    success: true,
    source: "genius + songtexte.com",
    title: finalTitle,
    artist: finalArtist,
    lyrics,
    geniusUrl,
    lyricsUrl,
    cache: false,
  };

  saveToCache(title, artist, payload);
  res.json(payload);
});

// ──────────────────────────────────────
// 7. Start
// ──────────────────────────────────────

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
