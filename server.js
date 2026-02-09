const { addonBuilder, serveHTTP } = require('stremio-addon-sdk')
const axios = require('axios')
const cheerio = require('cheerio')
const nodeHttp = require('http')
const os = require('os')

const BASE_URL = 'https://ww3.animeonline.ninja'
const CATALOG_PATH = '/genero/anime-castellano/'
const CATALOG_ID = 'anime_castellano'
const ID_PREFIX = 'animeonline'
const CATALOG_CACHE_TTL_MS = 1000 * 60 * 30
const CATALOG_BATCH_SIZE = 120
const ONLY_CASTELLANO = false
const STREAM_CACHE_TTL_MS = 1000 * 60 * 30
const STREAM_RESOLVE_TIMEOUT_MS = 22000
const PROVIDER_REQUEST_TIMEOUT_MS = 6000
const MAX_PROVIDER_IFRAMES = 3
const PREFERRED_SERVER_KEYWORDS = ['uqload', 'mp4upload']
const PROXY_PORT = 7002
const STREAM_FIRST_RESPONSE_TIMEOUT_MS = 4500
const STREAM_PREWARM_VIDEOS = 3
const STRICT_PLAYABLE_ONLY = false

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
const streamCache = new Map()
const streamProbeCache = new Map()
const streamResolveJobs = new Map()
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

function detectLanIp() {
    try {
        const all = os.networkInterfaces()
        const candidates = []
        for (const name of Object.keys(all)) {
            const list = all[name] || []
            for (const n of list) {
                if (!n || n.internal || n.family !== 'IPv4') continue
                candidates.push(n.address)
            }
        }

        const prioritized = candidates.find((ip) => ip.startsWith('192.168.'))
            || candidates.find((ip) => ip.startsWith('10.'))
            || candidates.find((ip) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip))
            || candidates[0]

        return prioritized || '127.0.0.1'
    } catch {
        return '127.0.0.1'
    }
}

const PUBLIC_HOST = process.env.ADDON_HOST || detectLanIp()
const PROXY_BASE_URL = `http://${PUBLIC_HOST}:${PROXY_PORT}`

function buildProxyStreamUrl(targetUrl, referer) {
    const u = new URL('/proxy', PROXY_BASE_URL)
    u.searchParams.set('url', targetUrl)
    if (referer) u.searchParams.set('referer', referer)
    return u.toString()
}

function buildProviderProxyUrl(providerUrl, referer) {
    const u = new URL('/provider', PROXY_BASE_URL)
    u.searchParams.set('url', providerUrl)
    if (referer) u.searchParams.set('referer', referer)
    return u.toString()
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
    const isMp4UploadDirect = host.includes('mp4upload.com') && path.includes('/d/')

    if (!isKnownDirectExt && !isStreamtapeDirect && !isMp4UploadDirect) return false

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

function isLikelyTvPlayableUrl(url) {
    const s = String(url || '').toLowerCase()
    if (!s) return false

    // Netu/cfglobalcdn links with /secip/ are often IP-bound/expired and fail on TV players
    if (s.includes('/secip/')) return false

    return true
}

function extractMp4UploadDirectUrlsFromHtml(text) {
    const urls = new Set()
    const raw = String(text || '').replace(/\\u0026/g, '&')

    const patterns = [
        /https?:\/\/[^\s"'<>]*mp4upload[^\s"'<>]*\/d\/[^\s"'<>]+/gi,
        /https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?/gi,
        /player\.src\(\[\{\s*src\s*:\s*"([^"]+)"/gi,
        /(?:file|src)\s*[:=]\s*"([^"]+)"/gi
    ]

    for (const re of patterns) {
        let m
        while ((m = re.exec(raw)) !== null) {
            const candidate = normalizeExtractedUrl(m[1] || m[0])
            if (!/^https?:\/\//i.test(candidate)) continue
            if (isLikelyDirectMediaUrl(candidate)) urls.add(candidate)
        }
    }

    return [...urls]
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
    if (normalized.includes('OD_SUB')) return 'JAP/SUB'
    if (normalized.includes('OD_LAT')) return 'LAT'
    if (normalized.includes('OD_ES')) return 'CAST'
    return 'UNK'
}

function serverNameFromUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./i, '')
        if (host.includes('mp4upload')) return 'MP4UPLOAD'
        if (host.includes('streamtape')) return 'STREAMTAPE'
        if (host.includes('uqload')) return 'UQLOAD'
        if (host.includes('mixdrop')) return 'MIXDROP'
        if (host.includes('filemoon')) return 'FILEMOON'
        if (host.includes('netu')) return 'NETU'
        if (host.includes('hexupload')) return 'HEXUPLOAD'
        if (host.includes('lulustream')) return 'LULUSTREAM'
        return host.toUpperCase()
    } catch {
        return 'UNKNOWN'
    }
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
            server = serverNameFromUrl(providerUrl)
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

