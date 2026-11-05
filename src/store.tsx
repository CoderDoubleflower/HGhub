import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, getPlatform, isNative, subscribePlatform, UPSTREAM_AUTH_REQUIRED_EVENT, type Platform } from "./api";
import { runBack } from "./back";
import type { User } from "./types";

export type { Platform } from "./api";
export type Theme = "dark" | "light";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post" }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "posts" }
  | { kind: "post"; id: number };

export type Toast = { id: number; msg: string; icon?: "ok" | "heart" | "star" | "info" };

type Persist = {
  likes: number[];
  favs: number[];
  history: number[];
  follows: number[];
  muted: boolean;
  volume: number;
  searchHist: string[];
};

const LEGACY_LS = "hghub_app_v1";
const PREFS_LS = "hghub_preferences_v2";
const MIGRATION_LS = "hghub_accounts_migrated_v2";
const accountKey = (id: number | null) => `hghub_account_v2_${id ?? "guest"}`;
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, volume: 0.7, searchHist: [],
};

function savePersist(key: string, value: Persist) {
  try {
    const { muted, volume, ...account } = value;
    localStorage.setItem(key, JSON.stringify(account));
    localStorage.setItem(PREFS_LS, JSON.stringify({ muted, volume }));
  } catch { /* Keep the current in-memory state when storage is unavailable. */ }
}

function loadPersist(key: string, migrate: boolean): Persist {
  try {
    const raw = localStorage.getItem(key);
    const legacy = migrate && !localStorage.getItem(MIGRATION_LS) ? localStorage.getItem(LEGACY_LS) : null;
    const account = JSON.parse(raw || legacy || "{}") as Partial<Persist>;
    const preferences = JSON.parse(localStorage.getItem(PREFS_LS) || legacy || "{}") as Partial<Persist>;
    const ids = (value: unknown): number[] => Array.isArray(value)
      ? [...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item > 0))].slice(0, 10_000) : [];
    const volume = Number(preferences.volume);
    const loaded: Persist = {
      likes: ids(account.likes), favs: ids(account.favs), history: ids(account.history).slice(0, 80), follows: ids(account.follows),
      searchHist: Array.isArray(account.searchHist) ? account.searchHist.filter((item): item is string => typeof item === "string").slice(0, 12) : [],
      muted: typeof preferences.muted === "boolean" ? preferences.muted : DEFAULTS.muted,
      volume: preferences.volume !== undefined && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULTS.volume,
    };
    if (migrate) {
      // Import legacy data once, after the original platform identity is known.
      savePersist(key, loaded);
      localStorage.setItem(MIGRATION_LS, "1");
    }
    return loaded;
  } catch { return DEFAULTS; }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem("hghub_theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
}

