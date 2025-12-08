// server.js – Clean 2025 Version
// Features:
// - /lyrics?title=&artist=  → Genius → songtexte.com → Google-Fallback
// - Caching (NodeCache)
// - /health endpoint
// - Express + CORS

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// Basis-Setup
// ---------------------------------------------------------
app.use(cors());
app.use(express.json());

// axios Default-Timeout
axios.defaults.timeout = 8000;

// Cache: 24h
const cache = new NodeCache({ stdTTL: 60 * 60 * 24 });

// ---------------------------------------------------------
// Helper
// ---------------------------------------------------------
function normalize(str = "") {
  return str
    .toLowerCase()
    .replace(/\(.*?\)/g, "") // Klammern-Inhalt entfernen (Remaster etc.)
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9äöüß ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeCacheKey(title, artist) {
  return `${normalize(title)}__${normalize(artist)}`;
}

function cacheGet(title, artist) {
  return cache.get(makeCacheKey(title, artist));
}

function cacheSet(title, artist, data) {
  cache.set(makeCacheKey(title, artist), data);
}

// Ganz einfache Sections-Erkennung: trennt nach Leerzeilen
function detectSections(lyrics) {
  if (!lyrics) return [];
  const blocks = lyrics.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, i) => ({
    label: `Part ${i + 1}`,
    text: block,
  }));
}

// ---------------------------------------------------------
// Scraper 1 – Genius
// ---------------------------------------------------------
async function scrapeGenius(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const searchUrl = `https://genius.com/api/search/song?q=${q}`;

    const searchRes = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/plain, */*",
      },
    });

    const hits = searchRes.data?.response?.sections?.[0]?.hits || [];
    if (!hits.length) return { success: false, reason: "no_hits" };

    // Nimm einfach den ersten Treffer
    const best = hits[0].result;
    const songUrl = best.url;
    if (!songUrl) return { success: false, reason: "no_url" };

    const pageRes = await axios.get(songUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(pageRes.data);

    // Genius Lyrics-Container (Stand: data-lyrics-container)
    const containers = $('[data-lyrics-container="true"]');
    if (!containers.length) {
      return { success: false, reason: "no_lyrics_container" };
    }

    let lyrics = "";
    containers.each((_, el) => {
      const t = $(el).text().trim();
      if (t) lyrics += t + "\n";
    });
    lyrics = lyrics.trim();

    if (!lyrics) return { success: false, reason: "empty_lyrics" };

    return {
      success: true,
      source: "genius",
      title: best.full_title || title,
      artist: best.primary_artist?.name || artist,
      lyrics,
    };
  } catch (err) {
    console.log("❌ Genius-Scraper Fehler:", err.message);
    return { success: false, reason: "error" };
  }
}

// ---------------------------------------------------------
// Scraper 2 – songtexte.com
// ---------------------------------------------------------
async function scrapeSongtexte(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const searchUrl = `https://www.songtexte.com/search?q=${q}`;

    const searchRes = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(searchRes.data);

    // TopHit zuerst versuchen
    let songUrl = $(".topHitBox .topHitLink").attr("href");

    // Falls kein TopHit: erste Zeile aus der Trefferliste
    if (!songUrl) {
      const firstRow = $(".songResultTable .row .title a").first();
      songUrl = firstRow.attr("href");
    }

    if (!songUrl) {
      return { success: false, reason: "no_result" };
    }

    if (!songUrl.startsWith("http")) {
      songUrl = "https://www.songtexte.com" + songUrl;
    }

    const pageRes = await axios.get(songUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $$ = cheerio.load(pageRes.data);

    // songtexte.com Lyrics sind meist im #lyrics-Container
    let lyrics = $$("#lyrics").text().trim();
    if (!lyrics) {
      // Fallback
      lyrics = $$(".lyrics").text().trim();
    }

    if (!lyrics) {
      return { success: false, reason: "empty_lyrics" };
    }

    // Titel/Artist versuchen auszulesen
    const pageTitle = $$("h1").first().text().trim() || title;
    const pageArtist = $$(".artist a").first().text().trim() || artist;

    return {
      success: true,
      source: "songtexte.com",
      title: pageTitle,
      artist: pageArtist,
      lyrics,
    };
  } catch (err) {
    console.log("❌ songtexte.com-Scraper Fehler:", err.message);
    return { success: false, reason: "error" };
  }
}

// ---------------------------------------------------------
// Scraper 3 – Google Fallback (sehr einfach, kann wackeln)
// ---------------------------------------------------------
async function scrapeGoogle(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist} lyrics`);
    const url = `https://www.google.com/search?q=${q}&hl=de`;

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const $ = cheerio.load(res.data);

    // Dies ist heuristisch und kann sich ändern
    // Oft stecken die Lyrics-Snippets in BNeawe-Divs
    let lyrics = "";
    $("div.BNeawe.tAd8D.AP7Wnd").each((_, el) => {
      const t = $(el).text();
      if (t && t.includes("\n")) {
        lyrics = t.trim();
        return false; // break
      }
    });

    if (!lyrics) {
      return { success: false, reason: "no_snippet" };
    }

    return {
      success: true,
      source: "google",
      title,
      artist,
      lyrics,
    };
  } catch (err) {
    console.log("❌ Google-Scraper Fehler:", err.message);
    return { success: false, reason: "error" };
  }
}

// ---------------------------------------------------------
// Haupt-Route: /lyrics
// ---------------------------------------------------------
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;

  if (!title || !artist) {
    return res.status(400).json({
      success: false,
      error: "Missing 'title' or 'artist' query parameter",
    });
  }

  const cacheHit = cacheGet(title, artist);
  if (cacheHit) {
    return res.json({
      success: true,
      cached: true,
      ...cacheHit,
    });
  }

  // 1. Genius
  const genius = await scrapeGenius(title, artist);
  if (genius.success) {
    const sections = detectSections(genius.lyrics);
    const payload = { ...genius, sections };
    cacheSet(title, artist, payload);
    return res.json({
      success: true,
      cached: false,
      ...payload,
    });
  }

  // 2. songtexte.com
  const st = await scrapeSongtexte(title, artist);
  if (st.success) {
    const sections = detectSections(st.lyrics);
    const payload = { ...st, sections };
    cacheSet(title, artist, payload);
    return res.json({
      success: true,
      cached: false,
      ...payload,
    });
  }

  // 3. Google
  const google = await scrapeGoogle(title, artist);
  if (google.success) {
    const sections = detectSections(google.lyrics);
    const payload = { ...google, sections };
    cacheSet(title, artist, payload);
    return res.json({
      success: true,
      cached: false,
      ...payload,
    });
  }

  // Nichts gefunden
  return res.status(404).json({
    success: false,
    error: "No lyrics found from any source",
    geniusReason: genius.reason,
    songtexteReason: st.reason,
    googleReason: google.reason,
  });
});

// ---------------------------------------------------------
// Health Check
// ---------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------------------------------------------------------
// Start Server
// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🎵 Lyrics-Server läuft auf Port ${PORT}`);
});
app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft ✔️");
});
