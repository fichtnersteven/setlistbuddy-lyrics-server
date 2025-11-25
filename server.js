// server.js – erweiterte & Railway-kompatible Version
// Features: Genius + songtexte.com + Google-Fallback + Fuzzy-Suche + Section-Detection + Caching

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

function cacheKey(title, artist) {
  return `${(title || "").toLowerCase()}__${(artist || "").toLowerCase()}`;
}

function cacheGet(title, artist) {
  return cache.get(cacheKey(title, artist));
}
function cacheSet(title, artist, data) {
  cache.set(cacheKey(title, artist), data);
}

/* ---------------------------------------------------------
   HTTP WRAPPER WITH RETRIES
--------------------------------------------------------- */
async function fetchRetry(url, tries = 3) {
  while (tries--) {
    try {
      return await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
        },
        timeout: 7000,
      });
    } catch (e) {
      if (tries === 0) throw e;
    }
  }
}

/* ---------------------------------------------------------
   STRING / FUZZY HELPERS
--------------------------------------------------------- */
function normalizeBasic(str = "") {
  return str
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateSearchQueries(title = "", artist = "") {
  const tOriginal = title.trim();
  const aOriginal = (artist || "").trim();

  const tNorm = normalizeBasic(tOriginal);
  const aNorm = normalizeBasic(aOriginal);

  const queries = new Set();

  if (tOriginal && aOriginal) {
    queries.add(`${tOriginal} ${aOriginal} lyrics`);
    queries.add(`${aOriginal} ${tOriginal} lyrics`);
    queries.add(`${tOriginal} ${aOriginal} songtext`);
  }

  if (tNorm && aNorm) {
    queries.add(`${tNorm} ${aNorm} lyrics`);
    queries.add(`${aNorm} ${tNorm} lyrics`);
    queries.add(`${tNorm} ${aNorm} songtext`);
  }

  if (tOriginal) {
    queries.add(`${tOriginal} lyrics`);
    queries.add(`${tOriginal} songtext`);
  }
  if (tNorm) {
    queries.add(`${tNorm} lyrics`);
    queries.add(`${tNorm} songtext`);
  }

  if (!tOriginal && aOriginal) {
    queries.add(`${aOriginal} lyrics`);
    queries.add(`${aNorm} lyrics`);
  }

  return Array.from(queries).slice(0, 6);
}

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
   SECTION DETECTION V2 (Block-basiert)
--------------------------------------------------------- */
function detectStructure(lyrics) {
  if (!lyrics) return [];

  const blocks = lyrics
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  if (!blocks.length) return [];
  if (blocks.length === 1) return [{ type: "Verse", text: blocks[0] }];

  const normBlock = (b) =>
    normalizeBasic(
      b.replace(/\n/g, " ").replace(/\s+/g, " ").trim()
    );

  const counts = new Map();
  blocks.forEach((b) => {
    const key = normBlock(b);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  let chorusKey = null;
  let maxCount = 1;
  for (const [key, cnt] of counts.entries()) {
    if (cnt > maxCount && key.length > 10) {
      maxCount = cnt;
      chorusKey = key;
    }
  }

  let hasBridge = false;
  const sections = [];

  blocks.forEach((block, index) => {
    const key = normBlock(block);
    let type = "Verse";

    if (chorusKey && key === chorusKey) {
      type = "Chorus";
    } else if (index === blocks.length - 1 && blocks.length > 2 && !chorusKey) {
      type = "Outro";
    } else if (
      index >= 1 &&
      index < blocks.length - 1 &&
      !hasBridge &&
      !chorusKey
    ) {
      type = "Bridge";
      hasBridge = true;
    }

    sections.push({ type, text: block });
  });

  return sections;
}

/* ---------------------------------------------------------
   GENIUS SEARCH
--------------------------------------------------------- */
async function searchGenius(query) {
  const searchUrl = `https://genius.com/api/search/song?q=${encodeURIComponent(
    query
  )}`;

  try {
    const res = await fetchRetry(searchUrl);
    const hits = res.data?.response?.hits;
    if (!hits || !hits.length) return null;

    const best = hits[0].result;
    const url = best.url;

    const html = await fetchRetry(url);
    const $ = cheerio.load(html.data);

    let lyrics = $("div[data-lyrics-container]").text().trim();
    if (!lyrics) return null;

    return { lyrics: cleanLyrics(lyrics), url };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   SONGTEXTE.COM SCRAPER
--------------------------------------------------------- */
async function searchSongtexte(query) {
  try {
    const q = encodeURIComponent(query);
    const url = `https://www.songtexte.com/search?q=${q}`;

    const res = await fetchRetry(url);
    const $ = cheerio.load(res.data);

    let bestLink = $(".songs-list .song").first().find("a").attr("href");
    if (!bestLink) return null;

    const page = await fetchRetry("https://www.songtexte.com" + bestLink);
    const $2 = cheerio.load(page.data);

    let lyrics = $2(".lyrics").text().trim();
    if (!lyrics) return null;

    return {
      lyrics: cleanLyrics(lyrics),
      url: "https://www.songtexte.com" + bestLink,
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   GOOGLE FALLBACK V2
--------------------------------------------------------- */
async function googleFallback(query) {
  const url =
    "https://www.google.com/search?q=" + encodeURIComponent(query + " lyrics");

  try {
    const res = await fetchRetry(url);
    const $ = cheerio.load(res.data);

    let candidates = [];

    $("div, span").each((i, el) => {
      const t = $(el).text().trim();
      if (!t) return;
      if (t.length < 200 || t.length > 8000) return;
      if (/wikipedia|deezer|spotify|video|youtube/i.test(t)) return;
      if (/bedeutung|translation|übersetzung|interpretation/i.test(t)) return;
      if (t.split("\n").length < 4) return;

      candidates.push(t);
    });

    if (!candidates.length) return null;

    candidates.sort(
      (a, b) => b.split("\n").length - a.split("\n").length
    );

    const best = candidates[0];
    return { lyrics: cleanLyrics(best), url: null };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   API ROUTE
--------------------------------------------------------- */
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;

  if (!title) {
    return res.json({ success: false, error: "Missing title" });
  }

  const finalArtist = artist || "";
  const finalTitle = title;

  const cached = cacheGet(finalTitle, finalArtist);
  if (cached) return res.json({ ...cached, cache: true });

  const queries = generateSearchQueries(finalTitle, finalArtist);

  // 1) Genius
  for (const q of queries) {
    const r = await searchGenius(q);
    if (r?.lyrics) {
      const sections = detectStructure(r.lyrics);
      const resp = {
        success: true,
        title: finalTitle,
        artist: finalArtist,
        lyrics: r.lyrics,
        lyricsUrl: r.url,
        sections,
        source: "genius",
      };
      cacheSet(finalTitle, finalArtist, resp);
      return res.json(resp);
    }
  }

  // 2) Songtexte
  for (const q of queries) {
    const r = await searchSongtexte(q);
    if (r?.lyrics) {
      const sections = detectStructure(r.lyrics);
      const resp = {
        success: true,
        title: finalTitle,
        artist: finalArtist,
        lyrics: r.lyrics,
        lyricsUrl: r.url,
        sections,
        source: "songtexte",
      };
      cacheSet(finalTitle, finalArtist, resp);
      return res.json(resp);
    }
  }

  // 3) Google Fallback
  for (const q of queries) {
    const r = await googleFallback(q);
    if (r?.lyrics) {
      const sections = detectStructure(r.lyrics);
      const resp = {
        success: true,
        title: finalTitle,
        artist: finalArtist,
        lyrics: r.lyrics,
        lyricsUrl: null,
        sections,
        source: "google-fallback",
      };
      cacheSet(finalTitle, finalArtist, resp);
      return res.json(resp);
    }
  }

  res.json({ success: false, error: "Kein Treffer" });
});

/* ---------------------------------------------------------
   START SERVER (Railway)
--------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Lyrics server läuft auf Port ${PORT}`)
);
