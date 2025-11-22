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
  res.send("SetlistBuddy Lyrics Server läuft (Lyrics.com + Genius) ✅");
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

  //
  // 1️⃣ LYRICS.COM TRY
  //
  console.log("Lyrics.com Suche läuft...");

  const searchUrl =
    "https://www.lyrics.com/serp.php?st=" +
    encodeURIComponent(query) +
    "&qtype=2";

  try {
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      },
    });

    const $search = cheerio.load(searchResponse.data);

    // mehrere mögliche Treffer-Selektoren
    let firstLink =
      $search(".sec-lyric.clearfix a").attr("href") ||
      $search(".tdata-ext a").attr("href") ||
      $search(".tdata a").attr("href") ||
      $search(".lyric-meta-title a").attr("href") ||
      $search('a[href^="/lyric/"]').attr("href"); // starker Fallback

    if (firstLink) {
      const lyricsUrl = "https://www.lyrics.com" + firstLink;

      console.log("Lyrics.com Treffer:", lyricsUrl);

      const lyricsResponse = await axios.get(lyricsUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        },
      });

      const $lyrics = cheerio.load(lyricsResponse.data);

      const lyricsText = $lyrics(".lyric-body").text().trim();

      if (lyricsText && lyricsText.length > 0) {
        return res.json({
          success: true,
          source: "lyrics.com",
          title,
          artist,
          lyrics: lyricsText,
        });
      }
    }

    //
    // 2️⃣ GENIUS FALLBACK
    //
    console.log("Versuche Genius Fallback...");

    const geniusSearchUrl =
      "https://genius.com/api/search/multi?per_page=5&q=" +
      encodeURIComponent(query);

    const geniusResponse = await axios.get(geniusSearchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });

    const sections = geniusResponse.data.response.sections || [];
    const songSection = sections.find((s) => s.type === "song");

    if (songSection && songSection.hits.length > 0) {
      const geniusUrl = songSection.hits[0].result.url;
      console.log("GENIUS URL:", geniusUrl);

      // Genius Lyrics Seite laden
      const geniusPage = await axios.get(geniusUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
        },
      });

      const $g = cheerio.load(geniusPage.data);
      let geniusLyrics = "";

      // typische Datenstruktur für Genius Lyrics
      $g("[data-lyrics-container='true']").each((i, el) => {
        geniusLyrics += $g(el).text().trim() + "\n";
      });

      if (geniusLyrics.trim().length > 0) {
        return res.json({
          success: true,
          source: "genius",
          title,
          artist,
          lyrics: geniusLyrics.trim(),
        });
      }
    }

    //
    // 3️⃣ wenn beides nix liefert
    //
    return res.status(404).json({
      success: false,
      error: "Keine Lyrics gefunden (Lyrics.com & Genius ohne Treffer).",
    });
  } catch (err) {
    console.log("Fehler:", err);
    return res.status(500).json({
      success: false,
      error: "Serverfehler bei der Lyrics-Suche",
    });
  }
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
