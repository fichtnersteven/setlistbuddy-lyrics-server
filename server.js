
// server.js - Clean lyrics scraper with structure detection (no Genius)
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const http = axios.create({
  timeout: 12000,
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
      await new Promise(r => setTimeout(r, 300 + i * 300));
    }
  }
}

function cleanLyrics(text) {
  if (!text) return "";
  return text
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "")
    .replace(/ADNPM\.[^\n]+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectStructure(text) {
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b);
  const normalized = blocks.map(b => b.toLowerCase());

  let chorusIndex = -1;
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i];
      const b = normalized[j];
      const eq = similarity(a, b);
      if (eq > 0.55) {
        chorusIndex = i;
        break;
      }
    }
    if (chorusIndex !== -1) break;
  }

  const sections = [];
  blocks.forEach((block, idx) => {
    let type = "verse";
    let confidence = 0.5;

    if (idx === chorusIndex) {
      type = "chorus";
      confidence = 0.9;
    } else if (idx > chorusIndex && chorusIndex !== -1) {
      const eq = similarity(normalized[idx], normalized[chorusIndex]);
      if (eq > 0.55) {
        type = "chorus";
        confidence = 0.85;
      }
    }

    if (type === "verse" && idx > 1 && idx === blocks.length - 2) {
      type = "bridge";
      confidence = 0.6;
    }

    sections.push({ type, confidence, text: block });
  });

  return sections;
}

function similarity(a, b) {
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  let matches = 0;
  const len = Math.min(la, lb);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / len;
}

function searchUrl(query) {
  return "https://www.songtexte.com/suche?c=all&q=" + encodeURIComponent(query);
}

async function findBestMatch(title, artist) {
  const res = await fetchRetry(searchUrl(title + " " + artist));
  const $ = cheerio.load(res.data);

  const results = [];
  $(".songResultTable > div > div").each((i, row) => {
    const linkEl = $(row).find(".song a[href*='/songtext/']").first();
    const href = linkEl.attr("href");
    const t = linkEl.text().trim();
    const a = $(row).find(".artist span").last().text().trim();
    if (href && t && a) results.push({ href, title: t, artist: a });
  });

  return results[0] || null;
}

async function extractLyrics(href) {
  const cleanHref = href.startsWith("/") ? href : "/" + href;
  const url = "https://www.songtexte.com" + cleanHref;
  const res = await fetchRetry(url);
  const $ = cheerio.load(res.data);
  const lyrics =
    $("#lyrics").text().trim() ||
    $(".lyrics").text().trim() ||
    $(".songtext").text().trim() ||
    "";
  return { url, lyrics: cleanLyrics(lyrics) };
}

app.get("/lyrics", async (req, res) => {
  const title = (req.query.title || "").trim();
  const artist = (req.query.artist || "").trim();
  if (!title) {
    return res.json({ success: false, error: "title fehlt" });
  }

  try {
    const match = await findBestMatch(title, artist);
    if (!match) {
      return res.json({ success: false, error: "Kein Treffer" });
    }

    const result = await extractLyrics(match.href);
    if (!result.lyrics) {
      return res.json({ success: false, error: "Keine Lyrics gefunden" });
    }

    const sections = detectStructure(result.lyrics);

    return res.json({
      success: true,
      title,
      artist,
      lyrics: result.lyrics,
      sections,
      lyricsUrl: result.url,
    });
  } catch (e) {
    return res.json({ success: false, error: "Serverfehler" });
  }
});

app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
