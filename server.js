const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Test Route
app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Genius API Version) ✅");
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

  try {
    //
    // 1️⃣ GENIUS API – SEARCH
    //
    console.log("Genius API Suche:", query);

    const geniusSearch = await axios.get(
      "https://api.genius.com/search?q=" + encodeURIComponent(query),
      {
        headers: {
          Authorization: "Bearer " + process.env.GENIUS_API_KEY,
        },
      }
    );

    const hits = geniusSearch.data.response.hits;

    if (!hits || hits.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Keine Genius-Ergebnisse gefunden.",
      });
    }

    // Bestes Ergebnis wählen
    const song = hits[0].result;
    const geniusUrl = song.url;

    console.log("GENIUS URL:", geniusUrl);

    //
    // 2️⃣ GENIUS HTML LADEN & LYRICS EXTRAHIEREN
    //
    const geniusPage = await axios.get(geniusUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(geniusPage.data);
    let finalLyrics = "";

    // Neuer Genius HTML Standard
    $("[data-lyrics-container='true']").each((i, el) => {
      finalLyrics += $(el).text().trim() + "\n";
    });

    // Ältere Genius Version (Fallback)
    if (!finalLyrics.trim()) {
      finalLyrics = $(".lyrics").text().trim();
    }

    if (!finalLyrics.trim()) {
      return res.status(404).json({
        success: false,
        error: "Lyrics nicht extrahierbar (Genius).",
      });
    }

    //
    // 🎉 Erfolgreich – Lyrics gefunden!
    //
    return res.json({
      success: true,
      source: "genius",
      title: song.full_title,
      artist: song.primary_artist.name,
      lyrics: finalLyrics.trim(),
    });
  } catch (err) {
    console.log("GENIUS API Fehler:", err);
    return res.status(500).json({
      success: false,
      error: "Serverfehler bei der Lyrics-Suche",
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
