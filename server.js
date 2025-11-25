// server.js – Lyrics Scraper with Genius + Songtexte.com + Proxy + Test Endpoint

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- PROXY (bypasses Cloudflare) ----------------
async function proxyRequest(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      },
      timeout: 15000
    });
    return response.data;
  } catch (err) {
    return null;
  }
}

// --------------- TEST ENDPOINT (HTML preview) ----------------
app.get("/test", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.send("Missing ?url=");

  const html = await proxyRequest(url);
  if (!html) return res.send("FAILED to fetch HTML");

  res.send(html.substring(0, 2000)); // first 2000 chars
});

// ------------------ GENIUS SCRAPER ------------------
async function fetchFromGenius(title, artist) {
  try {
    const query = encodeURIComponent(`${artist} ${title} lyrics`);
    const searchUrl = `https://genius.com/search?q=${query}`;

    const searchHtml = await proxyRequest(searchUrl);
    if (!searchHtml) return null;
    const $ = cheerio.load(searchHtml);

    const first = $("a.mini_card").first().attr("href");
    if (!first) return null;

    const lyricsHtml = await proxyRequest(first);
    if (!lyricsHtml) return null;
    const $$ = cheerio.load(lyricsHtml);

    let lyrics = "";
    $$("div[data-lyrics-container='true']").each((i, el) => {
      lyrics += $$(el).text().trim() + "\n";
    });

    if (!lyrics.trim()) return null;

    return { success: true, source: "genius", lyrics: lyrics.trim() };
  } catch (err) {
    return null;
  }
}

// --------------- SONGTEXTE.COM SCRAPER ----------------
async function fetchFromSongtexte(title, artist) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `https://www.songtexte.com/search?q=${query}`;

    const searchHtml = await proxyRequest(searchUrl);
    if (!searchHtml) return null;
    const $ = cheerio.load(searchHtml);

    let songUrl = $(".topHitBox .topHitLink").attr("href");
    if (!songUrl) songUrl = $(".songResultTable a").first().attr("href");
    if (!songUrl) return null;

    if (!songUrl.startsWith("http"))
      songUrl = "https://www.songtexte.com" + songUrl;

    const lyricsHtml = await proxyRequest(songUrl);
    if (!lyricsHtml) return null;
    const $$ = cheerio.load(lyricsHtml);

    let lyrics = $$("#lyrics").text().trim().replace(/\r/g, "");
    if (!lyrics.length) return null;

    return { success: true, source: "songtexte.com", lyrics };
  } catch (err) {
    return null;
  }
}

// ------------------ MAIN ENDPOINT ------------------
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;

  if (!title || !artist)
    return res.json({ success: false, error: "Missing title or artist" });

  const genius = await fetchFromGenius(title, artist);
  if (genius) return res.json(genius);

  const st = await fetchFromSongtexte(title, artist);
  if (st) return res.json(st);

  res.json({ success: false, error: "No lyrics found from any source." });
});

// ------------------ ROOT ------------------
app.get("/", (req, res) => {
  res.send("Lyrics API running with Proxy.");
});

// ------------------ START ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
