import { addDownloads } from "~/contentscripts/AddDownloads";

/**
 * YouTube download button overlay.
 * Shows a download button on the top-right of the YouTube video player.
 * When clicked, sends the YouTube URL to AB Download Manager.
 */

let overlayButton: HTMLElement | null = null;
let currentVideoId: string | null = null;

function getVideoId(): string | null {
    const url = new URL(window.location.href);
    if (url.hostname.includes("youtube.com")) {
        return url.searchParams.get("v");
    }
    if (url.hostname === "youtu.be") {
        return url.pathname.slice(1);
    }
    return null;
}

function isYouTubePage(): boolean {
    return window.location.hostname.includes("youtube.com") ||
           window.location.hostname === "youtu.be";
}

function createOverlayButton(): HTMLElement {
    const btn = document.createElement("div");
    btn.id = "abdm-yt-download-btn";
    btn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 16L12 4" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <path d="M7 11L12 16L17 11" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M4 20H20" stroke="white" stroke-width="2" stroke-linecap="round"/>
        </svg>
    `;
    btn.title = "Download with AB Download Manager";

    const style = document.createElement("style");
    style.textContent = `
        #abdm-yt-download-btn {
            position: absolute;
            top: 12px;
            right: 12px;
            z-index: 99999;
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.6);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s, background 0.2s;
            pointer-events: auto;
        }
        #abdm-yt-download-btn:hover {
            background: rgba(100, 50, 200, 0.8);
        }
        /* Show button when hovering over the player */
        #movie_player:hover #abdm-yt-download-btn,
        .html5-video-player:hover #abdm-yt-download-btn {
            opacity: 1;
        }
        /* Also show when button itself is hovered */
        #abdm-yt-download-btn:hover {
            opacity: 1;
        }
    `;
    document.head.appendChild(style);

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const videoUrl = window.location.href;
        addDownloads([{
            link: videoUrl,
            downloadPage: videoUrl,
            headers: null,
            description: null,
            suggestedName: null,
            type: "http",
        }]);
    });

    return btn;
}

function injectOverlay() {
    const videoId = getVideoId();
    if (!videoId || videoId === currentVideoId) return;

    currentVideoId = videoId;

    // Remove old button if exists
    const existing = document.getElementById("abdm-yt-download-btn");
    if (existing) existing.remove();

    // Find the video player container
    const player = document.querySelector("#movie_player") as HTMLElement;
    if (!player) return;

    // Ensure player has relative positioning for absolute child
    if (getComputedStyle(player).position === "static") {
        player.style.position = "relative";
    }

    overlayButton = createOverlayButton();
    player.appendChild(overlayButton);
}

function cleanup() {
    if (overlayButton) {
        overlayButton.remove();
        overlayButton = null;
    }
    currentVideoId = null;
}

export function bootYouTubeOverlay() {
    if (!isYouTubePage()) return;

    // Initial injection
    injectOverlay();

    // YouTube is a SPA — watch for navigation changes
    const observer = new MutationObserver(() => {
        if (isYouTubePage() && getVideoId()) {
            // Small delay to let YouTube finish rendering
            setTimeout(injectOverlay, 500);
        } else {
            cleanup();
        }
    });

    // Observe URL changes via title changes (YouTube updates title on navigation)
    observer.observe(document.querySelector("title")!, { childList: true });

    // Also listen for yt-navigate-finish (YouTube's custom navigation event)
    window.addEventListener("yt-navigate-finish", () => {
        setTimeout(injectOverlay, 500);
    });
}
