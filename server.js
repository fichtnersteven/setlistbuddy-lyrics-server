import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";

const app = express();
app.use(cors());
app.use(express.json());

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

/* CLEANUP */
function cleanLyrics(txt) {
  return txt
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* Section Detection (Basic) */
function detectStructure(lyrics) {
  if (!lyrics) return [];

  const blocks = lyrics
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  if (!blocks.length) return [];
  if (blocks.length === 1) return [{ type: "Verse", text: blocks[0] }];

  return blocks.map((text) => ({
    type: "Verse",
    text,
  }));
}

/* GENIUS */
async function searchGenius(title, artist) {
  const q = `${title} ${artist}`.trim();
  const searchUrl = `https://genius.com/api/search/song?q=${encodeURIComponent(q)}`;

  try {
    const res = await fetchRetry(searchUrl);
    const hits = res.data?.response?.hits;
    if (!hits || !hits.length) return null;

    const best = hits[0].result;
    const html = await fetchRetry(best.url);
    const $ = cheerio.load(html.data);

    let lyrics = $("div[data-lyrics-container]").text().trim();
    if (!lyrics) return null;

    return {
      lyrics: cleanLyrics(lyrics),
      url: best.url,
    };
  } catch {
    return null;
  }
}

/* SONGTEXTE.COM */
async function searchSongtexte(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`.trim());
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

/* GOOGLE FALLBACK */
async function googleFallback(title, artist) {
  const q = `${title} ${artist}`.trim();
  const url =
    "https://www.google.com/search?q=" + encodeURIComponent(q + " lyrics");

  try {
    const res = await fetchRetry(url);
    const $ = cheerio.load(res.data);
    let candidates = [];

    $("div, span").each((i, el) => {
      const t = $(el).text().trim();
      if (!t) return;
      if (t.length < 200 || t.length > 8000) return;
      if (/wikipedia|deezer|spotify|video|youtube/i.test(t)) return;
      if (t.split("\n").length < 4) return;

      candidates.push(t);
    });

    if (!candidates.length) return null;

    candidates.sort(
      (a, b) => b.split("\n").length - a.split("\n").length
    );

    return { lyrics: cleanLyrics(candidates[0]), url: null };
  } catch {
    return null;
  }
}

/* ROUTE */
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.json({ success: false, error: "Missing title" });

  const finalArtist = artist || "";
  const finalTitle = title;

  const cached = cacheGet(finalTitle, finalArtist);
  if (cached) return res.json({ ...cached, cache: true });

  // Genius
  const g1 = await searchGenius(finalTitle, finalArtist);
  if (g1?.lyrics) {
    const sections = detectStructure(g1.lyrics);
    const resp = {
      success: true,
      title: finalTitle,
      artist: finalArtist,
      lyrics: g1.lyrics,
      lyricsUrl: g1.url,
      sections,
      source: "genius",
    };
    cacheSet(finalTitle, finalArtist, resp);
    return res.json(resp);
  }

  // songtexte.com
  const s1 = await searchSongtexte(finalTitle, finalArtist);
  if (s1?.lyrics) {
    const sections = detectStructure(s1.lyrics);
    const resp = {
      success: true,
      title: finalTitle,
      artist: finalArtist,
      lyrics: s1.lyrics,
      lyricsUrl: s1.url,
      sections,
      source: "songtexte",
    };
    cacheSet(finalTitle, finalArtist, resp);
    return res.json(resp);
  }

  // Google Fallback
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
    };
    cacheSet(finalTitle, finalArtist, resp);
    return res.json(resp);
  }

  return res.json({ success: false, error: "Kein Treffer" });
});

/* PORT (für Render, Railway, lokale Nutzung) */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Lyrics server läuft auf Port ${PORT}`)
);
