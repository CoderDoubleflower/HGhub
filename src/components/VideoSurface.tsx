import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isNative, mediaUrl } from "../api";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef({ autoPlay, muted, volume, rate, onPause, onError });
  latest.current = { autoPlay, muted, volume, rate, onPause, onError };

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => { videoRef.current?.play().catch(() => latest.current.onPause?.()); },
    pause: () => videoRef.current?.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => latest.current.onPause?.()); else v.pause();
    },
    seek: (t: number) => { const v = videoRef.current; if (v && Number.isFinite(t)) v.currentTime = t; },
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setReady(false);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (!src) { video.removeAttribute("src"); video.load(); return; }

    const url = mediaUrl(src);
    const useHls = !url.includes("/seg?u=");

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = latest.current.volume;
      v.muted = latest.current.muted;
      v.playbackRate = latest.current.rate;
    };
    applySettings();

    const autoplay = () => {
      if (latest.current.autoPlay) video.play().catch(() => latest.current.onPause?.());
    };
    // Safari's native HLS also works without MediaSource and keeps iPhone playback inline.
    const nativeHls = !isNative && Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
    if (useHls && !nativeHls && Hls.isSupported()) {
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        backBufferLength: 30,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, autoplay);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries++ < 2) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) hls.recoverMediaError();
        else {
          latest.current.onError?.(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "视频加载失败，请检查代理和网络后重试" : "当前视频无法播放，请尝试其他集数或浏览器");
          hls.destroy(); hlsRef.current = null;
        }
      });
    } else {
      video.src = url;
      autoplay();
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      muted={muted}
      preload="metadata"
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={{ opacity: ready ? 1 : 0, transition: "opacity .35s" }}
      onLoadedData={(e) => { setReady(true); reapply(e.target as HTMLVideoElement); }}
      onTimeUpdate={(e) => onTime?.((e.target as HTMLVideoElement).currentTime)}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        onSize?.(v.videoWidth || 0, v.videoHeight || 0);
      }}
      onPlay={() => onPlaying?.()}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={() => onPlaying?.()}
      onEnded={() => onEnded?.()}
      onError={(event) => {
        const error = event.currentTarget.error;
        if (error && error.code !== MediaError.MEDIA_ERR_ABORTED) onError?.(error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "当前浏览器不支持此视频格式" : "视频加载失败，请检查网络后重试");
      }}
    />
  );
});

export default VideoSurface;
