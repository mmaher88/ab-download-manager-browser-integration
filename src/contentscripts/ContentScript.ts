import {getLinksFromSelection} from "~/utils/LinkExtractor";
import * as selectionPopup from "~/popup/selection/SelectionPopup";
import * as MediaPopup from "~/popup/media/MediaSelectionPopup";
import {debounce} from "~/utils/Debaunce";
import * as mousePosition from "~/utils/MouseUtil"
import * as Configs from "~/configs/Config"
import {run} from "~/utils/ScopeFunctions";
import {onMessage} from "webext-bridge/content-script"
import browser from "webextension-polyfill";
import {createAlertStringForMyExtension} from "~/utils/AlertMessageCreator";
import {addDownloads} from "~/contentscripts/AddDownloads";
import {isYouTubeVideoPage, extractVideoInfo, YouTubeFormat} from "~/contentscripts/youtube/YouTubeExtractor";
import {DownloadableMedia} from "~/media/MediaOnTab";

const showPopupDelayed = debounce(500)

async function checkAndReportLinks() {
    const selection = window.getSelection();
    if (selection == null) {
        alert(createAlertStringForMyExtension(browser.i18n.getMessage("popup_alert_nothing_selected")))
        return
    }
    let downloadItems = getLinksFromSelection(selection)
    if (downloadItems.length == 0) {
        alert(createAlertStringForMyExtension(browser.i18n.getMessage("popup_alert_no_link_detected")))
        return
    }
    await addDownloads(downloadItems)
}

let lastSelectionConsumed = true

function shouldCreatePopup() {
    return lastSelectionConsumed && Configs.getLatestConfig().popupEnabled
}

// YouTube: track current video to avoid re-extracting
let lastYouTubeVideoId: string | null = null
let lastYouTubeTitle: string = ""

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    const units = ["KB", "MB", "GB"]
    let i = -1
    let size = bytes
    do { size /= 1024; i++ } while (size >= 1024 && i < units.length - 1)
    return `${size.toFixed(1)} ${units[i]}`
}

function youtubeFormatToMedia(format: YouTubeFormat, videoTitle: string, pageUrl: string): DownloadableMedia {
    // Encode format itag in URI fragment so click handler can identify it
    const uri = `${pageUrl.split('#')[0]}#ytformat=${format.itag}`

    // Build a clean display name: "1080p · H.264 · mp4"
    const parts: string[] = []
    parts.push(format.qualityLabel)
    parts.push(format.codecShort)
    parts.push(format.container)
    const displayName = parts.join(" · ")

    const details: Partial<DownloadableMedia> = {}
    if (format.contentLength) details.size = formatSize(format.contentLength)
    if (format.hasVideo && format.fps && format.fps > 30) details.bandwidth = `${format.fps}fps`
    if (format.hasVideo && !format.hasAudio) details.extension = "video only"
    else if (!format.hasVideo && format.hasAudio) details.extension = "audio only"

    return {
        type: "http",
        uri,
        displayName,
        suggestedFullName: `${videoTitle}.${format.container}`,
        size: details.size,
        bandwidth: details.bandwidth,
        extension: details.extension,
    }
}

async function handleYouTubePage() {
    const url = location.href
    if (!isYouTubeVideoPage(url)) {
        lastYouTubeVideoId = null
        return
    }

    const videoId = new URL(url).searchParams.get('v') || url.split('/shorts/')[1]?.split(/[?#]/)[0]
    if (!videoId || lastYouTubeVideoId === videoId) return
    lastYouTubeVideoId = videoId

    const info = await extractVideoInfo(url)
    if (!info || info.formats.length === 0) return

    lastYouTubeTitle = info.title

    // Sort: video-only (high to low res), then progressive, then audio-only
    const videoOnly = info.formats
        .filter(f => f.hasVideo && !f.hasAudio)
        .sort((a, b) => (b.height || 0) - (a.height || 0) || b.bitrate - a.bitrate)
    const progressive = info.formats
        .filter(f => f.hasVideo && f.hasAudio)
        .sort((a, b) => (b.height || 0) - (a.height || 0))
    const audioOnly = info.formats
        .filter(f => !f.hasVideo && f.hasAudio)
        .sort((a, b) => b.bitrate - a.bitrate)

    // Deduplicate video-only by qualityLabel+codec+container
    const seen = new Set<string>()
    const dedupedVideo = videoOnly.filter(f => {
        const key = `${f.qualityLabel}-${f.codecShort}-${f.container}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })

    const allFormats = [...dedupedVideo, ...progressive, ...audioOnly]
    const mediaItems = allFormats.map(f => youtubeFormatToMedia(f, info.title, url))

    MediaPopup.updatePopup(mediaItems)
}

run(async () => {
    await Configs.boot()
    mousePosition.boot()
    selectionPopup.setOnPopupClicked(async () => {
        checkAndReportLinks()
    })
    MediaPopup.setItemClickListener((media) => {
        // Check if this is a YouTube format item (has #ytformat= in URI)
        const ytMatch = media.uri.match(/#ytformat=(\d+)$/)
        if (ytMatch) {
            const cleanUrl = media.uri.replace(/#ytformat=\d+$/, '')
            addDownloads([
                {
                    link: cleanUrl,
                    suggestedName: media.suggestedFullName ?? "",
                    type: "http",
                    downloadPage: cleanUrl,
                    headers: null,
                    description: `youtube:format=${ytMatch[1]}`,
                }
            ])
        } else {
            addDownloads([
                {
                    link: media.uri,
                    suggestedName: media.suggestedFullName ?? "",
                    type: media.type,
                    downloadPage: location.href,
                    headers: media.requestHeaders ?? null,
                    description: null
                }
            ])
        }
        MediaPopup.toggleList(false)
    })

    // Initial YouTube check
    if (isYouTubeVideoPage(location.href)) {
        handleYouTubePage()
    }

    // YouTube SPA navigation detection
    document.addEventListener('yt-navigate-finish', () => {
        handleYouTubePage()
    })

    document.addEventListener("selectionchange", () => {
        lastSelectionConsumed = true
    })
    document.addEventListener("mouseup", () => {
        showPopupDelayed(() => {
            const mousePositionInPage = mousePosition.getMousePositionInPage();
            if (!shouldCreatePopup() || mousePositionInPage === null) {
                return;
            }
            const selection = window.getSelection();
            if (selection == null) {
                return;
            }
            if (selection.type !== "Range") {
                return;
            }
            const linksFromSelection = getLinksFromSelection(selection);
            if (linksFromSelection.length == 0) {
                return
            }
            lastSelectionConsumed = false
            selectionPopup.showAddDownloadPopupUi(mousePositionInPage)
        })
    })
    onMessage("show_log", (msg) => {
        console.log(...msg.data)
    })
    onMessage("show_alert", (msg) => {
        alert(createAlertStringForMyExtension(msg.data))
    })
    onMessage("check_selected_text_for_links", (msg) => {
        checkAndReportLinks()
    })
    onMessage("downloadable_media_detected", (msg) => {
        // Don't show generic HLS media popup on YouTube - we use extracted formats instead
        if (isYouTubeVideoPage(location.href)) return
        MediaPopup.updatePopup(msg.data)
    })
}).catch(e => {
    console.log("failed to load ab-dm-extension", e)
})
