import { useEffect, useRef, useState } from "react";

type Props = {
  videoId: string | null;
  playing: boolean;
  time: number;
  onLoad: (videoId: string) => void;
  onSync: (playing: boolean, time: number) => void;
};

function parseVideoId(input: string): string | null {
  input = input.trim();
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtube.com")) return url.searchParams.get("v");
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("?")[0];
  } catch {
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  }
  return null;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

// Tracks whether the API script has been injected globally
let apiScriptInjected = false;
// Queue of callbacks to run once the API is ready
const apiReadyCallbacks: Array<() => void> = [];

function whenYTReady(cb: () => void) {
  if (window.YT && window.YT.Player) {
    cb();
    return;
  }
  apiReadyCallbacks.push(cb);
  if (!apiScriptInjected) {
    apiScriptInjected = true;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }
  // Override (or chain) the global callback
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    if (prev) prev();
    apiReadyCallbacks.forEach(fn => fn());
    apiReadyCallbacks.length = 0;
  };
}

export default function YoutubeActivity({ videoId, playing, time, onLoad, onSync }: Props) {
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");

  const playerRef      = useRef<any>(null);
  const playerReady    = useRef(false);
  const suppressRef    = useRef(false);
  const pendingVideoId = useRef<string | null>(null);

  // Keep latest props accessible inside player callbacks without stale closures
  const onSyncRef   = useRef(onSync);
  const videoIdRef  = useRef(videoId);
  const playingRef  = useRef(playing);
  const timeRef     = useRef(time);
  useEffect(() => { onSyncRef.current  = onSync;  }, [onSync]);
  useEffect(() => { videoIdRef.current = videoId; }, [videoId]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { timeRef.current    = time;    }, [time]);

  // Create the player once, after the API is ready and the DOM div exists
  useEffect(() => {
    whenYTReady(() => {
      if (playerRef.current) return;

      playerRef.current = new window.YT.Player("yt-player", {
        height: "100%",
        width: "100%",
        playerVars: { controls: 1, rel: 0, modestbranding: 1, autoplay: 0 },
        events: {
          onReady: () => {
            playerReady.current = true;
            // If a video was requested before the player was ready, load it now
            if (pendingVideoId.current) {
              playerRef.current.loadVideoById(pendingVideoId.current);
              pendingVideoId.current = null;
            }
          },
          onStateChange: (e: any) => {
            if (suppressRef.current) return;
            const S = window.YT?.PlayerState;
            if (!S) return;
            if (e.data === S.PLAYING) {
              onSyncRef.current(true, playerRef.current.getCurrentTime());
            } else if (e.data === S.PAUSED || e.data === S.ENDED) {
              onSyncRef.current(false, playerRef.current.getCurrentTime());
            }
          },
        },
      });
    });
  }, []); // run once on mount

  // React to videoId changes coming from the server (remote user loaded a video)
  useEffect(() => {
    if (!videoId) return;
    if (!playerReady.current || !playerRef.current) {
      // Player not ready yet — queue the video
      pendingVideoId.current = videoId;
      return;
    }
    const currentVid = playerRef.current.getVideoData?.()?.video_id ?? "";
    if (currentVid !== videoId) {
      suppressRef.current = true;
      playerRef.current.loadVideoById({ videoId, startSeconds: time });
      // Respect the playing state: pause after load if not playing
      if (!playing) {
        setTimeout(() => {
          playerRef.current?.pauseVideo();
          suppressRef.current = false;
        }, 1200);
      } else {
        setTimeout(() => { suppressRef.current = false; }, 1200);
      }
    }
  }, [videoId]);

  // React to play/pause/seek from the remote user
  useEffect(() => {
    if (!playerReady.current || !playerRef.current || !videoId) return;
    suppressRef.current = true;

    const currentTime = playerRef.current.getCurrentTime?.() ?? 0;
    const diff = Math.abs(currentTime - time);
    if (diff > 2) playerRef.current.seekTo(time, true);

    if (playing) playerRef.current.playVideo();
    else         playerRef.current.pauseVideo();

    setTimeout(() => { suppressRef.current = false; }, 800);
  }, [playing, time]);

  function handleLoad() {
    const vid = parseVideoId(urlInput);
    if (!vid) {
      setUrlError("Couldn't find a valid YouTube video ID. Try pasting the full URL.");
      return;
    }
    setUrlError("");
    setUrlInput("");
    onLoad(vid); // tell the server → server broadcasts YT_STATE → videoId prop updates → useEffect above fires
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* URL loader */}
      <div className="card" style={{ padding: 16 }}>
        <div className="card-title">Load a YouTube Video</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={urlInput}
            onChange={(e) => { setUrlInput(e.target.value); setUrlError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleLoad(); }}
            placeholder="Paste a YouTube URL or 11-char video ID…"
            style={{ flex: 1 }}
          />
          <button className="btn-primary btn-sm" onClick={handleLoad} disabled={!urlInput.trim()}>
            Load
          </button>
        </div>
        {urlError && <p style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>{urlError}</p>}
        <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
          Either of you can load a video. Play, pause, and seeking are synced in real time.
        </p>
      </div>

      {/* Player container */}
      <div style={{
        width: "100%",
        aspectRatio: "16/9",
        borderRadius: 14,
        overflow: "hidden",
        border: "2px solid var(--border)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        background: "#000",
        position: "relative",
      }}>
        {!videoId && (
          <div style={{
            position: "absolute", inset: 0, zIndex: 1,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            color: "var(--text-dim)", gap: 10, pointerEvents: "none",
          }}>
            <div style={{ fontSize: 48 }}>▶</div>
            <div style={{ fontSize: 14 }}>No video loaded yet — paste a link above</div>
          </div>
        )}
        {/* This div gets replaced by the YT iframe */}
        <div id="yt-player" style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}
