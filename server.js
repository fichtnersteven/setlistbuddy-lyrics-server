const express = require("express");
const cors = require("cors");
const AZLyrics = require("azlyrics-ext");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (AZLyrics Version) ✅");
});

app.get("/lyrics", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();

  if (!title) {
    return res.status(400).json({
      success: false,
      error: "Parameter 'title' fehlt."
    });
  }

  const query = artist ? `${title} ${artist}` : title;

  try {
    // 1. Suche
    const results = await AZLyrics.search(query, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!results || results.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Keine Einträge bei AZLyrics gefunden."
      });
    }

    // 2. Track holen
    const track = await AZLyrics.getTrack(results[0].url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!track || !track.lyrics) {
      return res.status(404).json({
        success: false,
        error: "Lyrics nicht gefunden."
      });
    }

    return res.json({
      success: true,
      source: "azlyrics",
      title: track.title || title,
      artist: track.artist || artist,
      lyrics: track.lyrics.trim()
    });

  } catch (err) {
    console.log("AZLyrics Fehler:", err);
    return res.status(500).json({
      success: false,
      error: "Fehler beim Abrufen der Lyrics"
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