function streamPriorityScore(stream) {
    const raw = `${stream && stream.title ? stream.title : ''} ${stream && stream.url ? stream.url : ''} ${stream && stream.externalUrl ? stream.externalUrl : ''}`.toLowerCase()
    for (let i = 0; i < PREFERRED_SERVER_KEYWORDS.length; i += 1) {
        if (raw.includes(PREFERRED_SERVER_KEYWORDS[i])) return i
    }

    const isExternal = Boolean(stream && stream.externalUrl)
    if (isExternal) return 200
    return 100
}

function normalizeLanguageTag(language) {
    const l = String(language || '').toUpperCase()
    if (l.includes('CAST') || l.includes('ES')) return 'CAST'
    if (l.includes('LAT')) return 'LAT'
    if (l.includes('JAP') || l.includes('SUB')) return 'JAP/SUB'
    return 'UNK'
}

function extractLanguageFromTitle(title) {
    const t = String(title || '').toUpperCase()
    if (t.includes('CAST')) return 'CAST'
    if (t.includes('LAT')) return 'LAT'
    if (t.includes('JAP') || t.includes('SUB')) return 'JAP/SUB'
    return 'UNK'
}

function languageSortScore(tag) {
    const lang = normalizeLanguageTag(tag)
    if (lang === 'CAST') return 0
    if (lang === 'LAT') return 1
    if (lang === 'JAP/SUB') return 2
    return 9
}

function withTimeout(promise, timeoutMs, fallbackValue) {
    return Promise.race([
        promise,
        new Promise((resolve) => {
            setTimeout(() => resolve(fallbackValue), timeoutMs)
        })
    ])
}

async function probePlayableStream(url, headers = {}) {
    const key = `${url}|${JSON.stringify(headers || {})}`
    const cached = streamProbeCache.get(key)
    const now = Date.now()
    if (cached && now - cached.at < 1000 * 60 * 5) return cached.ok

    let ok = false
    try {
        const res = await http.get(url, {
            timeout: 7000,
            responseType: 'arraybuffer',
            validateStatus: () => true,
            headers: {
                'User-Agent': STREAM_USER_AGENT,
                Range: 'bytes=0-1',
                ...headers
            }
        })

        const ct = String(res.headers && res.headers['content-type'] ? res.headers['content-type'] : '').toLowerCase()
        ok = ct.includes('video/') || ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')
    } catch {
        ok = false
    }

    streamProbeCache.set(key, { at: now, ok })
    return ok
}

