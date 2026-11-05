import React, { useEffect, useRef, useState } from "react";
import { fmtTime } from "../api";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import { ICompress, IExpand, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
};

/** Inline player shares the HLS/native-video path used by the full-screen feed. */
export default function Player({
  src, poster, autoPlay = false, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "",
}: Props) {
  const videoRef = useRef<VideoHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [full, setFull] = useState(false);
  const [rate, setRate] = useState(1);
  const [localMuted, setLocalMuted] = useState(muted);
  const [error, setError] = useState("");
  const effectiveMuted = onToggleMute ? muted : localMuted;

  useEffect(() => { setLocalMuted(muted); }, [muted]);
  useEffect(() => { setError(""); setTime(0); setDuration(0); }, [src]);
  useEffect(() => {
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const onSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!duration) return;
    const target = Number(event.target.value) / 1000 * duration;
    videoRef.current?.seek(target);
    setTime(target);
  };

  const toggleFull = () => {
    const wrapper = wrapRef.current;
    if (!wrapper) return;
    if (document.fullscreenElement && document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    else if (wrapper.requestFullscreen) void wrapper.requestFullscreen().catch(() => setError("此浏览器暂时无法全屏"));
    else {
      const video = videoRef.current?.el() as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else setError("此浏览器暂时无法全屏");
    }
  };

  const toggleMute = () => {
    if (onToggleMute) onToggleMute();
    else setLocalMuted((value) => !value);
  };
  const percent = duration > 0 ? Math.min(100, time / duration * 100) : 0;

  return (
    <div ref={wrapRef} className={`relative bg-black overflow-hidden group ${className}`}>
      <VideoSurface ref={videoRef} src={src} poster={poster} autoPlay={autoPlay} muted={effectiveMuted} loop={loop} rate={rate}
        onClick={() => videoRef.current?.toggle()}
        onPlaying={() => { setPlaying(true); setWaiting(false); setError(""); onTogglePlay?.(true); onPlaying?.(); }}
        onPause={() => { setPlaying(false); setWaiting(false); onTogglePlay?.(false); }}
        onWaiting={() => setWaiting(true)} onTime={setTime} onDuration={setDuration} onEnded={onEnded}
        onError={(message) => { setError(message); setWaiting(false); setPlaying(false); }} />

      {error && <div role="alert" className="absolute left-3 right-3 top-3 z-30 rounded bg-black/75 px-3 py-2 text-[12px] leading-relaxed text-red-200">{error}</div>}
      {waiting && <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>}
      {!playing && !waiting && (
        <button onClick={() => videoRef.current?.play()} aria-label="播放" className="absolute inset-0 flex items-center justify-center">
          <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable"><IPlayF size={26} className="text-white ml-0.5" /></span>
        </button>
      )}
      {controls && (
        <div className="inline-player-controls absolute inset-x-0 bottom-0 px-3 pb-2 pt-8 bg-gradient-to-t from-black/80 to-transparent transition-opacity">
          <input type="range" min={0} max={1000} value={Math.round(percent * 10)} onChange={onSeek} aria-label="播放进度"
            className="hg-range w-full" style={{ "--fill": `${percent}%` } as React.CSSProperties} />
          <div className="flex items-center gap-2 mt-1 text-white">
            <button onClick={() => videoRef.current?.toggle()} aria-label={playing ? "暂停" : "播放"} className="min-w-9 min-h-9 flex items-center justify-center pressable">{playing ? <IPauseF size={16} /> : <IPlayF size={16} />}</button>
            <button onClick={toggleMute} aria-label={effectiveMuted ? "开启声音" : "静音"} className="min-w-9 min-h-9 flex items-center justify-center pressable">{effectiveMuted ? <IVolMute size={16} /> : <IVol size={16} />}</button>
            <span className="text-[11px] tabular-nums text-white/85">{fmtTime(time)} / {fmtTime(duration)}</span>
            <div className="flex-1" />
            <button onClick={() => setRate((value) => value === 1 ? 1.25 : value === 1.25 ? 1.5 : value === 1.5 ? 2 : 1)} aria-label={`播放速度 ${rate} 倍`} className="min-w-9 min-h-9 text-[12px] font-semibold pressable">{rate}x</button>
            <button onClick={toggleFull} aria-label={full ? "退出全屏" : "全屏"} className="min-w-9 min-h-9 flex items-center justify-center pressable">{full ? <ICompress size={16} /> : <IExpand size={16} />}</button>
          </div>
        </div>
      )}
    </div>
  );
}
