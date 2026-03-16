/**
 * Detects <video> elements with direct MP4/WebM sources on any website.
 * Uses MutationObserver + metadata events to catch dynamically added players.
 * Filters out tiny thumbnails, ads, and blob: URLs (handled by HLS/DASH detection).
 */

import {DownloadableMedia} from "~/media/MediaOnTab"

const MIN_DURATION = 5       // seconds — skip short ad clips
const MIN_DIMENSION = 100    // pixels — skip tiny thumbnails
const POLL_INTERVAL = 3000   // ms — recheck video elements periodically
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv']

type DetectedVideo = {
    url: string
    width: number
    height: number
    duration: number
    type: string
}

let onVideosChanged: ((media: DownloadableMedia[]) => void) | undefined
let knownVideos = new Map<string, DetectedVideo>()
let observer: MutationObserver | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let trackedElements = new WeakSet<HTMLVideoElement>()

export function setOnVideosChanged(cb: (media: DownloadableMedia[]) => void) {
    onVideosChanged = cb
}

export function boot() {
    // Initial scan (delayed slightly for page to settle)
    setTimeout(scanVideos, 500)

    // Watch for new video elements added to the DOM
    observer = new MutationObserver(() => {
        // Any DOM change could add a video — just rescan
        setTimeout(scanVideos, 300)
    })

    const target = document.body || document.documentElement
    observer.observe(target, { childList: true, subtree: true })

    // Periodic poll — catches src changes, lazy-loaded videos, and metadata load
    pollTimer = setInterval(scanVideos, POLL_INTERVAL)
}

export function stop() {
    observer?.disconnect()
    observer = null
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    knownVideos.clear()
}

function getVideoUrl(video: HTMLVideoElement): string | null {
    // Prefer currentSrc (reflects actual loaded source)
    let url = video.currentSrc || video.src || ''

    // Check <source> children if no direct src
    if (!url) {
        const source = video.querySelector('source')
        if (source) url = source.src || ''
    }

    // Skip blob: URLs — those are MSE (HLS/DASH), handled by network interception
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null

    // Must be a real HTTP(S) URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null

    return url
}

function getExtensionFromUrl(url: string): string {
    try {
        const pathname = new URL(url).pathname
        const ext = pathname.split('.').pop()?.toLowerCase() || ''
        if (VIDEO_EXTENSIONS.includes(ext)) return ext
    } catch {}
    return 'mp4' // default assumption for direct video URLs
}

function formatDuration(seconds: number): string {
    const s = Math.floor(seconds % 60)
    const m = Math.floor((seconds / 60) % 60)
    const h = Math.floor(seconds / 3600)
    const mm = m.toString().padStart(2, '0')
    const ss = s.toString().padStart(2, '0')
    if (h > 0) return `${h}:${mm}:${ss}`
    return `${mm}:${ss}`
}

function formatResolution(w: number, h: number): string {
    const p = Math.min(w, h)
    if (p >= 2160) return '4K'
    if (p >= 1440) return '1440p'
    if (p >= 1080) return '1080p'
    if (p >= 720) return '720p'
    if (p >= 480) return '480p'
    if (p >= 360) return '360p'
    if (p >= 240) return '240p'
    return `${w}x${h}`
}

function attachMetadataListener(video: HTMLVideoElement) {
    if (trackedElements.has(video)) return
    trackedElements.add(video)

    // Rescan when metadata or source changes
    video.addEventListener('loadedmetadata', () => scanVideos())
    video.addEventListener('loadeddata', () => scanVideos())
    video.addEventListener('canplay', () => scanVideos())
}

function scanVideos() {
    const videos = document.querySelectorAll<HTMLVideoElement>('video')
    const found = new Map<string, DetectedVideo>()

    for (const video of videos) {
        // Attach event listeners for metadata load
        attachMetadataListener(video)

        const url = getVideoUrl(video)
        if (!url) continue

        const w = video.videoWidth
        const h = video.videoHeight
        const duration = video.duration

        // Filter out tiny thumbnails (only if we have dimensions)
        if (w > 0 && h > 0 && Math.max(w, h) < MIN_DIMENSION) continue

        // Filter out short ad clips (only if we have duration)
        if (duration && !isNaN(duration) && isFinite(duration) && duration < MIN_DURATION) continue

        // Accept the video — even without metadata, a valid URL is enough
        found.set(url, {
            url,
            width: w || 0,
            height: h || 0,
            duration: (duration && !isNaN(duration) && isFinite(duration)) ? duration : 0,
            type: getExtensionFromUrl(url),
        })
    }

    // Check if anything changed
    if (mapsEqual(found, knownVideos)) return

    knownVideos = found
    notifyChanged()
}

function mapsEqual(a: Map<string, DetectedVideo>, b: Map<string, DetectedVideo>): boolean {
    if (a.size !== b.size) return false
    for (const [key, val] of a) {
        const other = b.get(key)
        if (!other) return false
        if (val.width !== other.width || val.height !== other.height ||
            Math.abs(val.duration - other.duration) > 1) return false
    }
    return true
}

function notifyChanged() {
    const pageTitle = document.title
    const media: DownloadableMedia[] = []

    for (const [url, info] of knownVideos) {
        const ext = info.type
        const parts: string[] = []

        if (info.width > 0 && info.height > 0) {
            parts.push(formatResolution(info.width, info.height))
        }
        parts.push(ext.toUpperCase())

        media.push({
            type: "http",
            uri: url,
            displayName: parts.join(' · ') || pageTitle,
            suggestedFullName: `${pageTitle}.${ext}`,
            duration: info.duration > 0 ? formatDuration(info.duration) : undefined,
            resolution: info.width > 0 && info.height > 0 ? `${info.width}x${info.height}` : undefined,
            extension: ext,
        })
    }

    onVideosChanged?.(media)
}
