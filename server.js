app.get("/lyrics", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();

  if (!title) {
    return res.status(400).json({ success: false, error: "Parameter 'title' fehlt." });
  }

  const query = artist ? `${title} ${artist}` : title;
  const searchUrl =
    "https://www.lyrics.com/serp.php?st=" +
    encodeURIComponent(query) +
    "&qtype=2";

  const axios = require("axios");
  const cheerio = require("cheerio");

  try {
    // 1️⃣ Lyrics.com Suche laden
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      },
    });

    const $search = cheerio.load(searchResponse.data);

    // 2️⃣ erstes Ergebnis holen
    const firstLink = $search(".sec-lyric.clearfix a:nth-child(1)").attr("href");

    if (!firstLink) {
      return res.status(404).json({
        success: false,
        error: "Keine Lyrics.com Ergebnisse gefunden.",
      });
    }

    const lyricsUrl = "https://www.lyrics.com" + firstLink;

    // 3️⃣ Lyrics Seite laden
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

    // erfolgreicher Treffer 🎉
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
