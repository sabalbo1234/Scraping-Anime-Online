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

## 3) Install in Stremio (local)

1. Open Stremio.
2. Go to Addons.
3. Use “Install via URL” (or paste manifest URL in browser if your Stremio setup supports it).
4. Paste:
   - `http://127.0.0.1:7000/manifest.json`

## 4) Deploy to Render (public)

### A. Push this project to GitHub

### B. Create Web Service in Render
- New + -> Web Service
- Connect your GitHub repo
- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

This addon already supports Render dynamic port using `process.env.PORT`.

### C. Get your public manifest URL
After deploy, use:
- `https://YOUR-RENDER-SERVICE.onrender.com/manifest.json`

Install that URL in Stremio via “Install via URL”.

## Notes and limitations

- The addon now attempts to fetch the **full paginated catalog** and serves it in batches through `skip`, so Stremio can browse beyond the first page.
- For streams, the addon tries this order:
  1. Resolve DooPlay player options from episode pages
  2. Query DooPlay JSON endpoint for embed URL
  3. Resolve provider pages (currently Streamtape) to direct playable links
  4. Return only direct stream URLs for in-app playback (`url`), without opening websites

- This is an **unofficial scraper**; the target site can change HTML structure at any time and break parsing.
- Some pages may include anti-bot, Cloudflare, or dynamic rendering behavior that can affect extraction.
- Not all providers expose direct playable URLs; some results may still fallback to `externalUrl`.
- Episode season/number parsing is heuristic and may not be perfect for all titles.

## Legal / compliance

- Use only where legally permitted in your country.
- Respect copyright and the target website’s Terms of Service.
- This code is provided for educational/interoperability purposes.
