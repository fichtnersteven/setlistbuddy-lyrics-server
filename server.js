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
// 5. Songtexte.com — PRO Suche
// ──────────────────────────────────────

// 5.1 Such-URL
function songtexteSearchUrl(query) {
  return "https://www.songtexte.com/search?q=" + encodeURIComponent(query);
}

// 5.2 Trefferliste scrapen (Titel + Artist direkt!)
async function getSearchResults(query) {
  const res = await fetchRetry(songtexteSearchUrl(query));
  const $ = cheerio.load(res.data);

  const results = [];

  // Jeder Treffer ist ein Block aus <a> und einer darunterliegenden Artist-Zeile
  $("a[href^='/songtext/']").each((i, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().trim();

    // Künstler steht in der Zeile "von XYZ"
    const artistElem = $(el).parent().find("span").text().trim();
    const artist = artistElem.replace(/^von\s+/i, "");
    
    results.push({
      href,
      title: title.toLowerCase(),
      artist: artist.toLowerCase(),
    });
  });

  return results;
}

// Normalize für Vergleiche
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

// 5.3 Beste Übereinstimmung ermitteln
async function findBestMatch(queryTitle, queryArtist) {
  const res = await getSearchResults(`${queryTitle} ${queryArtist}`);

  if (!res.length) return null;

  const t = normalize(queryTitle);
  const a = normalize(queryArtist);

  // 1. Direkte perfekte Matches
  for (const r of res) {
    if (fuzzy(r.title, t) && fuzzy(r.artist, a)) return r;
  }

  // 2. Falls Titel stimmt, aber Artist leer oder anders
  for (const r of res) {
    if (fuzzy(r.title, t)) return r;
  }

  // 3. Fallback: allererster Treffer
  return res[0];
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

  // Songtexte.com Treffer auswählen
  const match = await findBestMatch(finalTitle, finalArtist);
  if (!match)
    return res
      .status(404)
      .json({ success: false, error: "songtexte.com keine Treffer" });

  // Lyrics extrahieren
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
    source: "genius + songtexte.com (enhanced)",
    cache: false,
  };

  cacheSet(titleInput, artistInput, response);

  res.json(response);
});

// ──────────────────────────────────────
// 7. Start Server
// ──────────────────────────────────────

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