async function filterPlayableStreams(streams) {
    const out = []
    for (const s of streams) {
        if (!s || !s.url) continue
        const headers = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {}
        const ok = await probePlayableStream(s.url, headers)
        if (ok) out.push(s)
    }
    return out
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
                timeout: PROVIDER_REQUEST_TIMEOUT_MS,
                headers: { Referer: referer || BASE_URL, Accept: 'text/html,application/xhtml+xml' }
            })
            return extractStreamtapeUrlsFromHtml(String(watchHtml)).filter(isLikelyDirectMediaUrl)
        } catch {
            return []
        }
    }

    try {
        const { data: providerHtml } = await http.get(url, {
            timeout: PROVIDER_REQUEST_TIMEOUT_MS,
            headers: { Referer: referer || BASE_URL, Accept: 'text/html,application/xhtml+xml' }
        })

        const found = new Set(extractDirectUrlsFromText(String(providerHtml)).filter(isLikelyDirectMediaUrl))
        for (const u of extractMp4UploadDirectUrlsFromHtml(String(providerHtml))) found.add(u)

        const nestedIframes = extractIframeSrcUrls(providerHtml).slice(0, MAX_PROVIDER_IFRAMES)
        const iframeTasks = nestedIframes.map(async (iframeUrl) => {
            try {
                const { data: frameHtml } = await http.get(iframeUrl, {
                    timeout: PROVIDER_REQUEST_TIMEOUT_MS,
                    headers: { Referer: url, Accept: 'text/html,application/xhtml+xml' }
                })
                return extractDirectUrlsFromText(String(frameHtml)).filter(isLikelyDirectMediaUrl)
            } catch {
                return []
            }
        })
        const iframeResults = await Promise.allSettled(iframeTasks)
        for (const r of iframeResults) {
            if (r.status !== 'fulfilled') continue
            for (const u of r.value) found.add(u)
        }

        if (found.size > 0) return [...found]
    } catch {
        // ignore provider errors
    }

    return []
}

