// server.js – Free Lyrics Scraper (AZLyrics + Lyrics.com + Google Snippet)
// No paid proxies, no Scrape.do, runs on Render with plain HTTP requests.

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------ HTTP HELPER ------------------------
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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
    if (/\[\s*chorus\s*\]/i.test(text) || lower.includes("refrain")) {
      type = "chorus";
    } else if (/\[\s*bridge\s*\]/i.test(text)) {
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

// ------------------------ AZLYRICS SCRAPER ------------------------
// Strategy:
// 1) Use AZLyrics search: https://search.azlyrics.com/search.php?q=ARTIST+TITLE
// 2) Take first result link
// 3) On lyrics page, find first DIV without class/id inside main content column
async function fetchFromAzLyrics(title, artist) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `https://search.azlyrics.com/search.php?q=${query}`;
    const searchHtml = await httpGet(searchUrl);
    if (!searchHtml) return null;

    const $ = cheerio.load(searchHtml);

    // Results are usually in tables; we try to grab the first song link.
    let songUrl = $("td.text-left a").first().attr("href");
    if (!songUrl) {
      // Fallback: any link in result table
      songUrl = $("a").filter((_, el) => {
        const href = $(el).attr("href") || "";
        return href.includes("azlyrics.com/lyrics/");
      }).first().attr("href");
    }

    if (!songUrl) {
      console.log("AZLyrics: no song URL found");
      return null;
    }

    const lyricsHtml = await httpGet(songUrl);
    if (!lyricsHtml) return null;

    const $$ = cheerio.load(lyricsHtml);

    // Main content column
    const main = $$("div.col-xs-12.col-lg-8.text-center");
    let lyricsDiv = main.children("div").filter((_, el) => {
      const attribs = el.attribs || {};
      return !attribs.class && !attribs.id;
    }).first();

    if (!lyricsDiv || !lyricsDiv.text()) {
      // fallback: any div between comments
      const allDivs = main.find("div");
      if (allDivs.length) {
        lyricsDiv = allDivs.eq(0);
      }
    }

    const raw = (lyricsDiv.text() || "")
      .replace(/\t/g, "")
      .replace(/ +/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!raw) {
      console.log("AZLyrics: empty lyrics");
      return null;
    }

    return {
      success: true,
      source: "azlyrics",
      rawLyrics: raw,
      sections: splitIntoSections(raw),
    };
  } catch (err) {
    console.error("fetchFromAzLyrics error:", err.message);
    return null;
  }
}

// ------------------------ LYRICS.COM SCRAPER ------------------------
// Strategy:
// 1) Search: https://www.lyrics.com/serp.php?st=ARTIST+TITLE&qtype=2
// 2) Take first song result
// 3) Lyrics in <pre id="lyric-body-text">
async function fetchFromLyricsCom(title, artist) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `https://www.lyrics.com/serp.php?st=${query}&qtype=2`;
    const searchHtml = await httpGet(searchUrl);
    if (!searchHtml) return null;

    const $ = cheerio.load(searchHtml);

    let songPath =
      $(".sec-lyric .clearfix .lyric-meta-title a").first().attr("href") ||
      $(".sec-lyric .lyric.clearfix a").first().attr("href") ||
      $("td.tal.qx a").first().attr("href");

    if (!songPath) {
      console.log("Lyrics.com: no song URL found");
      return null;
    }

    if (!songPath.startsWith("http")) {
      songPath = "https://www.lyrics.com" + songPath;
    }

    const lyricsHtml = await httpGet(songPath);
    if (!lyricsHtml) return null;

    const $$ = cheerio.load(lyricsHtml);
    let raw = $$("#lyric-body-text").text().trim();

    if (!raw) {
      console.log("Lyrics.com: empty lyrics");
      return null;
    }

    raw = raw.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

    return {
      success: true,
      source: "lyrics.com",
      rawLyrics: raw,
      sections: splitIntoSections(raw),
    };
  } catch (err) {
    console.error("fetchFromLyricsCom error:", err.message);
    return null;
  }
}

// ------------------------ GOOGLE SNIPPET SCRAPER ------------------------
// WARNING: This is best-effort only; Google layout changes often.
// Strategy:
// 1) Search query: "artist title lyrics"
// 2) Try to extract a lyrics-like block from known containers.
async function fetchFromGoogleSnippet(title, artist) {
  try {
    const q = encodeURIComponent(`${artist} ${title} lyrics`);
    const url = `https://www.google.com/search?q=${q}`;
    const html = await httpGet(url);
    if (!html) return null;

    const $ = cheerio.load(html);
    let snippet = "";

    // Try modern lyrics containers (heuristic)
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

    // 2) Older BNeawe containers
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

// Simple debug endpoint to inspect raw HTML of any URL
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

  // 1) AZLyrics
  let result = await fetchFromAzLyrics(title, artist);
  if (result) return res.json(result);

  // 2) Lyrics.com
  result = await fetchFromLyricsCom(title, artist);
  if (result) return res.json(result);

  // 3) Google Snippet
  result = await fetchFromGoogleSnippet(title, artist);
  if (result) return res.json(result);

  // 4) Nothing worked
  return res.json({
    success: false,
    error: "No lyrics found from any free source (AZLyrics, Lyrics.com, Google).",
  });
});

// Root
app.get("/", (req, res) => {
  res.send("Free Lyrics API running (AZLyrics + Lyrics.com + Google snippet).");
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
