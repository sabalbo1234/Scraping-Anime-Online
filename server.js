const { addonBuilder, serveHTTP } = require('stremio-addon-sdk')
const axios = require('axios')
const cheerio = require('cheerio')

const BASE_URL = 'https://ww3.animeonline.ninja'
const CATALOG_PATH = '/genero/anime-castellano/'
const CATALOG_ID = 'anime_castellano'
const ID_PREFIX = 'animeonline'
const CATALOG_CACHE_TTL_MS = 1000 * 60 * 30
const CATALOG_BATCH_SIZE = 120
const ONLY_CASTELLANO = true

const http = axios.create({
    timeout: 20000,
    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
    }
})

const STREAM_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const videoUrlCache = new Map()
const catalogCache = {
    series: { at: 0, metas: [] },
    movie: { at: 0, metas: [] }
}

const manifest = {
    id: 'community.animeonline.castellano',
    version: '1.0.0',
    name: 'AnimeOnline Castellano (Scraper)',
    description:
        'Unofficial addon that scrapes catalog, metadata, seasons/episodes and links from animeonline.ninja',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    catalogs: [
        {
            type: 'series',
            id: CATALOG_ID,
            name: 'Anime Castellano',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'movie',
            id: CATALOG_ID,
            name: 'Anime Castellano (Movies)',
            extra: [{ name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: [ID_PREFIX + ':']
}

const builder = new addonBuilder(manifest)

function absolute(url) {
    if (!url) return null
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    if (url.startsWith('/')) return `${BASE_URL}${url}`
    return `${BASE_URL}/${url}`
}

function slugFromUrl(url) {
    try {
        return new URL(url).pathname.split('/').filter(Boolean).pop() || ''
    } catch {
        return ''
    }
}

function makeMetaId(url) {
    return `${ID_PREFIX}:${slugFromUrl(url)}`
}

function parseMetaId(id) {
    if (!id.startsWith(`${ID_PREFIX}:`)) return null
    return id.slice(`${ID_PREFIX}:`.length)
}

function parseIntSafe(value, fallback = 1) {
    const n = Number.parseInt(String(value || '').trim(), 10)
    return Number.isFinite(n) ? n : fallback
}

function parseEpisodeInfo(url, text, index) {
    const source = `${url} ${text}`.toLowerCase()

    let season = 1
    let episode = index + 1

    const seasonMatch = source.match(/(?:temporada|season|\bs)(?:\s|-|_)?(\d{1,2})/i)
    if (seasonMatch) season = parseIntSafe(seasonMatch[1], 1)

    const episodeMatch = source.match(/(?:cap(?:itulo)?|episodio|episode|\be)(?:\s|-|_)?(\d{1,4})/i)
    if (episodeMatch) episode = parseIntSafe(episodeMatch[1], index + 1)

    return { season, episode }
}

async function fetchHtml(url) {
    const { data } = await http.get(url)
    return String(data)
}

async function scrapeCatalog(page = 1, wantedType = 'series') {
    const url = page <= 1 ? absolute(CATALOG_PATH) : absolute(`${CATALOG_PATH}page/${page}/`)
    const html = await fetchHtml(url)
    const $ = cheerio.load(html)

    const metas = []

    $('.items article.item').each((_, article) => {
        const item = $(article)
        const isMovie = item.hasClass('movies')
        const type = isMovie ? 'movie' : 'series'
        if (type !== wantedType) return

        const href = item.find('.poster a, .data h3 a').first().attr('href')
        const title = item.find('.data h3 a').first().text().trim() || item.find('.poster img').attr('alt') || 'Untitled'
        const poster = item.find('.poster img').attr('data-src') || item.find('.poster img').attr('src') || null
        const description = item.find('.animation-1 .texto').text().trim() || undefined
        const imdbText = item.find('.rating').text().trim().replace(/[^0-9.]/g, '')
        const imdbRating = imdbText ? Number(imdbText) : undefined

        const metaUrl = absolute(href)
        if (!metaUrl) return

        metas.push({
            id: makeMetaId(metaUrl),
            type,
            name: title,
            poster: absolute(poster),
            background: absolute(poster),
            description,
            imdbRating,
            releaseInfo: item.find('.data span').first().text().trim() || undefined,
            behaviorHints: {
                defaultVideoId: undefined,
                hasScheduledVideos: false
            }
        })
    })

    return metas
}

function parseTotalPages($) {
    const paginationText = $('.pagination span').first().text().trim()
    const m = paginationText.match(/de\s+(\d+)/i)
    if (m) return parseIntSafe(m[1], 1)

    const pagesFromLinks = []
    $('.pagination a[href*="/page/"]').each((_, a) => {
        const href = $(a).attr('href') || ''
        const pm = href.match(/\/page\/(\d+)\/?/i)
        if (pm) pagesFromLinks.push(parseIntSafe(pm[1], 1))
    })
    if (pagesFromLinks.length > 0) return Math.max(...pagesFromLinks)
    return 1
}

async function scrapeCatalogWithPagination(wantedType = 'series') {
    const firstUrl = absolute(CATALOG_PATH)
    const firstHtml = await fetchHtml(firstUrl)
    const first$ = cheerio.load(firstHtml)

    const totalPages = parseTotalPages(first$)
    const all = []

    const firstPageMetas = await scrapeCatalog(1, wantedType)
    all.push(...firstPageMetas)

    for (let page = 2; page <= totalPages; page += 1) {
        try {
            const metas = await scrapeCatalog(page, wantedType)
            all.push(...metas)
        } catch (err) {
            console.error(`catalog page ${page} error`, err?.message || err)
        }
    }

    return all
}

async function getFullCatalog(wantedType = 'series') {
    const cache = catalogCache[wantedType]
    const now = Date.now()

    if (cache && cache.metas.length > 0 && now - cache.at < CATALOG_CACHE_TTL_MS) {
        return cache.metas
    }

    const metas = await scrapeCatalogWithPagination(wantedType)
    catalogCache[wantedType] = { at: now, metas }
    return metas
}

function extractLinksFromTable($) {
    const links = []

    $('.box_links table tbody tr a[href]').each((_, a) => {
        const url = absolute($(a).attr('href'))
        if (!url) return
        links.push({
            title: `External link: ${$(a).text().trim() || 'Open'}`,
            externalUrl: url
        })
    })

    return links
}

function extractIframeLinks($) {
    const links = []
    $('iframe[src]').each((_, frame) => {
        const src = absolute($(frame).attr('src'))
        if (!src) return
        links.push({
            title: 'Embedded player',
            externalUrl: src
        })
    })
    return links
}

function parseJsonVarFromHtml(html, varName) {
    const regex = new RegExp(`var\\s+${varName}\\s*=\\s*(\\{[\\s\\S]*?\\});`)
    const match = html.match(regex)
    if (!match) return null
    try {
        return JSON.parse(match[1])
    } catch {
        return null
    }
}

function extractDooplayOptions($) {
    const options = []
    $('#playeroptions li.dooplay_player_option').each((_, li) => {
        const el = $(li)
        const post = el.attr('data-post')
        const source = el.attr('data-nume')
        const type = el.attr('data-type')
        if (!post || !source || !type) return

        options.push({
            post,
            source,
            type,
            title: el.find('.title').text().trim() || `Source ${source}`,
            server: el.find('.server').text().trim() || 'unknown'
        })
    })
    return options
}

function unescapeSlashUrl(url) {
    return String(url || '').replace(/\\\//g, '/').trim()
}

function normalizeExtractedUrl(url) {
    return unescapeSlashUrl(url).replace(/[),;]+$/g, '')
}

function isLikelyDirectMediaUrl(rawUrl) {
    let u
    try {
        u = new URL(rawUrl)
    } catch {
        return false
    }

    const host = u.hostname.toLowerCase()
    const path = u.pathname.toLowerCase()

    const isKnownDirectExt = /\.(m3u8|mp4|mpd|webm)$/.test(path)
    const isStreamtapeDirect = host.includes('streamtape.com') && path.includes('/get_video')

    if (!isKnownDirectExt && !isStreamtapeDirect) return false

    if (isStreamtapeDirect) {
        const id = (u.searchParams.get('id') || '').trim()
        const hasToken = (u.searchParams.get('token') || '').trim().length > 0
        const hasExpires = (u.searchParams.get('expires') || '').trim().length > 0
        if (id.length < 8 || !hasToken || !hasExpires) return false
    }

    const knownEmbedHostPatterns = ['mp4upload.com', 'hexload.com', 'streamtape.com']
    const knownEmbedPathPatterns = ['/embed', '/e/']

    if (knownEmbedHostPatterns.some((h) => host.includes(h)) && knownEmbedPathPatterns.some((p) => path.includes(p))) {
        return false
    }

    return true
}

function extractStreamtapeUrlsFromHtml(text) {
    const urls = new Set()
    const raw = String(text || '').replace(/\\u0026/g, '&')

    const patterns = [
        /(?:https?:)?\/\/streamtape\.com\/get_video\?[^\s"'<>]+/gi,
        /\/streamtape\.com\/get_video\?[^\s"'<>]+/gi
    ]

    for (const re of patterns) {
        let m
        while ((m = re.exec(raw)) !== null) {
            let candidate = normalizeExtractedUrl(m[0])
            if (candidate.startsWith('//')) candidate = `https:${candidate}`
            if (candidate.startsWith('/streamtape.com/')) candidate = `https:/${candidate}`
            if (!/^https?:\/\//i.test(candidate)) continue
            if (!isLikelyDirectMediaUrl(candidate)) continue
            urls.add(candidate)
        }
    }

    return [...urls]
}

function extractIframeSrcUrls(html) {
    const $ = cheerio.load(String(html || ''))
    const urls = []
    $('iframe[src]').each((_, iframe) => {
        const src = normalizeExtractedUrl($(iframe).attr('src') || '')
        if (/^https?:\/\//i.test(src)) urls.push(src)
    })
    return urls
}

function buildProxyHeadersBehaviorHints(referer) {
    const requestHeaders = {
        'User-Agent': STREAM_USER_AGENT
    }

    if (referer) {
        requestHeaders.Referer = referer
        try {
            requestHeaders.Origin = new URL(referer).origin
        } catch {
            // ignore invalid referer
        }
    }

    return {
        notWebReady: false,
        proxyHeaders: {
            request: requestHeaders
        }
    }
}

function extractDirectUrlsFromText(text) {
    const urls = new Set()
    const normalized = String(text || '').replace(/\\u0026/g, '&')

    const directMediaRegex = /(https?:\/\/[^\s"'<>]+)/gi
    let m
    while ((m = directMediaRegex.exec(normalized)) !== null) {
        const candidate = normalizeExtractedUrl(m[1])
        if (isLikelyDirectMediaUrl(candidate)) urls.add(candidate)
    }

    const fileRegex = /["'](?:file|src)["']\s*[:=]\s*["']([^"']+)["']/gi
    while ((m = fileRegex.exec(normalized)) !== null) {
        const candidate = normalizeExtractedUrl(m[1])
        if (/^https?:\/\//i.test(candidate) && isLikelyDirectMediaUrl(candidate)) {
            urls.add(candidate)
        }
    }

    for (const u of extractStreamtapeUrlsFromHtml(normalized)) urls.add(u)

    return [...urls]
}

function languageFromClasses(classes) {
    const normalized = String(classes || '').toUpperCase()
    if (normalized.includes('OD_SUB')) return 'SUB'
    if (normalized.includes('OD_LAT')) return 'LAT'
    if (normalized.includes('OD_ES')) return 'CAST'
    return 'UNK'
}

function extractGoToPlayerSources(embedHtml) {
    const $ = cheerio.load(String(embedHtml || ''))
    const items = []

    $('.OD li[onclick*="go_to_player"]').each((_, li) => {
        const el = $(li)
        const onclick = el.attr('onclick') || ''
        const m = onclick.match(/go_to_player\('([^']+)'\)/i)
        if (!m) return

        const providerUrl = normalizeExtractedUrl(m[1])
        if (!/^https?:\/\//i.test(providerUrl)) return

        let server = el.find('span').first().text().trim()
        if (!server) {
            try {
                server = new URL(providerUrl).hostname.replace(/^www\./i, '')
            } catch {
                server = 'unknown'
            }
        }
        server = server.toUpperCase()

        const langContainer = el.closest('.OD')
        const language = languageFromClasses(langContainer.attr('class'))

        items.push({ providerUrl, server, language })
    })

    return items
}

function directUrlDedupKey(url) {
    try {
        const u = new URL(url)
        const host = u.hostname.toLowerCase()
        if (host.includes('streamtape.com') && u.pathname.toLowerCase().includes('/get_video')) {
            return `${host}${u.pathname}|id=${u.searchParams.get('id') || ''}|expires=${u.searchParams.get('expires') || ''}|ip=${u.searchParams.get('ip') || ''
                }`
        }
        return `${host}${u.pathname}${u.search}`
    } catch {
        return url
    }
}

async function resolveProviderUrlToDirect(source, referer) {
    const url = source && source.providerUrl
    if (!url) return []

    if (isLikelyDirectMediaUrl(url)) return [url]

    let parsed
    try {
        parsed = new URL(url)
    } catch {
        return []
    }

    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()

    if (host.includes('streamtape.com') && path.includes('/e/')) {
        try {
            const { data: watchHtml } = await http.get(url, {
                headers: { Referer: referer || BASE_URL, Accept: 'text/html,application/xhtml+xml' }
            })
            return extractStreamtapeUrlsFromHtml(String(watchHtml)).filter(isLikelyDirectMediaUrl)
        } catch {
            return []
        }
    }

    try {
        const { data: providerHtml } = await http.get(url, {
            headers: { Referer: referer || BASE_URL, Accept: 'text/html,application/xhtml+xml' }
        })

        const found = new Set(extractDirectUrlsFromText(String(providerHtml)).filter(isLikelyDirectMediaUrl))

        const nestedIframes = extractIframeSrcUrls(providerHtml)
        for (const iframeUrl of nestedIframes) {
            try {
                const { data: frameHtml } = await http.get(iframeUrl, {
                    headers: { Referer: url, Accept: 'text/html,application/xhtml+xml' }
                })
                for (const u of extractDirectUrlsFromText(String(frameHtml))) {
                    if (isLikelyDirectMediaUrl(u)) found.add(u)
                }
            } catch {
                // ignore per iframe
            }
        }

        if (found.size > 0) return [...found]
    } catch {
        // ignore provider errors
    }

    return []
}

async function fetchEmbedSourcesFromEpisodePage(targetUrl) {
    const html = await fetchHtml(targetUrl)
    const $ = cheerio.load(html)

    const dtAjaxConfig = parseJsonVarFromHtml(html, 'dtAjax')
    const options = extractDooplayOptions($)
    if (!dtAjaxConfig || !dtAjaxConfig.url_api || options.length === 0) return []

    const streams = []
    const seen = new Set()

    for (const opt of options) {
        try {
            const endpoint = `${dtAjaxConfig.url_api}${opt.post}?type=${encodeURIComponent(opt.type)}&source=${encodeURIComponent(
                opt.source
            )}`
            const { data } = await http.get(endpoint, {
                headers: { Referer: targetUrl, Accept: 'application/json,text/plain,*/*' }
            })

            const embedUrl = data && data.embed_url ? absolute(data.embed_url) : null
            if (!embedUrl) continue

            const directFromEmbedUrl = extractDirectUrlsFromText(embedUrl)
            for (const u of directFromEmbedUrl) {
                if (seen.has(u)) continue
                seen.add(u)
                streams.push({
                    title: `${opt.title} (${opt.server})`,
                    url: u,
                    behaviorHints: { notWebReady: false }
                })
            }

            if (streams.length > 0) continue

            const { data: embedHtml } = await http.get(embedUrl, {
                headers: { Referer: targetUrl, Accept: 'text/html,application/xhtml+xml' }
            })
            const directFromEmbedHtml = extractDirectUrlsFromText(String(embedHtml))
            const directFromStreamtape = extractStreamtapeUrlsFromHtml(String(embedHtml))
            const providerSources = extractGoToPlayerSources(String(embedHtml)).filter(
                (s) => !ONLY_CASTELLANO || s.language === 'CAST'
            )

            const resolvedFromProviders = []
            for (const providerSource of providerSources) {
                const resolved = await resolveProviderUrlToDirect(providerSource, embedUrl)
                for (const r of resolved) {
                    resolvedFromProviders.push({
                        url: r,
                        server: providerSource.server,
                        language: providerSource.language,
                        referer: providerSource.providerUrl
                    })
                }
            }

            for (const u of [...directFromEmbedHtml, ...directFromStreamtape]) {
                const k = directUrlDedupKey(u)
                if (seen.has(k)) continue
                seen.add(k)
                streams.push({
                    title: `${opt.title} (${opt.server})`,
                    url: u,
                    behaviorHints: buildProxyHeadersBehaviorHints(embedUrl)
                })
            }

            for (const item of resolvedFromProviders) {
                const k = directUrlDedupKey(item.url)
                if (seen.has(k)) continue
                seen.add(k)
                streams.push({
                    title: `${item.server} • ${item.language}`,
                    url: item.url,
                    behaviorHints: buildProxyHeadersBehaviorHints(item.referer || embedUrl)
                })
            }
        } catch (err) {
            console.error('embed source extraction error', err?.message || err)
        }
    }

    return streams
}

async function scrapeMeta(metaId, type) {
    const slug = parseMetaId(metaId)
    if (!slug) return null

    const candidatePaths = type === 'movie' ? [`/pelicula/${slug}/`, `/online/${slug}/`] : [`/online/${slug}/`, `/pelicula/${slug}/`]

    let html = null
    let pageUrl = null

    for (const p of candidatePaths) {
        const url = absolute(p)
        try {
            html = await fetchHtml(url)
            pageUrl = url
            break
        } catch {
            // try next
        }
    }

    if (!html || !pageUrl) return null

    const $ = cheerio.load(html)

    const title = $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || slug
    const description =
        $('.wp-content p').first().text().trim() ||
        $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        ''
    const poster =
        $('meta[property="og:image"]').attr('content') ||
        $('.poster img').first().attr('data-src') ||
        $('.poster img').first().attr('src') ||
        null

    const genres = []
    $('.sgeneros a, .genres .mta a').each((_, el) => {
        const g = $(el).text().trim()
        if (g && !genres.includes(g)) genres.push(g)
    })

    const videos = []

    const seenEpisodeUrls = new Set()

    $('#seasons .se-c').each((seasonIdx, seasonNode) => {
        const seasonEl = $(seasonNode)
        const seasonText = seasonEl.find('.se-q .se-t').first().text().trim()
        const seasonFromHeader = parseIntSafe(seasonText, seasonIdx + 1)

        seasonEl.find('.se-a ul.episodios li').each((_, li) => {
            const item = $(li)
            const a = item.find('.episodiotitle a').first()
            const epUrl = absolute(a.attr('href'))
            if (!epUrl || seenEpisodeUrls.has(epUrl)) return

            const label = a.text().trim()
            if (!/(episodio|cap[ií]tulo|\bcap\b)/i.test(label)) return

            const numerando = item.find('.numerando').first().text().trim()
            const m = numerando.match(/(\d+)\s*-\s*([\d.]+)/)
            const season = m ? parseIntSafe(m[1], seasonFromHeader) : seasonFromHeader
            const epRaw = m ? Number.parseFloat(m[2]) : Number.NaN
            const episode = Number.isFinite(epRaw) ? Math.floor(epRaw) : null
            if (!episode || episode < 1) return

            const id = `${metaId}:ep:${encodeURIComponent(epUrl)}`
            seenEpisodeUrls.add(epUrl)
            videoUrlCache.set(id, epUrl)

            videos.push({
                id,
                title: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
                season,
                episode,
                released: null
            })
        })
    })

    if (videos.length === 0) {
        const episodeUrls = []
        $('a[href*="/episodio/"]').each((_, a) => {
            const url = absolute($(a).attr('href'))
            if (url && !episodeUrls.includes(url)) episodeUrls.push(url)
        })

        episodeUrls.forEach((epUrl, i) => {
            const label = epUrl.split('/').filter(Boolean).pop() || `episode-${i + 1}`
            const info = parseEpisodeInfo(epUrl, label, i)
            const id = `${metaId}:ep:${encodeURIComponent(epUrl)}`

            videoUrlCache.set(id, epUrl)

            videos.push({
                id,
                title: `S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`,
                season: info.season,
                episode: info.episode,
                released: null
            })
        })
    }

    if (videos.length > 0) {
        videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode))
    } else {
        const id = `${metaId}:movie:${encodeURIComponent(pageUrl)}`
        videoUrlCache.set(id, pageUrl)

        videos.push({
            id,
            title: 'Movie'
        })
    }

    return {
        id: metaId,
        type,
        name: title,
        poster: absolute(poster),
        background: absolute(poster),
        description,
        genres,
        videos
    }
}

async function scrapeStreamsFromUrl(targetUrl) {
    const directStreams = await fetchEmbedSourcesFromEpisodePage(targetUrl)
    if (directStreams.length > 0) return directStreams

    return []
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (id !== CATALOG_ID) return { metas: [] }

    try {
        const skip = parseIntSafe(extra && extra.skip, 0)
        const fullCatalog = await getFullCatalog(type)
        const metas = fullCatalog.slice(skip, skip + CATALOG_BATCH_SIZE)
        return { metas, cacheMaxAge: CATALOG_CACHE_TTL_MS / 1000 }
    } catch (err) {
        console.error('catalog error', err?.message || err)
        return { metas: [] }
    }
})

builder.defineMetaHandler(async ({ type, id }) => {
    try {
        const meta = await scrapeMeta(id, type)
        return { meta }
    } catch (err) {
        console.error('meta error', err?.message || err)
        return { meta: null }
    }
})

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let targetUrl = videoUrlCache.get(id)

        if (!targetUrl) {
            const parts = id.split(':')
            const encoded = parts.slice(3).join(':')
            if (encoded) {
                try {
                    targetUrl = decodeURIComponent(encoded)
                } catch {
                    targetUrl = null
                }
            }
        }

        if (!targetUrl && type === 'movie') {
            const slug = parseMetaId(id)
            if (slug) targetUrl = absolute(`/pelicula/${slug}/`)
        }

        if (!targetUrl) return { streams: [] }

        const streams = await scrapeStreamsFromUrl(targetUrl)
        return { streams }
    } catch (err) {
        console.error('stream error', err?.message || err)
        return { streams: [] }
    }
})

const addonInterface = builder.getInterface()
const PORT = Number(process.env.PORT || 7000)
serveHTTP(addonInterface, { port: PORT })
console.log(`AnimeOnline addon running on http://127.0.0.1:${PORT}/manifest.json`)
