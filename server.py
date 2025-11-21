from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import quote_plus

app = Flask(__name__)
CORS(app)  # erlaubt Aufrufe von deiner App

@app.get("/lyrics")
def get_lyrics_link():
    title = (request.args.get("title") or "").strip()
    artist = (request.args.get("artist") or "").strip()

    if not title and not artist:
        return jsonify({"error": "Bitte title oder artist angeben"}), 400

    parts = []
    if artist:
        parts.append(artist)
    if title:
        parts.append(title)
    parts.append("lyrics")

    query = " ".join(parts)
    google_url = f"https://www.google.com/search?q={quote_plus(query)}"

    return jsonify({
        "title": title,
        "artist": artist,
        "query": query,
        "google": google_url,
    })


# für lokales Testen
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
