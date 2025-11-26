// server.js – Free Lyrics API (ChartLyrics + Google Snippet) with section detection
// No proxies, no API keys, designed to run on Render.

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ------------------------ HTTP HELPER ------------------------
async function httpGet(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    console.error("httpGet failed for", url, "-", err.message);
    return null;
  }
}

// ------------------------ SECTION DETECTION ------------------------
// Takes plain lyrics text and returns structured sections (verse/chorus/bridge/other)
function splitIntoSections(lyrics) {
  if (!lyrics) return [];

  const normalized = lyrics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n\s*\n+/); // split on empty lines

  // Count repeated blocks to guess a chorus
  const counts = new Map();
  for (const b of blocks) {
    const t = b.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  const sections = [];
  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i].trim();
    if (!text) continue;

    const lower = text.toLowerCase();

    let type = "verse";

    // Explicit markers
    if (/\[\s*chorus\s*\]/i.test(text) || /refrain/i.test(text)) {
      type = "chorus";
    } else if (/\[\s*bridge\s*\]/i.test(text) || /bridge/i.test(lower)) {
      type = "bridge";
    } else {
      // Guess chorus by repetition
      const count = counts.get(text) || 0;
      if (count >= 2) {
        type = "chorus";
      }
    }

    sections.push({ type, text });
  }

  return sections;
}

// ------------------------ CHARTLYRICS SCRAPER ------------------------
// Uses the public ChartLyrics API (XML) – no API key required.
async function fetchFromChartLyrics(title, artist) {
  try {
    const url =
      "http://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect" +
      `?artist=${encodeURIComponent(artist)}` +
      `&song=${encodeURIComponent(title)}`;

    const xml = await httpGet(url);
    if (!xml) return null;

    // Parse XML with cheerio in xmlMode
    const $ = cheerio.load(xml, { xmlMode: true });

    const lyric = $("Lyric").first().text().trim();
    if (!lyric) {
      console.log("ChartLyrics: empty Lyric node");
      return null;
    }

    let cleaned = lyric
      .replace(/\r/g, "")
      .replace(/\t/g, "")
      .replace(/ +/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!cleaned) return null;

    return {
      success: true,
      source: "chartlyrics",
      rawLyrics: cleaned,
      sections: splitIntoSections(cleaned),
    };
  } catch (err) {
    console.error("fetchFromChartLyrics error:", err.message);
    return null;
  }
}

// ------------------------ GOOGLE SNIPPET SCRAPER ------------------------
// WARNING: This is best-effort only; Google layout changes often.
async function fetchFromGoogleSnippet(title, artist) {
  try {
    const q = encodeURIComponent(`${artist} ${title} lyrics`);
    const url = `https://www.google.com/search?q=${q}`;
    const html = await httpGet(url);
    if (!html) return null;

    const $ = cheerio.load(html);
    let snippet = "";

    // Try lyrics-like blocks (heuristic)
    // 1) data-lyricid containers
    if (!snippet) {
      $("[data-lyricid]").each((_, el) => {
        const t = $(el).text().trim();
        if (t && t.split("\n").length > 4) {
          snippet = t;
          return false;
        }
      });
    }

    // 2) BNeawe containers
    if (!snippet) {
      $("div.BNeawe.tAd8D.AP7Wnd").each((_, el) => {
        const t = $(el).text().trim();
        if (t && t.split("\n").length > 4) {
          snippet = t;
          return false;
        }
      });
    }

    if (!snippet) {
      console.log("Google snippet: no lyrics-like block found");
      return null;
    }

    const cleaned = snippet
      .replace(/·/g, "")
      .replace(/(lyrics provided by.*)$/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!cleaned) return null;

    return {
      success: true,
      source: "google-snippet",
      rawLyrics: cleaned,
      sections: splitIntoSections(cleaned),
    };
  } catch (err) {
    console.error("fetchFromGoogleSnippet error:", err.message);
    return null;
  }
}

// ------------------------ API ENDPOINTS ------------------------

// Debug endpoint: inspect raw HTML of any URL
app.get("/test", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.send("Missing ?url=");

  const html = await httpGet(url);
  if (!html) return res.send("FAILED to fetch HTML");

  res.send(html.substring(0, 5000));
});

// Main lyrics endpoint
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;

  if (!title || !artist) {
    return res.json({
      success: false,
      error: "Missing title or artist",
    });
  }

  // 1) ChartLyrics
  let result = await fetchFromChartLyrics(title, artist);
  if (result) return res.json(result);

  // 2) Google Snippet
  result = await fetchFromGoogleSnippet(title, artist);
  if (result) return res.json(result);

  // 3) Nothing worked
  return res.json({
    success: false,
    error: "No lyrics found from ChartLyrics or Google.",
  });
});

// Root
app.get("/", (req, res) => {
  res.send("Free Lyrics API running (ChartLyrics + Google snippet).");
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
