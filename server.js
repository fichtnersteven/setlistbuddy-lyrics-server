// server.js – PROXY VERSION for RENDER with automatic fallback
// Genius + songtexte.com + Google + Fuzzy Queries + Proxy Bypass + Section Detection

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";

const app = express();
app.use(cors());
app.use(express.json());

// Cache
const cache = new NodeCache({ stdTTL: 86400 });

// ------------ PROXY HELPERS --------------
async function proxiedGet(url) {
  const attempts = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    url // last resort: direct request
  ];

  for (const p of attempts) {
    try {
      const res = await axios.get(p, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36"
        },
        timeout: 8000
      });
      if (res?.data) return res;
    } catch (err) {
      continue; 
    }
  }

  return null;
}

// ---------- BASIC CLEANUP ----------
function cleanLyrics(txt) {
  return txt
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -------- SECTION DETECTION --------
function detectStructure(lyrics) {
  if (!lyrics) return [];
  const blocks = lyrics
    .split(/\n{2,}/)
    .map(b => b.trim())
    .filter(b => b.length > 0);

  if (!blocks.length) return [];
  if (blocks.length === 1) return [{ type: "Verse", text: blocks[0] }];

  return blocks.map(b => ({ type: "Verse", text: b }));
}

// ---------- GENIUS -----------
async function searchGenius(title, artist) {
  const q = `${title} ${artist}`.trim();
  const searchUrl = `https://genius.com/api/search/song?q=${encodeURIComponent(q)}`;

  try {
    const res = await proxiedGet(searchUrl);
    if (!res?.data?.response?.hits) return null;

    const result = res.data.response.hits[0]?.result;
    if (!result?.url) return null;

    const html = await proxiedGet(result.url);
    if (!html?.data) return null;

    const $ = cheerio.load(html.data);
    let lyrics = $("div[data-lyrics-container]").text().trim();
    if (!lyrics) return null;

    return { lyrics: cleanLyrics(lyrics), url: result.url };
  } catch {
    return null;
  }
}

// --------- SONGTEXTE -----------
async function searchSongtexte(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`.trim());
    const searchUrl = `https://www.songtexte.com/search?q=${q}`;

    const res = await proxiedGet(searchUrl);
    if (!res?.data) return null;

    const $ = cheerio.load(res.data);
    let best = $(".songs-list .song").first().find("a").attr("href");
    if (!best) return null;

    const page = await proxiedGet("https://www.songtexte.com" + best);
    if (!page?.data) return null;

    const $2 = cheerio.load(page.data);
    let lyrics = $2(".lyrics").text().trim();

    if (!lyrics) return null;

    return {
      lyrics: cleanLyrics(lyrics),
      url: "https://www.songtexte.com" + best
    };
  } catch {
    return null;
  }
}

// ---------- GOOGLE FALLBACK ----------
async function searchGoogle(title, artist) {
  const q = `${title} ${artist}`.trim();
  const url =
    "https://www.google.com/search?q=" + encodeURIComponent(q + " lyrics");

  try {
    const res = await proxiedGet(url);
    if (!res?.data) return null;

    const $ = cheerio.load(res.data);
    let candidates = [];

    $("div, span").each((i, el) => {
      const t = $(el).text().trim();
      if (t.length > 200 && t.length < 8000 && t.split("\n").length > 4) {
        candidates.push(t);
      }
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => b.split("\n").length - a.split("\n").length);
    return { lyrics: cleanLyrics(candidates[0]), url: null };
  } catch {
    return null;
  }
}

// ------------------- ROUTE -------------------
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.json({ success: false, error: "Missing title" });

  const t = title;
  const a = artist || "";

  const cached = cache.get(`${t.toLowerCase()}__${a.toLowerCase()}`);
  if (cached) return res.json(cached);

  // GENIUS
  const g = await searchGenius(t, a);
  if (g?.lyrics) {
    const resp = {
      success: true,
      title: t,
      artist: a,
      lyrics: g.lyrics,
      lyricsUrl: g.url,
      sections: detectStructure(g.lyrics),
      source: "genius"
    };
    cache.set(`${t.toLowerCase()}__${a.toLowerCase()}`, resp);
    return res.json(resp);
  }

  // SONGTEXTE
  const s = await searchSongtexte(t, a);
  if (s?.lyrics) {
    const resp = {
      success: true,
      title: t,
      artist: a,
      lyrics: s.lyrics,
      lyricsUrl: s.url,
      sections: detectStructure(s.lyrics),
      source: "songtexte"
    };
    cache.set(`${t.toLowerCase()}__${a.toLowerCase()}`, resp);
    return res.json(resp);
  }

  // GOOGLE
  const g2 = await searchGoogle(t, a);
  if (g2?.lyrics) {
    const resp = {
      success: true,
      title: t,
      artist: a,
      lyrics: g2.lyrics,
      lyricsUrl: null,
      sections: detectStructure(g2.lyrics),
      source: "google"
    };
    cache.set(`${t.toLowerCase()}__${a.toLowerCase()}`, resp);
    return res.json(resp);
  }

  return res.json({ success: false, error: "Kein Treffer" });
});

// ---------------- SERVER START -------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Lyrics server läuft auf Port ${PORT}`)
);
