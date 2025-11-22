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
// 2. Cache
// ──────────────────────────────────────
const CACHE_TTL = 1000 * 60 * 60; // 1h
const cache = new Map();

function getCacheKey(title, artist) {
  return `${title.toLowerCase()}::${artist.toLowerCase()}`;
}

function setCache(title, artist, data) {
  cache.set(getCacheKey(title, artist), {
    time: Date.now(),
    data,
  });
}

function getCache(title, artist) {
  const entry = cache.get(getCacheKey(title, artist));
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) return null;
  return entry.data;
}

// ──────────────────────────────────────
// 3. Axios mit Retry
// ──────────────────────────────────────
const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
  },
});

async function fetchRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await http.get(url);
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 + i * 300));
    }
  }
}

// ──────────────────────────────────────
// 4. Genius API
// ──────────────────────────────────────
async function geniusSearch(query) {
  const key = process.env.GENIUS_API_KEY;
  if (!key) return null;

  try {
    const resp = await axios.get("https://api.genius.com/search", {
      params: { q: query },
      headers: { Authorization: "Bearer " + key },
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
// 5. songtexte.com: Vollständiger Multi-Treffer-Scan
// ──────────────────────────────────────

// Step A: Suche auf songtexte.com
function songtexteSearchUrl(q) {
  return "https://www.songtexte.com/search?q=" + encodeURIComponent(q);
}

async function getSearchResults(query) {
  const res = await fetchRetry(songtexteSearchUrl(query));
  const $ = cheerio.load(res.data);

  const results = [];
  $("a[href^='/songtext/']").each((i, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim().toLowerCase();
    results.push({ href, text });
  });

  return results;
}

// Step B: Lade jede Lyrics-Seite, prüfe Artist + Titel
async function inspectSongtextePage(href) {
  const url = "https://www.songtexte.com" + href;
  const res = await fetchRetry(url);
  const $ = cheerio.load(res.data);

  const title = $(".headline").text().trim().toLowerCase();
  const artist = $(".artist a").text().trim().toLowerCase();

  const lyrics =
    $("#lyrics").text().trim() ||
    $(".lyrics").text().trim() ||
    $(".songtext").text().trim() ||
    null;

  return { url, title, artist, lyrics };
}

// Step C: Finde beste Übereinstimmung
async function findBestSongtexteMatch(queryTitle, queryArtist) {
  const results = await getSearchResults(`${queryTitle} ${queryArtist}`);

  if (!results.length) return null;

  const targetArtist = queryArtist.toLowerCase();
  const targetTitle = queryTitle.toLowerCase();

  let bestMatch = null;

  for (const item of results) {
    const info = await inspectSongtextePage(item.href);

    const artistMatch =
      info.artist.includes(targetArtist) || targetArtist.includes(info.artist);

    const titleMatch =
      info.title.includes(targetTitle) || targetTitle.includes(info.title);

    if (artistMatch && titleMatch) {
      return info; // perfekte Übereinstimmung
    }

    if (!bestMatch) bestMatch = info;
  }

  return bestMatch || null;
}

// ──────────────────────────────────────
// 6. Route: /lyrics
// ──────────────────────────────────────
app.get("/lyrics", async (req, res) => {
  const title = (req.query.title || "").trim();
  const artist = (req.query.artist || "").trim();

  if (!title)
    return res.status(400).json({ success: false, error: "title fehlt" });

  const cached = getCache(title, artist);
  if (cached) return res.json({ ...cached, cache: true });

  let finalTitle = title;
  let finalArtist = artist;
  let geniusUrl = null;

  const genius = await geniusSearch(`${title} ${artist}`);
  if (genius) {
    finalTitle = genius.title || finalTitle;
    finalArtist = genius.artist || finalArtist;
    geniusUrl = genius.url;
  }

  const match = await findBestSongtexteMatch(finalTitle, finalArtist);
  if (!match)
    return res
      .status(404)
      .json({ success: false, error: "songtexte.com keine Treffer" });

  if (!match.lyrics)
    return res
      .status(404)
      .json({ success: false, error: "Lyrics nicht gefunden" });

  const payload = {
    success: true,
    title: finalTitle,
    artist: finalArtist,
    lyrics: match.lyrics,
    lyricsUrl: match.url,
    geniusUrl,
    source: "genius + songtexte.com",
    cache: false,
  };

  setCache(title, artist, payload);

  res.json(payload);
});

// ──────────────────────────────────────
// 7. Start
// ──────────────────────────────────────
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
