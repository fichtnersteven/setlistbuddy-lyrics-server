const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Test-Route
app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Lyrics.com Version) ✅");
});

app.get("/lyrics", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();

  if (!title) {
    return res.status(400).json({
      success: false,
      error: "Parameter 'title' fehlt.",
    });
  }

  const query = artist ? `${title} ${artist}` : title;

  const searchUrl =
    "https://www.lyrics.com/serp.php?st=" +
    encodeURIComponent(query) +
    "&qtype=2";

  try {
    // 1) Lyrics.com Suche laden
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      },
    });

    const $search = cheerio.load(searchResponse.data);

    // 2) erstes Ergebnis holen
   let firstLink = 
  $search(".sec-lyric.clearfix a").attr("href") ||
  $search(".tdata-ext a").attr("href") ||
  $search(".tdata a").attr("href") ||
  $search(".lyric-meta-title a").attr("href");


    if (!firstLink) {
      return res.status(404).json({
        success: false,
        error: "Keine Lyrics.com Ergebnisse gefunden.",
      });
    }

    const lyricsUrl = "https://www.lyrics.com" + firstLink;

    // 3) Lyrics Seite laden
    const lyricsResponse = await axios.get(lyricsUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      },
    });

    const $lyrics = cheerio.load(lyricsResponse.data);
    const lyricsText = $lyrics(".lyric-body").text().trim();

    if (!lyricsText) {
      return res.status(404).json({
        success: false,
        error: "Lyrics auf Lyrics.com nicht gefunden.",
      });
    }

    return res.json({
      success: true,
      source: "lyrics.com",
      title,
      artist,
      lyrics: lyricsText,
    });
  } catch (err) {
    console.log("Lyrics.com Fehler:", err);
    return res.status(500).json({
      success: false,
      error: "Fehler beim Abrufen der Lyrics.com Daten",
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
