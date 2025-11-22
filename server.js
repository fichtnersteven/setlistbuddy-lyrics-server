const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("SetlistBuddy Lyrics Server läuft (Node-Version) ✅");
});

// Platzhalter-Route – füllen wir später mit echtem Scraper
app.get("/lyrics", async (req, res) => {
  res.json({
    success: false,
    message: "Scraper noch nicht eingebaut."
  });
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
