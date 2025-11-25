// server.js – komplette neu aufgebaute Version
// Features: Genius + songtexte.com + Google Fallback + Section Detection + Caching

import express from "express";
import axios from "axios";
import cheerio from "cheerio";
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
  return `${title.toLowerCase()}__${artist.toLowerCase()}`;
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
   CLEANUP
--------------------------------------------------------- */
function cleanLyrics(txt) {
  return txt
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------------------------------------------------------
   SECTION DETECTION
--------------------------------------------------------- */
function detectStructure(lyrics) {
  const lines = lyrics.split("\n").map((l) => l.trim());

  let sections = [];
  let buffer = [];
  let type = "Verse";

  const isChorusCandidate = (line) =>
    line.length > 0 &&
    /^[A-Za-zÄÖÜäöüß].+/.test(line) &&
    line.length < 120;

  let repeatCheck = {};
  lines.forEach((l) => {
    repeatCheck[l] = (repeatCheck[l] || 0) + 1;
  });

  let chorusLines = Object.entries(repeatCheck)
    .filter(([k, v]) => v >= 2 && k.length > 5)
    .map(([k]) => k);

  let chorusMode = false;

  for (const line of lines) {
    if (chorusLines.includes(line)) {
      if (!chorusMode && buffer.length) {
        sections.push({ type, text: buffer.join("\n") });
        buffer = [];
      }
      type = "Chorus";
      chorusMode = true;
      buffer.push(line);
    } else {
      chorusMode = false;
      if (buffer.length && type !== "Verse") {
        sections.push({ type, text: buffer.join("\n") });
        buffer = [];
      }
      type = "Verse";
      buffer.push(line);
    }
  }

  if (buffer.length) {
    sections.push({ type, text: buffer.join("\n") });
  }

  return sections;
}

/* ---------------------------------------------------------
   GENIUS SEARCH
--------------------------------------------------------- */
async function searchGenius(title, artist) {
  const q = encodeURIComponent(`${title} ${artist}`);
  const searchUrl = `https://genius.com/api/search/song?q=${q}`;

  try {
    const res = await fetchRetry(searchUrl);
    const hits = res.data.response.hits;
    if (!hits || !hits.length) return null;

    const best = hits[0].result;
    const url = best.url;
    const html = await fetchRetry(url);
    const $ = cheerio.load(html.data);

    let lyrics = $("div[data-lyrics-container]")
      .text()
      .replace(/\n{3,}/g, "\n")
      .trim();

    if (!lyrics) return null;

    return { lyrics: cleanLyrics(lyrics), url };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   SONGTEXTE.COM SCRAPER
--------------------------------------------------------- */
async function searchSongtexte(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
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
   GOOGLE FALLBACK (neu)
--------------------------------------------------------- */
async function googleFallback(title, artist) {
  const query = `${title} ${artist} lyrics`;
  const url = "https://www.google.com/search?q=" + encodeURIComponent(query);

  try {
    const res = await fetchRetry(url);
    const $ = cheerio.load(res.data);
    let candidates = [];

    $("div, span").each((i, el) => {
      const t = $(el).text().trim();
      if (!t) return;
      if (t.length < 200 || t.length > 5000) return;
      if (/wikipedia|deezer|spotify|video/i.test(t)) return;
      if (/bedeutung|translation|übersetzung/i.test(t)) return;
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

  if (!title) return res.json({ success: false, error: "Missing title" });

  const finalArtist = artist || "";
  const finalTitle = title;

  // CACHE
  const cached = cacheGet(finalTitle, finalArtist);
  if (cached) return res.json({ ...cached, cache: true });

  // GENIUS
  const g = await searchGenius(finalTitle, finalArtist);

  if (g?.lyrics) {
    const sections = detectStructure(g.lyrics);
    const resp = {
      success: true,
      title: finalTitle,
      artist: finalArtist,
      lyrics: g.lyrics,
      lyricsUrl: g.url,
      sections,
      source: "genius",
      cache: false,
    };
    cacheSet(finalTitle, finalArtist, resp);
    return res.json(resp);
  }

  // SONGTEXTE
  const s = await searchSongtexte(finalTitle, finalArtist);
  if (s?.lyrics) {
    const sections = detectStructure(s.lyrics);
    const resp = {
      success: true,
      title: finalTitle,
      artist: finalArtist,
      lyrics: s.lyrics,
      lyricsUrl: s.url,
      sections,
      source: "songtexte",
      cache: false,
    };
    cacheSet(finalTitle, finalArtist, resp);
    return res.json(resp);
  }

  // GOOGLE FALLBACK
  const g2 = await googleFallback(finalTitle, finalArtist);
  if (g2?.lyrics) {
    const sections = detectStructure(g2.lyrics);
    const resp = {
      success: true,
      title: finalTitle,
      artist: finalArtist,
      lyrics: g2.lyrics,
      lyricsUrl: null,
      sections,
      source: "google-fallback",
      cache: false,
    };
    cacheSet(finalTitle, finalArtist, resp);
    return res.json(resp);
  }

  return res.json({ success: false, error: "Kein Treffer" });
});

/* ---------------------------------------------------------
   START SERVER
--------------------------------------------------------- */
app.listen(3000, () => console.log("Lyrics server läuft auf Port 3000"));
