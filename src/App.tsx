import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { isMobilePlatform, isNative } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "./back";
import Home from "./pages/Home";
import Search, { RankPage } from "./pages/Search";
import Category, { ChannelPage } from "./pages/Category";
import Profile from "./pages/Profile";
import Feed from "./components/Feed";
import { PostsPage, PostDetail } from "./pages/Posts";
import LoginModal from "./components/LoginModal";
import { ToastHost } from "./components/ui";
import { WindowsRail, WindowsTitleBar } from "./components/WindowsChrome";
import ResizeHandles from "./components/ResizeHandles";
import { IMoon, ISearch, ISidebar, ISun, Logo } from "./icons";

// The player reserves this exact height; the bottom safe area is added separately.
const MOBILE_TAB_BAR_HEIGHT = 42;

/* ============ 底部标签栏（Android）—— 细瘦纯文字、低侵入 ============ */
function TabBar() {
  const { tab, setTab } = useStore();
  const items: { k: Tab; label: string }[] = [
    { k: "home", label: "首页" },
    { k: "search", label: "搜索" },
    { k: "category", label: "分类" },
    { k: "profile", label: "我的" },
  ];
  const onVideo = tab === "home";
  return (
    <nav className={`absolute bottom-0 inset-x-0 z-30 ${onVideo ? "" : "bg-s2/95 elev-up"}`} aria-label="主导航"
      style={{ paddingBottom: "var(--sab, 0px)" }}>
      <div className="flex items-center px-1" style={{ height: MOBILE_TAB_BAR_HEIGHT }}>
        {items.map(({ k, label }) => {
          const on = tab === k;
          return (
            <button key={k} onClick={() => setTab(k)} aria-current={on ? "page" : undefined} className="flex-1 h-full flex flex-col items-center justify-center pressable">
              <span className={`text-[13px] leading-none transition-colors duration-200 ${on
                ? (onVideo ? "font-bold text-white" : "font-bold text-on")
                : (onVideo ? "font-normal text-white/55" : "font-normal text-mut")}`}
                style={onVideo ? { textShadow: "0 1px 8px rgba(0,0,0,.7)" } : undefined}>
                {label}
              </span>
              <span className={`mt-[5px] w-[3px] h-[3px] rounded-full transition-opacity duration-200 ${on ? (onVideo ? "bg-white" : "bg-primary") : "opacity-0"}`} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ============ 堆栈页面 ============ */
function StackPage({ page, onBack, wide, top, bottomInset }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} />;
  return null;
}

/* ============ 应用主体 ============ */
function AppBody() {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobilePlatform(platform));

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = fs ? 0 : MOBILE_TAB_BAR_HEIGHT;
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）不显示底栏：
     底栏会盖住评论抽屉的输入框，且这些页面本身是沉浸的 */
  const stackInset = fs ? 0 : 20;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-android plat-${platform}`}>
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <div className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={bottomInset} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>

        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg a-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
          </div>
        ))}

        {!fs && stack.length === 0 && <TabBar />}
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳 ============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(false);
  const theater = useStore().theater;
  return (
    <div className="absolute inset-0 flex flex-col bg-canvas win-root">
      <WindowsTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      <ResizeHandles />
    </div>
  );
}

/** The browser keeps navigation and appearance controls without native window buttons. */
function BrowserDesktopShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { theater, theme, setTheme, setTab } = useStore();
  return (
    <div className="absolute inset-0 flex flex-col bg-canvas win-root">
      <header className="web-header">
        <div className="flex items-center gap-2.5 font-semibold text-[17px]"><Logo size={25} />HGhub</div>
        <button onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} className="rounded-(--r-sm) hover:bg-s3"><ISidebar size={18} /></button>
        <div className="flex-1" />
        <button onClick={() => setTab("search")} aria-label="搜索" className="rounded-(--r-sm) hover:bg-s3"><ISearch size={19} /></button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="切换外观" className="rounded-(--r-sm) hover:bg-s3">{theme === "dark" ? <ISun size={18} /> : <IMoon size={18} />}</button>
      </header>
      <div className="relative flex-1 min-h-0"><ShellInner collapsed={collapsed || theater} theater={theater} /></div>
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, loginOpen, setLoginOpen, tab, setTab } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        setTab((["home", "search", "category", "profile"] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;

  return (
    <div className="absolute inset-0 flex bg-canvas plat-windows">
      {!theater && <WindowsRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <div className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={14} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>
        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg win-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  return (
    <div className="absolute inset-0 flex flex-col bg-canvas plat-android"
      style={{ "--sat": "max(env(safe-area-inset-top), 8px)", "--sab": "max(env(safe-area-inset-bottom), 6px)" } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs } = useStore();

  /* —— 安卓硬件返回键 ——
     层级：全屏 → 面板/弹层 → 登录框 → 页面栈 → 回首页 → 退出应用。
     不注册这个监听，Tauri 会直接 webView.goBack() 或退出，表现就是「任意页面返回都回桌面」。 */
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (runBack()) return;                                  // 播放器的选集/评论/图文面板
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    if (isNative) invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  };

  useEffect(() => {
    if (!isNative || platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    if (!isNative) return;
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  return (
    <>
      {isMobilePlatform(platform) ? <MobileShell /> : isNative ? <DesktopShell /> : <BrowserDesktopShell />}
      <LoginModal />
      <ToastHost />
      {/* 登录遮罩键盘处理占位 */}
      {loginOpen && <div className="hidden" onClick={() => setLoginOpen(false)} />}
    </>
  );
}
