import { useCallback, useEffect, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api, isMobilePlatform } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch, IVol, IVolMute } from "../icons";
import { Empty } from "../components/ui";

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { muted, setMuted, setTab, toast, fs, platform } = useStore();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);

  const load = useCallback(async (p: number) => {
    if (loadingRef.current || (done && p !== 1)) return;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.feed(p, 10);
      const list = res?.items || [];
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...list.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      if (!list.length || (res?.pagination && p >= res.pagination.pages)) setDone(true);
    } catch (e) {
      setError((e as Error).message || "加载失败");
      toast((e as Error).message || "加载失败", "info");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [done, toast]);

  useEffect(() => { if (!items.length) load(1); /* eslint-disable-next-line */ }, []);

  const ids = items.map((v) => v.id);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={() => { if (!loading && !done) load(page + 1); }} />
      ) : loading ? (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-4 pb-20">
          <Empty icon={<ISearch size={26} />} title={error ? "暂时无法加载" : "暂无内容"} sub={error || "稍后再来看看"}
            action="重新加载" onAction={() => { setDone(false); void load(1); }} />
          <button onClick={() => setTab("profile")} className="min-h-11 px-4 text-[13px] text-primary pressable">前往「我的」检查网络设置</button>
        </div>
      )}

      {/* 移动端：静音 + 搜索 */}
      {isMobilePlatform(platform) && !fs && (
        <div className="absolute inset-x-0 z-20 flex items-center px-3 pointer-events-none" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setMuted((m) => !m)} aria-label={muted ? "开启声音" : "静音"}
              className="pointer-events-auto w-9 h-9 rounded-full bg-black/40 flex items-center justify-center text-white/90 pressable elev-1">
              {muted ? <IVolMute size={17} /> : <IVol size={17} />}
            </button>
            <button onClick={() => setTab("search")} aria-label="搜索"
              className="pointer-events-auto w-9 h-9 rounded-full bg-black/40 flex items-center justify-center text-white/90 pressable elev-1">
              <ISearch size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