async function fetchEmbedSourcesFromEpisodePage(targetUrl, config = {}) {
    const fastMode = Boolean(config.fastMode)
    const html = await fetchHtml(targetUrl)
    const $ = cheerio.load(html)

    const dtAjaxConfig = parseJsonVarFromHtml(html, 'dtAjax')
    const options = extractDooplayOptions($)
    if (!dtAjaxConfig || !dtAjaxConfig.url_api || options.length === 0) return []

    const workingOptions = fastMode ? options.slice(0, 4) : options

    const streams = []
    const seen = new Set()

    function addStream(candidate, title, referer, languageTag = null, skipProxyWrap = false) {
        if (!isLikelyTvPlayableUrl(candidate)) return
        const key = directUrlDedupKey(candidate)
        if (seen.has(key)) return
        seen.add(key)

        const lang = normalizeLanguageTag(languageTag || extractLanguageFromTitle(title))
        const displayTitle = `[${lang}] ${title}`

        const stream = {
            title: displayTitle,
            url: skipProxyWrap ? candidate : buildProxyStreamUrl(candidate, referer),
            behaviorHints: { notWebReady: false }
        }

        // Avoid forcing proxyHeaders by default on TV players; many direct URLs play better natively
        if (referer && /streamtape\.com/i.test(candidate)) {
            stream.behaviorHints = buildProxyHeadersBehaviorHints(referer)
        }

        streams.push({
            ...stream
        })
    }

    for (const opt of workingOptions) {
        try {
            const endpoint = `${dtAjaxConfig.url_api}${opt.post}?type=${encodeURIComponent(opt.type)}&source=${encodeURIComponent(
                opt.source
            )}`
            const { data } = await http.get(endpoint, {
                timeout: PROVIDER_REQUEST_TIMEOUT_MS,
                headers: { Referer: targetUrl, Accept: 'application/json,text/plain,*/*' }
            })

            const embedUrl = data && data.embed_url ? absolute(data.embed_url) : null
            if (!embedUrl) continue

            const directFromEmbedUrl = extractDirectUrlsFromText(embedUrl)
            for (const u of directFromEmbedUrl) {
                addStream(u, `${opt.server || 'SERVER'} • ${extractLanguageFromTitle(opt.title)}`)
            }

            if (directFromEmbedUrl.length > 0) continue

            const { data: embedHtml } = await http.get(embedUrl, {
                timeout: PROVIDER_REQUEST_TIMEOUT_MS,
                headers: { Referer: targetUrl, Accept: 'text/html,application/xhtml+xml' }
            })
            const directFromEmbedHtml = extractDirectUrlsFromText(String(embedHtml))
            const directFromStreamtape = extractStreamtapeUrlsFromHtml(String(embedHtml))
            const providerSources = extractGoToPlayerSources(String(embedHtml)).filter(
                (s) => !ONLY_CASTELLANO || s.language === 'CAST'
            )

            let providerResults = []
            if (!fastMode) {
                const providerTasks = providerSources.map(async (providerSource) => {
                    const resolved = await withTimeout(
                        resolveProviderUrlToDirect(providerSource, embedUrl),
                        PROVIDER_REQUEST_TIMEOUT_MS,
                        []
                    )
                    if (!resolved || resolved.length === 0) {
                        return [
                            {
                                url: buildProviderProxyUrl(providerSource.providerUrl, embedUrl),
                                server: providerSource.server,
                                language: providerSource.language,
                                referer: embedUrl
                            }
                        ]
                    }
                    return resolved.map((r) => ({
                        url: r,
                        server: providerSource.server,
                        language: providerSource.language,
                        referer: providerSource.providerUrl
                    }))
                })
                providerResults = await Promise.allSettled(providerTasks)
            }

            for (const u of [...directFromEmbedHtml, ...directFromStreamtape]) {
                addStream(u, `${opt.server || 'SERVER'} • ${extractLanguageFromTitle(opt.title)}`, embedUrl)
            }

            for (const r of providerResults) {
                if (r.status !== 'fulfilled') continue
                for (const item of r.value) {
                    if (item.url) {
                        addStream(item.url, `${item.server} • ${normalizeLanguageTag(item.language)}`, item.referer || embedUrl, item.language)
                    }
                }
            }
        } catch (err) {
            console.error('embed source extraction error', err?.message || err)
        }
    }

    if (streams.length > 0) {
        streams.sort((a, b) => {
            const la = extractLanguageFromTitle(a.title)
            const lb = extractLanguageFromTitle(b.title)
            const ls = languageSortScore(la) - languageSortScore(lb)
            if (ls !== 0) return ls

            const pa = streamPriorityScore(a)
            const pb = streamPriorityScore(b)
            if (pa !== pb) return pa - pb
            return String(a.title || '').localeCompare(String(b.title || ''))
        })
        return streams
    }
    return []
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
        prewarmStreamsForVideos(videos)
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
    const cached = streamCache.get(targetUrl)
    const now = Date.now()
    if (cached && now - cached.at < STREAM_CACHE_TTL_MS) return cached.streams

    const quickDiscovered = await withTimeout(fetchEmbedSourcesFromEpisodePage(targetUrl, { fastMode: true }), STREAM_FIRST_RESPONSE_TIMEOUT_MS, [])
    const quickStreams = STRICT_PLAYABLE_ONLY
        ? await withTimeout(filterPlayableStreams(quickDiscovered), 4000, [])
        : quickDiscovered

    if (quickStreams.length > 0) {
        streamCache.set(targetUrl, { at: now, streams: quickStreams })
    }

    if (!streamResolveJobs.has(targetUrl)) {
        streamResolveJobs.set(
            targetUrl,
            (async () => {
                try {
                    const discoveredStreams = await withTimeout(fetchEmbedSourcesFromEpisodePage(targetUrl), STREAM_RESOLVE_TIMEOUT_MS, [])
                    const directStreams = await withTimeout(filterPlayableStreams(discoveredStreams), 12000, [])
                    if (directStreams.length > 0) {
                        streamCache.set(targetUrl, { at: Date.now(), streams: directStreams })
                    } else if (discoveredStreams.length > 0) {
                        streamCache.set(targetUrl, { at: Date.now(), streams: discoveredStreams })
                    }
                } finally {
                    streamResolveJobs.delete(targetUrl)
                }
            })()
        )
    }

    if (quickStreams.length > 0) return quickStreams

    const runningJob = streamResolveJobs.get(targetUrl)
    if (runningJob) {
        await withTimeout(runningJob, 2500, null)
        const afterWait = streamCache.get(targetUrl)
        if (afterWait && Date.now() - afterWait.at < STREAM_CACHE_TTL_MS && afterWait.streams.length > 0) {
            return afterWait.streams
        }
    }

    const discoveredStreams = await withTimeout(fetchEmbedSourcesFromEpisodePage(targetUrl), 12000, [])
    const fallbackStreams = STRICT_PLAYABLE_ONLY
        ? await withTimeout(filterPlayableStreams(discoveredStreams), 8000, [])
        : discoveredStreams

    if (fallbackStreams.length > 0) {
        streamCache.set(targetUrl, { at: Date.now(), streams: fallbackStreams })
        return fallbackStreams
    }

    return []
}

