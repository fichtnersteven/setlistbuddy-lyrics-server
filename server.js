// server.js – Node + Express + AZLyrics + ai-lyrics

const express = require("express");
const cors = require("cors");
const AZLyrics = require("azlyrics-ext");   // Primary Scraper
const LyricsAI = require("ai-lyrics");      // Fallback Scraper

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Node Version) ✅");
});

/**
 * GET /lyrics
 * Parameter: title, artist
 */
app.get("/lyrics", async (req, res) => {
  const titleRaw = req.query.title || req.query.song || "";
  const artistRaw = req.query.artist || "";

  const title = titleRaw.toString().trim();
  const artist = artistRaw.toString().trim();

  if (!title) {
    return res.status(400).json({
      success: false,
      error: "Parameter 'title' fehlt.",
    });
  }

  const query = artist ? `${title} ${artist}` : title;

  //
  // 1️⃣ Versuch: AZLyrics (schnell)
  //
  try {
    const songs = await AZLyrics.search(query);

    if (Array.isArray(songs) && songs.length > 0) {
      const track = await AZLyrics.getTrack(songs[0].url);

      if (track && track.lyrics) {
        return res.json({
          success: true,
          source: "azlyrics",
          title: track.title || title,
          artist: track.artist || artist,
          lyrics: track.lyrics.trim(),
        });
      }
    }
  } catch (err) {
    console.log("AZLyrics Fehler:", err);
  }

  //
  // 2️⃣ Versuch: ai-lyrics (Fallback, Puppeteer)
  //
  try {
    let text;

    if (artist) {
      text = await LyricsAI.findLyricsBySongTitleAndArtist(title, artist);
    } else {
      text = await LyricsAI.findLyricsBySongTitle(title);
    }

    if (text) {
      return res.json({
        success: true,
        source: "ai-lyrics",
        title,
        artist,
        lyrics: text.toString().trim(),
      });
    }
  } catch (err) {
    console.log("ai-lyrics Fehler:", err);
  }

  //
  // 3️⃣ Beide fehlgeschlagen
  //
  return res.status(404).json({
    success: false,
    error: "Keine Lyrics gefunden.",
  });
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
