# AnimeOnline Castellano Stremio Addon (Unofficial)

This project is a Node.js addon for Stremio built with `stremio-addon-sdk`.

It scrapes:
- **Catalog** from `https://ww3.animeonline.ninja/genero/anime-castellano/`
- **Meta** (title, poster, description, genres)
- **Seasons / Episodes** (when episode links are available in the show page)
- **Streams** trying direct playable links first (for in-app playback in Stremio)

## 1) Install dependencies

```bash
npm install
```

## 2) Run addon

```bash
npm start
```

By default it serves on:

- `http://127.0.0.1:7000/manifest.json`

## 3) Install in Stremio

1. Open Stremio.
2. Go to Addons.
3. Use “Install via URL” (or paste manifest URL in browser if your Stremio setup supports it).
4. Paste:
   - `http://127.0.0.1:7000/manifest.json`

## Notes and limitations

- The addon now attempts to fetch the **full paginated catalog** and serves it in batches through `skip`, so Stremio can browse beyond the first page.
- For streams, the addon tries this order:
  1. Resolve DooPlay player options from episode pages
  2. Query DooPlay JSON endpoint for embed URL
  3. Extract direct media URLs (`.m3u8`, `.mp4`, `.mpd`, `.webm`) from embed URL / embed HTML
  4. Fallback to external links if direct URL extraction is not possible

- This is an **unofficial scraper**; the target site can change HTML structure at any time and break parsing.
- Some pages may include anti-bot, Cloudflare, or dynamic rendering behavior that can affect extraction.
- Not all providers expose direct playable URLs; some results may still fallback to `externalUrl`.
- Episode season/number parsing is heuristic and may not be perfect for all titles.

## Legal / compliance

- Use only where legally permitted in your country.
- Respect copyright and the target website’s Terms of Service.
- This code is provided for educational/interoperability purposes.
