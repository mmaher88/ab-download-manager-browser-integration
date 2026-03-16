/**
 * Extracts YouTube video info and format data from ytInitialPlayerResponse
 * embedded in the page's <script> tags or fetched from the page URL.
 */

export interface YouTubeVideoInfo {
    videoId: string
    title: string
    channel: string
    lengthSeconds: number
    thumbnailUrl: string
    formats: YouTubeFormat[]
}

export interface YouTubeFormat {
    itag: number
    qualityLabel: string
    mimeType: string
    container: string
    codec: string
    codecShort: string
    bitrate: number
    width?: number
    height?: number
    fps?: number
    contentLength?: number
    hasVideo: boolean
    hasAudio: boolean
    audioQuality?: string
}

const YOUTUBE_VIDEO_URL = /^https?:\/\/(www\.)?youtube\.com\/watch\?.*v=[\w-]+/
const YOUTUBE_SHORTS_URL = /^https?:\/\/(www\.)?youtube\.com\/shorts\/[\w-]+/

export function isYouTubeVideoPage(url: string): boolean {
    return YOUTUBE_VIDEO_URL.test(url) || YOUTUBE_SHORTS_URL.test(url)
}

/**
 * Extract a JSON object from text starting after a marker string.
 * Uses brace-matching to handle nested objects correctly.
 */
function extractJsonObject(text: string, marker: string): any | null {
    const idx = text.indexOf(marker)
    if (idx === -1) return null

    const searchStart = idx + marker.length
    const braceStart = text.indexOf('{', searchStart)
    if (braceStart === -1 || braceStart - searchStart > 20) return null

    let depth = 0
    let inString = false
    let escape = false

    for (let i = braceStart; i < text.length; i++) {
        const ch = text[i]
        if (escape) { escape = false; continue }
        if (ch === '\\') { escape = true; continue }
        if (ch === '"') { inString = !inString; continue }
        if (inString) continue
        if (ch === '{') depth++
        if (ch === '}') {
            depth--
            if (depth === 0) {
                try {
                    return JSON.parse(text.substring(braceStart, i + 1))
                } catch {
                    return null
                }
            }
        }
    }
    return null
}

function extractFromScriptTags(): any | null {
    const scripts = document.querySelectorAll('script')
    for (const script of scripts) {
        const text = script.textContent
        if (!text || !text.includes('ytInitialPlayerResponse')) continue
        const result = extractJsonObject(text, 'ytInitialPlayerResponse')
        if (result?.videoDetails && result?.streamingData) return result
    }
    return null
}

async function extractFromFetch(url: string): Promise<any | null> {
    try {
        const response = await fetch(url, { credentials: 'include' })
        if (!response.ok) return null
        const html = await response.text()
        return extractJsonObject(html, 'ytInitialPlayerResponse')
    } catch {
        return null
    }
}

function shortCodecName(codec: string): string {
    if (codec.startsWith('avc1')) return 'H.264'
    if (codec.startsWith('vp09') || codec === 'vp9') return 'VP9'
    if (codec.startsWith('av01')) return 'AV1'
    if (codec.startsWith('mp4a')) return 'AAC'
    if (codec === 'opus') return 'Opus'
    if (codec === 'vorbis') return 'Vorbis'
    return codec
}

function parseMimeType(mimeType: string): { container: string; codec: string; codecShort: string } {
    const [type, codecsPart] = mimeType.split(';')
    const container = type.split('/')[1] || 'unknown'
    let codec = 'unknown'
    if (codecsPart) {
        const match = codecsPart.match(/codecs="([^"]+)"/)
        if (match) codec = match[1]
    }
    // For combined codecs like "avc1.640028, mp4a.40.2", take the first (video) one for display
    const primaryCodec = codec.split(',')[0].trim()
    return { container, codec, codecShort: shortCodecName(primaryCodec) }
}

function parseFormat(raw: any): YouTubeFormat | null {
    if (!raw.itag || !raw.mimeType) return null

    const { container, codec, codecShort } = parseMimeType(raw.mimeType)
    const isVideo = raw.mimeType.startsWith('video/')
    const isAudio = raw.mimeType.startsWith('audio/')
    const hasVideo = isVideo
    // Progressive formats have both video and audio
    const hasAudio = isAudio || (isVideo && raw.audioQuality != null)

    let qualityLabel = raw.qualityLabel || ''
    if (!qualityLabel && isAudio) {
        qualityLabel = `${Math.round(raw.bitrate / 1000)}kbps`
    }

    return {
        itag: raw.itag,
        qualityLabel,
        mimeType: raw.mimeType,
        container,
        codec,
        codecShort,
        bitrate: raw.bitrate || 0,
        width: raw.width,
        height: raw.height,
        fps: raw.fps,
        contentLength: raw.contentLength ? parseInt(raw.contentLength) : undefined,
        hasVideo,
        hasAudio,
        audioQuality: raw.audioQuality,
    }
}

export async function extractVideoInfo(url?: string): Promise<YouTubeVideoInfo | null> {
    const pageUrl = url || location.href

    // Try DOM script tags first (works on initial page load)
    let playerResponse = extractFromScriptTags()

    // Fallback: fetch the page (needed after SPA navigation)
    if (!playerResponse) {
        playerResponse = await extractFromFetch(pageUrl)
    }

    if (!playerResponse?.videoDetails || !playerResponse?.streamingData) return null

    const vd = playerResponse.videoDetails
    const sd = playerResponse.streamingData

    const formats: YouTubeFormat[] = []

    for (const raw of (sd.formats || [])) {
        const parsed = parseFormat(raw)
        if (parsed) formats.push(parsed)
    }
    for (const raw of (sd.adaptiveFormats || [])) {
        const parsed = parseFormat(raw)
        if (parsed) formats.push(parsed)
    }

    const thumbnails = vd.thumbnail?.thumbnails || []
    const bestThumb = thumbnails[thumbnails.length - 1]

    return {
        videoId: vd.videoId,
        title: vd.title,
        channel: vd.author,
        lengthSeconds: parseInt(vd.lengthSeconds) || 0,
        thumbnailUrl: bestThumb?.url || '',
        formats,
    }
}
