const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Genius + Lyrics.com) ✅");
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
    // 1️⃣ GENIUS API – suche Song-ID & echte Metadaten
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

    // Bestes Ergebnis
    const song = hits[0].result;
    const songTitle = song.title;
    const songArtist = song.primary_artist.name;

    console.log("GENIUS MATCH:", songTitle, "–", songArtist);

    //
    // 2️⃣ Lyrics.com – suche Lyrics
    //
    const finalQuery = `${songTitle} ${songArtist}`;

    const searchUrl =
      "https://www.lyrics.com/serp.php?st=" +
      encodeURIComponent(finalQuery) +
      "&qtype=2";

    console.log("Lyrics.com Search:", searchUrl);

    const searchResponse = await axios.get(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0 Safari/537.36",
      },
    });

    const $search = cheerio.load(searchResponse.data);

    // Beste Treffer-Selektoren
    let firstLink =
      $search(".sec-lyric.clearfix a").attr("href") ||
      $search(".tdata-ext a").attr("href") ||
      $search(".tdata a").attr("href") ||
      $search(".lyric-meta-title a").attr("href") ||
      $search('a[href^="/lyric/"]').attr("href");

    if (!firstLink) {
      return res.status(404).json({
        success: false,
        error: "Lyrics.com hat keine Treffer geliefert.",
      });
    }

    const lyricsUrl = "https://www.lyrics.com" + firstLink;
    console.log("Lyrics.com URL:", lyricsUrl);

    //
    // 3️⃣ tatsächliche Lyrics-Seite scrapen
    //
    const lyricsResponse = await axios.get(lyricsUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0 Safari/537.36",
      },
    });

    const $lyrics = cheerio.load(lyricsResponse.data);

    const lyricsText = $lyrics(".lyric-body").text().trim();

    if (!lyricsText) {
      return res.status(404).json({
        success: false,
        error: "Lyrics.com hat keine Lyrics extrahiert.",
      });
    }

    //
    // 🎉 Erfolg
    //
    return res.json({
      success: true,
      source: "genius + lyrics.com",
      title: songTitle,
      artist: songArtist,
      lyrics: lyricsText,
    });
  } catch (err) {
    console.log("SERVER FEHLER:", err);
    return res.status(500).json({
      success: false,
      error: "Serverfehler bei der Lyrics-Suche",
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
