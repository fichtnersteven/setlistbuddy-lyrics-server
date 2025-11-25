// server.js – Ultra-Reliable Lyrics Scraper for Render (2025)
// ✔ Neuer Genius-Scraper (JSON + Sections + Fallbacks)
// ✔ Neuer Songtexte.com-Scraper (2025 HTML-Struktur + Fallbacks)
// ✔ Debug-Routen für HTML-Analyse (Genius + Songtexte)
// ✔ Keine Proxies, direkt & stabil
// ✔ Anti-Blocker Headers
// ✔ Render-kompatibel (kein Port-Fallback)
// ✔ Cache, Test, Sec. Detection

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
  timeout: 15000,
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
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------------------------------------------------------
   SECTION DETECTION
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
   GENIUS SCRAPER (2025)
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

    const htmlRes = await http.get(best.url);
    const html = htmlRes.data;

    const match = html.match(/__PRELOADED_STATE__\s*=\s*(\{.*?\});/s);
    if (!match) return null;

    const data = JSON.parse(match[1]);
    const ld = data?.songPage?.lyricsData;
    if (!ld) return null;

    let lyrics =
      ld?.lyricsData?.body?.plain ||
      ld?.lyricsData?.body?.html ||
      null;

    if (!lyrics && ld?.lyricsData?.sections) {
      lyrics = ld.lyricsData.sections
        .map((sec) => sec.plain || sec.lyrics || sec.html || "")
        .join("\n\n");
    }

    if (!lyrics && ld?.body?.html) lyrics = ld.body.html;
    if (!lyrics && ld?.body?.plain) lyrics = ld.body.plain;

    if (!lyrics) return null;

    return {
      lyrics: cleanLyrics(lyrics),
      url: best.url,
    };
  } catch (e) {
    console.log("Genius error:", e.toString());
    return null;
  }
}

/* ---------------------------------------------------------
   SONGTEXTE.COM SCRAPER (2025)
--------------------------------------------------------- */
async function searchSongtexte(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`.trim());
    const searchUrl = `https://www.songtexte.com/search?q=${q}`;

    const res = await http.get(searchUrl);
    const $ = cheerio.load(res.data);

    let bestLink =
      $("a.song").first().attr("href") ||
      $(".songs-list .song a").first().attr("href") ||
      $("a.ste-result").first().attr("href") ||
      null;

    if (!bestLink) return null;

    const page = await http.get("https://www.songtexte.com" + bestLink);
    const $2 = cheerio.load(page.data);

    let raw =
      $2("#lyrics").text().trim() ||
      $2("#songtext").text().trim() ||
      $2(".lyrics").text().trim() ||
      "";

    if (!raw) return null;

    return {
      lyrics: cleanLyrics(raw),
      url: "https://www.songtexte.com" + bestLink,
    };
  } catch (e) {
    console.log("Songtexte error:", e.toString());
    return null;
  }
}

/* ---------------------------------------------------------
   DEBUG ROUTES (IMPORTANT!)
--------------------------------------------------------- */

// Show raw HTML of Genius lyrics page
app.get("/debug/genius", async (req, res) => {
  try {
    const url = "https://genius.com/Metallica-nothing-else-matters-lyrics";
    const r = await http.get(url);
    res.send(r.data.slice(0, 5000));
  } catch (e) {
    res.json({ error: e.toString() });
  }
});

// Show raw HTML from Songtexte.com search
app.get("/debug/songtexte-search", async (req, res) => {
  try {
    const url =
      "https://www.songtexte.com/search?q=Nothing%20Else%20Matters%20Metallica";
    const r = await http.get(url);
    res.send(r.data.slice(0, 5000));
  } catch (e) {
    res.json({ error: e.toString() });
  }
});

// Show raw HTML of Songtexte lyrics page
app.get("/debug/songtexte", async (req, res) => {
  try {
    const url =
      "https://www.songtexte.com/songtext/metallica/nothing-else-matters-6926.html";
    const r = await http.get(url);
    res.send(r.data.slice(0, 5000));
  } catch (e) {
    res.json({ error: e.toString() });
  }
});

/* ---------------------------------------------------------
   TEST ROUTE
--------------------------------------------------------- */
app.get("/test", async (req, res) => {
  try {
    const r = await axios.get("https://example.com");
    res.json({
      success: true,
      status: r.status,
      snippet: String(r.data).slice(0, 200),
    });
  } catch (e) {
    res.json({
      success: false,
      error: e.toString(),
    });
  }
});

/* ---------------------------------------------------------
   MAIN API ROUTE
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
   START SERVER (Render Port)
--------------------------------------------------------- */
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Lyrics server läuft auf Port ${PORT}`);
});
