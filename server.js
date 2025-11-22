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
const CACHE_TTL = 1000 * 60 * 60;
const cache = new Map();

function cacheKey(title, artist) {
  return `${title.toLowerCase()}::${artist.toLowerCase()}`;
}

function cacheGet(title, artist) {
  const item = cache.get(cacheKey(title, artist));
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) return null;
  return item.data;
}

function cacheSet(title, artist, data) {
  cache.set(cacheKey(title, artist), {
    data,
    timestamp: Date.now(),
  });
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
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 + i * 300));
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

    const best = resp?.data?.response?.hits?.[0]?.result;
    if (!best) return null;

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
// 5. songtexte.com Scraping — Profi Version
// ──────────────────────────────────────

// 5.1 Such-URL erzeugen
function searchUrl(query) {
  return "https://www.songtexte.com/search?q=" + encodeURIComponent(query);
}

// 5.2 Alle Treffer holen
async function getSongtexteSearchResults(query) {
  const res = await fetchRetry(searchUrl(query));
  const $ = cheerio.load(res.data);

  const results = [];
  $("a[href^='/songtext/']").each((i, el) => {
    results.push({
      href: $(el).attr("href"),
      text: $(el).text().trim().toLowerCase(),
    });
  });

  return results;
}

// 5.3 Lyrics-Seite öffnen und Artist/Titel aus <title> extrahieren
async function inspectSongPage(href) {
  const url = "https://www.songtexte.com" + href;
  const res = await fetchRetry(url);
  const html = res.data;

  const $ = cheerio.load(html);

  // <title> enthält IMMER artist + title
  // Beispiel: "<title>Nothing Else Matters Songtext von Metallica - Songtexte.com</title>"
  const titleTag = $("title").text().trim().toLowerCase();

  let extractedTitle = null;
  let extractedArtist = null;

  // Titel und Artist extrahieren
  const titleMatch = titleTag.match(/(.*?) songtext von/i);
  const artistMatch = titleTag.match(/songtext von (.*?) -/i);

  if (titleMatch) extractedTitle = titleMatch[1].trim().toLowerCase();
  if (artistMatch) extractedArtist = artistMatch[1].trim().toLowerCase();

  // Lyrics extrahieren
  const lyrics =
    $("#lyrics").text().trim() ||
    $(".lyrics").text().trim() ||
    $(".songtext").text().trim() ||
    null;

  return {
    url,
    title: extractedTitle,
    artist: extractedArtist,
    lyrics,
  };
}

// 5.4 beste Übereinstimmung suchen
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function isFuzzyMatch(a, b) {
  a = normalize(a);
  b = normalize(b);
  return a.includes(b) || b.includes(a);
}

async function findBestSong(queryTitle, queryArtist) {
  const results = await getSongtexteSearchResults(
    `${queryTitle} ${queryArtist}`
  );
  if (!results.length) return null;

  const targetTitle = normalize(queryTitle);
  const targetArtist = normalize(queryArtist);

  let best = null;

  for (const r of results) {
    const info = await inspectSongPage(r.href);

    if (!info.title || !info.artist) continue;

    const titleMatch = isFuzzyMatch(info.title, targetTitle);
    const artistMatch = isFuzzyMatch(info.artist, targetArtist);

    if (titleMatch && artistMatch) {
      return info; // perfekte Übereinstimmung
    }

    if (!best) best = info;
  }

  return best;
}

// ──────────────────────────────────────
// 6. /lyrics Route
// ──────────────────────────────────────
app.get("/lyrics", async (req, res) => {
  const title = (req.query.title || "").trim();
  const artist = (req.query.artist || "").trim();

  if (!title) {
    return res.status(400).json({
      success: false,
      error: "Parameter 'title' fehlt.",
    });
  }

  const cached = cacheGet(title, artist);
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

  const match = await findBestSong(finalTitle, finalArtist);

  if (!match)
    return res.status(404).json({
      success: false,
      error: "songtexte.com hat keinen passenden Song gefunden.",
    });

  if (!match.lyrics)
    return res.status(404).json({
      success: false,
      error: "Lyrics konnten nicht extrahiert werden.",
    });

  const response = {
    success: true,
    title: finalTitle,
    artist: finalArtist,
    lyrics: match.lyrics,
    lyricsUrl: match.url,
    geniusUrl,
    source: "genius + songtexte.com",
    cache: false,
  };

  cacheSet(title, artist, response);

  res.json(response);
});

// ──────────────────────────────────────
// 7. Start Server
// ──────────────────────────────────────
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
