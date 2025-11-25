// server.js – Fully implemented Genius + Songtexte.com scraper with fallback + HTML parsing

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ------------------ GENIUS SCRAPER ------------------
async function fetchFromGenius(title, artist) {
  try {
    const query = encodeURIComponent(`${artist} ${title} lyrics`);
    const searchUrl = `https://genius.com/search?q=${query}`;
    const searchHtml = (await axios.get(searchUrl)).data;
    const $ = cheerio.load(searchHtml);

    const firstLink = $("a.mini_card").first().attr("href");
    if (!firstLink) return null;

    const lyricsHtml = (await axios.get(firstLink)).data;
    const $$ = cheerio.load(lyricsHtml);

    let lyrics = "";
    $$("div[data-lyrics-container='true']").each((i, el) => {
      lyrics += $$(el).text().trim() + "\n";
    });

    if (!lyrics.trim()) return null;

    return {
      success: true,
      source: "genius",
      lyrics: lyrics.trim(),
    };
  } catch (err) {
    return null;
  }
}

// ------------------ SONGTEXTE.COM SCRAPER ------------------
async function fetchFromSongtexte(title, artist) {
  try {
    const query = encodeURIComponent(`${artist} ${title}`);
    const searchUrl = `https://www.songtexte.com/search?q=${query}`;

    const searchHtml = (await axios.get(searchUrl)).data;
    const $ = cheerio.load(searchHtml);

    let songUrl = $(".topHitBox .topHitLink").attr("href");
    if (!songUrl) songUrl = $(".songResultTable a").first().attr("href");
    if (!songUrl) return null;

    if (!songUrl.startsWith("http")) {
      songUrl = "https://www.songtexte.com" + songUrl;
    }

    const lyricsHtml = (await axios.get(songUrl)).data;
    const $$ = cheerio.load(lyricsHtml);

    let lyrics = $$("#lyrics").text().trim().replace(/\r/g, "");

    if (!lyrics.length) return null;

    return {
      success: true,
      source: "songtexte.com",
      lyrics,
    };
  } catch (err) {
    return null;
  }
}

// ------------------ API ENDPOINT ------------------
app.get("/lyrics", async (req, res) => {
  const { title, artist } = req.query;

  if (!title || !artist) {
    return res.json({ success: false, error: "Missing title or artist" });
  }

  const genius = await fetchFromGenius(title, artist);
  if (genius) return res.json(genius);

  const st = await fetchFromSongtexte(title, artist);
  if (st) return res.json(st);

  return res.json({
    success: false,
    error: "No lyrics found from any source.",
  });
});

app.get("/", (req, res) => {
  res.send("Lyrics API running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
