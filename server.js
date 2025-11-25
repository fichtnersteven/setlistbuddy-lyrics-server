// server.js – Ultra-Reliable Scraper for Render
// ✔ Keine externen Proxy-Dienste
// ✔ Direkte Requests mit Anti-Blocker-Headers
// ✔ Funktioniert stabil auf Render
// ✔ Quellen: Genius + Songtexte.com
// ✔ Automatische Strukturierung (Verses)

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------
   CACHE
--------------------------------------------------------- */
const cache = new NodeCache({ stdTTL: 86400 });

function makeCacheKey(title, artist) {
  return `${(title || "").toLowerCase()}__${(artist || "").toLowerCase()}`;
}

/* ---------------------------------------------------------
   AXIOS INSTANCE – Anti-Blocker
--------------------------------------------------------- */
const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  },
  validateStatus: () => true,
});

/* ---------------------------------------------------------
   CLEANUP
--------------------------------------------------------- */
function cleanLyrics(txt) {
  return txt
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------------------------------------------------------
   SIMPLE SECTION SPLIT
--------------------------------------------------------- */
function detectStructure(lyrics) {
  if (!lyrics) return [];

  const blocks = lyrics
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  return blocks.map((block) => ({
    type: "Verse",
    text: block,
  }));
}

/* ---------------------------------------------------------
   GENIUS SCRAPER
--------------------------------------------------------- */
async function searchGenius(title, artist) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`.trim());
    const searchUrl = `https://genius.com/api/search/song?q=${query}`;

    const res = await http.get(searchUrl);
    const hits = res?.data?.response?.hits || [];
    if (!hits.length) return null;

    const best = hits[0].result;
    if (!best?.url) return null;

    const html = await http.get(best.url);
    const $ = cheerio.load(html.data);

    const raw = $("div[data-lyrics-container]").text().trim();
    if (!raw) return null;

    return {
      lyrics: cleanLyrics(raw),
      url: best.url,
    };
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------
   SONGTEXTE.COM SCRAPER
--------------------------------------------------------- */
async function searchSongtexte(title, artist) {
  try {
    const query = encodeURIComponent(`${title} ${artist}`.trim());
    const searchUrl = `https://www.songtexte.com/search?q=${query}`;

    const res = await http.get(searchUrl);
    const $ = cheerio.load(res.data);

    const bestLink = $(".songs-list .song a").first().attr("href");
    if (!bestLink) return null;

    const page = await http.get("https://www.songtexte.com" + bestLink);
    const $2 = cheerio.load(page.data);

    const raw = $2(".lyrics").text().trim();
    if (!raw) return null;

    return {
      lyrics: cleanLyrics(raw),
      url: "https://www.songtexte.com" + bestLink,
    };
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------
   API ROUTE
--------------------------------------------------------- */
app.get("/lyrics", async (req, res) => {
  const { title, artist = "" } = req.query;

  if (!title) {
    return res.json({ success: false, error: "Missing title" });
  }

  const key = makeCacheKey(title, artist);
  const cached = cache.get(key);
  if (cached) {
    return res.json({ ...cached, cache: true });
  }

  // 1. GENIUS
  const g = await searchGenius(title, artist);
  if (g?.lyrics) {
    const resp = {
      success: true,
      title,
      artist,
      lyrics: g.lyrics,
      lyricsUrl: g.url,
      sections: detectStructure(g.lyrics),
      source: "genius",
    };
    cache.set(key, resp);
    return res.json(resp);
  }

  // 2. SONGTEXTE
  const s = await searchSongtexte(title, artist);
  if (s?.lyrics) {
    const resp = {
      success: true,
      title,
      artist,
      lyrics: s.lyrics,
      lyricsUrl: s.url,
      sections: detectStructure(s.lyrics),
      source: "songtexte",
    };
    cache.set(key, resp);
    return res.json(resp);
  }

  return res.json({
    success: false,
    error: "Kein Treffer",
  });
});

/* ---------------------------------------------------------
   START SERVER
--------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lyrics server läuft auf Port ${PORT}`);
});