function prewarmStreamsForVideos(videos = []) {
    for (const v of videos.slice(0, STREAM_PREWARM_VIDEOS)) {
        const targetUrl = videoUrlCache.get(v.id)
        if (!targetUrl) continue
        if (streamResolveJobs.has(targetUrl)) continue

        streamResolveJobs.set(
            targetUrl,
            (async () => {
                try {
                    const discoveredStreams = await withTimeout(fetchEmbedSourcesFromEpisodePage(targetUrl), STREAM_RESOLVE_TIMEOUT_MS, [])
                    const directStreams = await withTimeout(filterPlayableStreams(discoveredStreams), 12000, [])
                    if (directStreams.length > 0) {
                        streamCache.set(targetUrl, { at: Date.now(), streams: directStreams })
                    } else if (discoveredStreams.length > 0) {
                        streamCache.set(targetUrl, { at: Date.now(), streams: discoveredStreams })
                    }
                } catch {
                    // ignore prewarm errors
                } finally {
                    streamResolveJobs.delete(targetUrl)
                }
            })()
        )
    }
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
serveHTTP(addonInterface, { port: 7000 })
console.log('AnimeOnline addon running on http://127.0.0.1:7000/manifest.json')

nodeHttp.createServer(async (req, res) => {
    try {
        const reqUrl = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PROXY_PORT}`}`)
        if (reqUrl.pathname !== '/proxy' && reqUrl.pathname !== '/provider') {
            res.statusCode = 404
            res.end('not found')
            return
        }

        const referer = reqUrl.searchParams.get('referer') || ''
        let target = reqUrl.searchParams.get('url') || ''
        if (!/^https?:\/\//i.test(target)) {
            res.statusCode = 400
            res.end('bad url')
            return
        }

        if (reqUrl.pathname === '/provider') {
            const candidates = await withTimeout(
                resolveProviderUrlToDirect({ providerUrl: target }, referer),
                PROVIDER_REQUEST_TIMEOUT_MS,
                []
            )
            target = (candidates || []).find((u) => isLikelyDirectMediaUrl(u) && isLikelyTvPlayableUrl(u)) || ''
            if (!target) {
                res.statusCode = 502
                res.end('provider unresolved')
                return
            }
        }

        const headers = {
            'User-Agent': STREAM_USER_AGENT,
            Accept: '*/*'
        }
        if (referer) {
            headers.Referer = referer
            try { headers.Origin = new URL(referer).origin } catch { }
        }
        if (req.headers.range) headers.Range = req.headers.range

        const upstream = await axios.get(target, {
            responseType: 'stream',
            timeout: 20000,
            maxRedirects: 6,
            validateStatus: () => true,
            headers
        })

        const contentType = String(upstream.headers && upstream.headers['content-type'] ? upstream.headers['content-type'] : '').toLowerCase()
        const playable = contentType.includes('video/')
            || contentType.includes('application/vnd.apple.mpegurl')
            || contentType.includes('application/x-mpegurl')
        if (!playable) {
            upstream.data.destroy()
            res.statusCode = 502
            res.end('unplayable upstream')
            return
        }

        res.statusCode = upstream.status
        const passHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control']
        for (const h of passHeaders) {
            const v = upstream.headers[h]
            if (v) res.setHeader(h, v)
        }
        res.setHeader('Access-Control-Allow-Origin', '*')
        upstream.data.pipe(res)
    } catch {
        res.statusCode = 502
        res.end('proxy error')
    }
}).listen(PROXY_PORT, () => {
    console.log(`Stream proxy running on http://${PUBLIC_HOST}:${PROXY_PORT}/proxy`)
})