type Store = {
  platform: Platform;
  theme: Theme; setTheme: (t: Theme) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null) => void;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; history: number[]; follows: number[];
  isLiked: (id: number) => boolean; isFav: (id: number) => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  addHistory: (id: number) => void;
  clearHistory: () => void;
  clearLocal: () => void;
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; clearSearchHist: () => void;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"]) => void;
};

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const platform = useSyncExternalStore(subscribePlatform, getPlatform);
  const [p, setPersistState] = useState<Persist>(DEFAULTS);
  const persistRef = useRef(p);
  const persistKey = useRef(accountKey(null));
  const restored = useRef(false);
  const [ready, setReady] = useState(false);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [tab, setTabRaw] = useState<Tab>("home");
  const [stack, setStack] = useState<Page[]>([]);
  const [user, setUserState] = useState<User | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const toastSeq = useRef(0);
  const navigation = useRef<{ tab: Tab; stack: Page[] }>({ tab: "home", stack: [] });
  const navigationOwner = useRef(`hghub-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const navigationIndex = useRef(0);

  // Compute updates synchronously: callers need the new on/off value before
  // sending a corresponding POST or DELETE. React state updaters may be deferred.
  const setP = useCallback((update: React.SetStateAction<Persist>) => {
    const next = typeof update === "function" ? update(persistRef.current) : update;
    persistRef.current = next;
    setPersistState(next);
    if (restored.current) savePersist(persistKey.current, next);
  }, []);

  const setUser = useCallback((nextUser: User | null) => {
    const key = accountKey(nextUser?.id ?? null);
    if (!restored.current || persistKey.current !== key) {
      const next = loadPersist(key, !restored.current);
      persistKey.current = key;
      persistRef.current = next;
      restored.current = true;
      setPersistState(next);
    }
    setUserState(nextUser);
  }, []);

  useEffect(() => {
    if (isNative) return;
    window.history.replaceState({ hghub: { ...navigation.current, owner: navigationOwner.current, index: 0 } }, "");
    const restore = (event: PopStateEvent) => {
      const state = event.state?.hghub;
      const next = state?.owner === navigationOwner.current
        ? { tab: state.tab as Tab, stack: state.stack as Page[] }
        : { tab: "home" as Tab, stack: [] };
      navigation.current = next;
      navigationIndex.current = state?.owner === navigationOwner.current ? state.index : 0;
      setTabRaw(next.tab);
      setStack(next.stack);
      setLoginOpen(false);
      setFsState(false);
      runBack();
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    const expired = () => { setUser(null); setLoginOpen(true); };
    window.addEventListener(UPSTREAM_AUTH_REQUIRED_EVENT, expired);
    return () => window.removeEventListener(UPSTREAM_AUTH_REQUIRED_EVENT, expired);
  }, [setUser]);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem("hghub_theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    let alive = true;
    api.boot()
      .then((result) => { if (alive) setUser(result.user?.id ? result.user : null); })
      .catch(() => { if (alive) setUser(null); })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [setUser]);

  const toast = useCallback((msg: string, icon?: Toast["icon"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, icon }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2200);
  }, []);

  const navigate = useCallback((next: { tab: Tab; stack: Page[] }) => {
    navigation.current = next;
    if (!isNative) window.history.pushState({ hghub: { ...next, owner: navigationOwner.current, index: ++navigationIndex.current } }, "");
    setTabRaw(next.tab);
    setStack(next.stack);
  }, []);
  const setTab = useCallback((t: Tab) => {
    if (navigation.current.tab === t && !navigation.current.stack.length) return;
    navigate({ tab: t, stack: [] });
  }, [navigate]);
  const push = useCallback((pg: PageInput) => {
    navigate({ ...navigation.current, stack: [...navigation.current.stack, { ...pg, key: `p${++seq}` } as Page] });
  }, [navigate]);
  const pop = useCallback(() => {
    if (!navigation.current.stack.length) return;
    if (!isNative && window.history.state?.hghub?.owner === navigationOwner.current && navigationIndex.current > 0) {
      window.history.back();
      return;
    }
    const next = { ...navigation.current, stack: navigation.current.stack.slice(0, -1) };
    navigation.current = next;
    setStack(next.stack);
  }, []);

  const toggleLikeLocal = useCallback((id: number) => {
    const on = !persistRef.current.likes.includes(id);
    setP((state) => ({ ...state, likes: on ? [id, ...state.likes] : state.likes.filter((value) => value !== id) }));
    return on;
  }, [setP]);
  const toggleFavLocal = useCallback((id: number) => {
    const on = !persistRef.current.favs.includes(id);
    setP((state) => ({ ...state, favs: on ? [id, ...state.favs] : state.favs.filter((value) => value !== id) }));
    return on;
  }, [setP]);
  const toggleFollowLocal = useCallback((id: number) => {
    const on = !persistRef.current.follows.includes(id);
    setP((state) => ({ ...state, follows: on ? [id, ...state.follows] : state.follows.filter((value) => value !== id) }));
    return on;
  }, [setP]);
  const addHistory = useCallback((id: number) => {
    setP((s) => ({ ...s, history: [id, ...s.history.filter((x) => x !== id)].slice(0, 80) }));
  }, []);
  const clearHistory = useCallback(() => setP((s) => ({ ...s, history: [] })), []);
  const clearLocal = useCallback(() => setP((s) => ({ ...s, likes: [], favs: [], history: [], searchHist: [] })), []);
  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
      setUser(null);
      toast("已退出平台账号", "info");
    } catch (error) {
      toast((error as Error).message || "退出失败，请重试", "info");
    }
  }, [setUser, toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => ({ ...s, muted: typeof v === "function" ? v(s.muted) : v }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform,
    theme, setTheme: setThemeState,
    tab, setTab, stack, push, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    likes: p.likes, favs: p.favs, history: p.history, follows: p.follows,
    isLiked: (id) => p.likes.includes(id),
    isFav: (id) => p.favs.includes(id),
    toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, clearLocal,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs,
    searchHist: p.searchHist, addSearch, clearSearchHist,
    toasts, toast,
  }), [platform, theme, tab, setTab, stack, push, pop, user, loginOpen, logout,
    p, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, addHistory, clearHistory, clearLocal,
    setMuted, setVolume, addSearch, clearSearchHist, toasts, toast, theater, setTheater, fs, setFs]);

  return (
    <Ctx.Provider value={value}>
      {ready ? <React.Fragment key={user?.id ?? "guest"}>{children}</React.Fragment> : (
        <div className="absolute inset-0 flex items-center justify-center gap-3 text-mut text-[13px]" role="status"><div className="w-5 h-5 spinner" />正在恢复会话…</div>
      )}
    </Ctx.Provider>
  );
}
