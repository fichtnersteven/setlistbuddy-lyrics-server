require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────
// 1. Middleware
// ──────────────────────────────────────
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(
  "/lyrics",
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
  })
);

// ──────────────────────────────────────
// 2. Cache (1 Stunde)
// ──────────────────────────────────────
const CACHE_TTL = 1000 * 60 * 60;
const cache = new Map();

function cacheKey(title, artist) {
  return `${title.toLowerCase()}::${artist.toLowerCase()}`;
}

function cacheGet(title, artist) {
  const k = cacheKey(title, artist);
  const entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(k);
    return null;
  }
  return entry.data;
}

function cacheSet(title, artist, data) {
  cache.set(cacheKey(title, artist), { data, timestamp: Date.now() });
}

// ──────────────────────────────────────
// 3. HTTP Client mit Retry
// ──────────────────────────────────────
const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  },
});

async function fetchRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await http.get(url);
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 300 + i * 300));
    }
  }
}

// ──────────────────────────────────────
// 4. Genius API
// ──────────────────────────────────────

async function geniusSearch(query) {
  if (!process.env.GENIUS_API_KEY) return null;

  try {
    const resp = await axios.get("https://api.genius.com/search", {
      params: { q: query },
      headers: { Authorization: "Bearer " + process.env.GENIUS_API_KEY },
    });

    const hit = resp?.data?.response?.hits?.[0]?.result;
    if (!hit) return null;

    return {
      title: hit.title,
      artist: hit.primary_artist?.name,
      url: hit.url,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────
// 5. Songtexte.com – PRO Suchsystem
// ──────────────────────────────────────

// Normalisierung
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function fuzzy(a, b) {
  a = normalize(a);
  b = normalize(b);
  return a.includes(b) || b.includes(a);
}

function searchUrl(query) {
  return "https://www.songtexte.com/search?q=" + encodeURIComponent(query);
}

// 5.1 Top-Treffer finden (der große Kasten oben)
async function parseTopHit($) {
  const topBox = $(".box"); // der große Block ganz oben

  if (!topBox.length) return null;

  const link = topBox.find("a[href^='/songtext/']").attr("href");
  const title = topBox.find("a[href^='/songtext/']").text().trim();
  const artistRaw = topBox.find("div:contains('von ')").text().trim();

  if (!link || !artistRaw || !title) return null;

  const artist = artistRaw.replace(/^von\s+/i, "").trim();

  return {
    href: link,
    title: title.toLowerCase(),
    artist: artist.toLowerCase(),
  };
}

// 5.2 Alle weiteren Treffer (unterhalb des Top-Treffers)
async function parseListHits($) {
  const results = [];

  $("a[href^='/songtext/']").each((i, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().trim();

    if (!title) return;

    const artistNode = $(el).parent().find("span:contains('von ')").text().trim();
    const artist = artistNode.replace(/^von\s+/i, "").trim();

    if (!artist) return;

    results.push({
      href,
      title: title.toLowerCase(),
      artist: artist.toLowerCase(),
    });
  });

  return results;
}

// 5.3 Beste Übereinstimmung suchen
async function findBestMatch(queryTitle, queryArtist) {
  const searchPage = await fetchRetry(searchUrl(`${queryTitle} ${queryArtist}`));
  const $ = cheerio.load(searchPage.data);

  const t = normalize(queryTitle);
  const a = normalize(queryArtist);

  // 1) Top-Treffer prüfen
  const top = await parseTopHit($);
  if (top) {
    if (fuzzy(top.title, t) && fuzzy(top.artist, a)) return top;
  }

  // 2) Restliche Treffer prüfen
  const list = await parseListHits($);

  // perfekte Treffer
  for (const r of list) {
    if (fuzzy(r.title, t) && fuzzy(r.artist, a)) {
      return r;
    }
  }

  // Titel passt, Artist egal
  for (const r of list) {
    if (fuzzy(r.title, t)) return r;
  }

  // fallback
  return top || list[0] || null;
}

// 5.4 Lyrics extrahieren
async function extractLyrics(href) {
  const url = "https://www.songtexte.com" + href;
  const res = await fetchRetry(url);

  const $ = cheerio.load(res.data);

  const lyrics =
    $("#lyrics").text().trim() ||
    $(".lyrics").text().trim() ||
    $(".songtext").text().trim() ||
    null;

  return { url, lyrics };
}

// ──────────────────────────────────────
// 6. /lyrics Route
// ──────────────────────────────────────

app.get("/lyrics", async (req, res) => {
  const titleInput = (req.query.title || "").trim();
  const artistInput = (req.query.artist || "").trim();

  if (!titleInput)
    return res.status(400).json({ success: false, error: "title fehlt" });

  const cached = cacheGet(titleInput, artistInput);
  if (cached) return res.json({ ...cached, cache: true });

  let finalTitle = titleInput;
  let finalArtist = artistInput;
  let geniusUrl = null;

  // Optional: Genius verbessern Titel/Artist
  const genius = await geniusSearch(`${titleInput} ${artistInput}`);
  if (genius) {
    finalTitle = genius.title || finalTitle;
    finalArtist = genius.artist || finalArtist;
    geniusUrl = genius.url;
  }

  // 1) Songtexte-Treffer suchen
  const match = await findBestMatch(finalTitle, finalArtist);
  if (!match)
    return res
      .status(404)
      .json({ success: false, error: "songtexte.com keine Treffer" });

  // 2) Lyrics laden
  const lyricsResult = await extractLyrics(match.href);
  if (!lyricsResult.lyrics)
    return res
      .status(404)
      .json({ success: false, error: "Keine Lyrics gefunden" });

  const response = {
    success: true,
    title: finalTitle,
    artist: finalArtist,
    lyrics: lyricsResult.lyrics,
    lyricsUrl: lyricsResult.url,
    geniusUrl,
    source: "genius + songtexte.com (top-hit aware)",
    cache: false,
  };

  cacheSet(titleInput, artistInput, response);

  res.json(response);
});

// ──────────────────────────────────────
// 7. Start
// ──────────────────────────────────────

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
