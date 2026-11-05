import { useEffect, useState } from "react";
import { api, APP_VERSION, fmt, isNative, logLine } from "../api";
import type { Detail, User } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img, Modal, Toggle } from "../components/ui";
import NetworkSettings from "../components/NetworkSettings";
import { IBroom, IChevR, IClock, IHeart, IInfo, ILink, ILogout, IMoon, IStar, ISun, IUser, IUserF } from "../icons";

export default function Profile({ wide }: { wide: boolean }) {
  const { user, setUser, setLoginOpen, logout, theme, setTheme, history, favs, clearHistory, clearLocal, push, toast, platform } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [cards, setCards] = useState<Detail[]>([]);
  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);

  const ids = tab === "fav" ? favs : history;

  useEffect(() => {
    let alive = true;
    if (!ids.length) { setCards([]); return; }
    setLoading(true);
    Promise.allSettled(ids.slice(0, 12).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        setCards(rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Detail>).value));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ids.join(",")]);

  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) { setErr("请输入账号与密码"); return; }
    setBusy(true);
    setErr("");
    try {
      const res = mode === "login"
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password, email.trim());
      setUser(res.user as User);
      setPassword("");
      setLoginOpen(false);
      toast(mode === "login" ? `欢迎回来，${(res.user as User)?.nickname || username}` : "注册成功", "ok");
    } catch (e) {
      setErr((e as Error).message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  /* 未登录：登录卡片 */
  if (!user) {
    return (
      <div className="absolute inset-0 bg-bg flex flex-col">
        <div className="shrink-0 px-4 pb-1" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
          <div className="text-[24px] font-bold text-on leading-none">我的</div>
          <div className="text-[12px] text-mut mt-1.5">登录平台账号后，可使用平台的互动功能</div>
        </div>

        <div className="flex-1 scroll-y px-4 pt-3 pb-24 w-full max-w-[700px] mx-auto">
          <div className="rounded-(--r-lg) bg-s1 p-5 elev-1 a-rise">
            <div className="flex items-center gap-3">
              <Avatar size={52} icon={<IUser size={24} />} hue={220} />
              <div className="flex-1">
                <div className="text-[15px] font-bold text-on">{mode === "login" ? "登录平台账号" : "注册平台账号"}</div>
                <div className="text-[11px] text-mut mt-0.5">使用原平台账号与密码</div>
              </div>
            </div>

            <div className="flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
              {([["login", "登录"], ["register", "注册"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => { setMode(k); setErr(""); }}
                  className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${mode === k ? "bg-primary text-on-primary" : "text-mut"}`}>{l}</button>
              ))}
            </div>

            <div className="mt-3.5 flex flex-col gap-2.5">
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="平台账号" aria-label="平台账号" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128}
                className="h-10 px-3.5 rounded-(--r-sm) bg-s3 text-[13px] text-on placeholder-dim outline-none focus:bg-s4" />
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="平台密码" aria-label="平台密码" autoComplete={mode === "login" ? "current-password" : "new-password"} maxLength={1024}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                className="h-10 px-3.5 rounded-(--r-sm) bg-s3 text-[13px] text-on placeholder-dim outline-none focus:bg-s4" />
              {mode === "register" && (
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="邮箱（可选）" aria-label="邮箱（可选）" autoComplete="email" maxLength={254}
                  className="h-10 px-3.5 rounded-(--r-sm) bg-s3 text-[13px] text-on placeholder-dim outline-none focus:bg-s4" />
              )}
              {err && <div role="alert" className="text-[12px] text-danger">{err}</div>}
              <button onClick={submit} disabled={busy}
                className="h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-bold pressable disabled:opacity-60">
                {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
              </button>
            </div>
          </div>

          {!isNative && <NetworkSettings />}
          {isNative && <div className="mt-5 rounded-(--r-md) bg-s2 p-4">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-on"><IUserF size={15} className="text-primary" />登录能做什么</div>
            <ul className="mt-2.5 space-y-1.5 text-[11.5px] text-mut leading-relaxed">
              <li>· 点赞 / 收藏与官网账号同步</li>
              <li>· 按剧集记录观看进度</li>
              <li>· 发表评论与回复</li>
            </ul>
          </div>}
        </div>
      </div>
    );
  }

  /* 已登录 */
  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[24px] font-bold text-on leading-none">我的</div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-2 pb-24 w-full max-w-[900px] mx-auto">
        {/* 资料卡 */}
        <div className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
          <Avatar size={56} name={user.nickname} hue={280} ring />
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
            <div className="text-[11px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
            <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
              <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
              <span>收藏 <b className="text-on">{fmt(user.counts?.collect)}</b></span>
              <span>关注 <b className="text-on">{fmt(user.counts?.following)}</b></span>
            </div>
          </div>
          <button onClick={async () => { await logout(); }}
            className="w-11 h-11 rounded-full bg-s3 flex items-center justify-center text-mut pressable" aria-label="退出平台账号">
            <ILogout size={17} />
          </button>
        </div>

        {!isNative && <NetworkSettings />}

        {/* 我的内容 */}
        <div className="flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
          {([["fav", "我的收藏"], ["history", "观看历史"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
              style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
          ))}
        </div>

        <div className="mt-3">
          {loading ? (
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className="grid grid-cols-3 gap-2">
              {cards.map((c) => (
                <button key={c.id} onClick={() => push({ kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id), title: tab === "fav" ? "我的收藏" : "观看历史" })}
                  className="relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable" style={{ paddingTop: "133%" }}>
                  <Img src={c.cover} />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5">
                    <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={clearHistory} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">清空观看历史</button>
          )}
        </div>

        {/* 设置 */}
        <div className="mt-5 rounded-(--r-md) bg-s2 divide-y divide-white/5">
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary">{theme === "dark" ? <IMoon size={16} /> : <ISun size={16} />}</span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">深色外观</div>
              <div className="text-[10.5px] text-mut">切换深色与浅色界面</div>
            </div>
            <Toggle on={theme === "dark"} onChange={(on) => setTheme(on ? "dark" : "light")} label="深色外观" />
          </div>
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IHeart size={16} /></span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">本地喜欢</div>
              <div className="text-[10.5px] text-mut">{favs.length} 部收藏 · {history.length} 条观看记录</div>
            </div>
          </div>
        </div>

        {/* 关于 / 缓存 */}
        <div className="mt-3 rounded-(--r-md) bg-s2 divide-y divide-white/5">
          <button onClick={() => setAbout(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IInfo size={16} /></span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">关于 HGhub</div>
              <div className="text-[10.5px] text-mut">版本 {APP_VERSION} · 开源项目</div>
            </div>
            <IChevR size={15} className="text-mut" />
          </button>
          <button onClick={() => setClearOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IBroom size={16} /></span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">清理缓存</div>
              <div className="text-[10.5px] text-mut">封面 / 播放缓存与本地记录</div>
            </div>
            <IChevR size={15} className="text-mut" />
          </button>
          {/* 打不开时先点这里：把 DNS / 代理 / HTTP 结果复制给维护者 */}
          {isNative && <button onClick={async () => {
            try {
              const text = JSON.stringify(await api.netDiag(), null, 2);
              logLine(`[net_diag] ${text}`);
              await navigator.clipboard?.writeText(text);
              toast("网络诊断结果已复制", "ok");
            } catch (e) {
              toast((e as Error).message || "诊断失败", "info");
            }
          }} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
            <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ILink size={16} /></span>
            <div className="flex-1">
              <div className="text-[12.5px] text-on">网络诊断</div>
              <div className="text-[10.5px] text-mut">检测 DNS / 系统代理 / 官网连通性</div>
            </div>
            <IChevR size={15} className="text-mut" />
          </button>}
        </div>

        <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {isNative ? (platform === "android" ? "Android" : "Windows") : "Web"}</div>

        <Modal open={about} onClose={() => setAbout(false)} width={392}>
          <div className="p-5">
            <div className="flex items-center gap-3">
              <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
              <div>
                <div className="text-[16px] font-bold text-on leading-tight">HGhub</div>
                <div className="text-[11px] text-mut mt-0.5">黄果短剧 · 第三方客户端 v{APP_VERSION}</div>
              </div>
            </div>

            <p className="text-[12px] text-on/70 leading-relaxed mt-4">
              {isNative ? "基于 Rust + Tauri 2 构建的跨平台客户端，支持 Windows 与 Android。" : "支持 Docker 部署的网页版本，可在手机、平板和电脑浏览器中访问。"}
              播放器采用沉浸式竖屏信息流。
            </p>

            <div className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[11px] text-mut leading-relaxed">
              本项目仅供学习与交流，所有内容均来自上游站点，客户端不存储、不分发任何视频内容。
              请于 24 小时内删除相关资源，并支持正版。
            </div>

            <div className="mt-4 divide-y divide-white/5">
              <button onClick={() => { navigator.clipboard?.writeText("https://github.com/Minireel/HGhub").then(() => toast("仓库地址已复制", "ok")).catch(() => {}); }}
                className="w-full flex items-center gap-2 py-2.5 text-left pressable">
                <ILink size={15} className="text-mut" />
                <span className="text-[12px] text-on/85">github.com/Minireel/HGhub</span>
                <span className="ml-auto text-[10.5px] text-primary">复制</span>
              </button>
              <button onClick={() => { navigator.clipboard?.writeText("https://huangguoai.com").then(() => toast("站点地址已复制", "ok")).catch(() => {}); }}
                className="w-full flex items-center gap-2 py-2.5 text-left pressable">
                <ILink size={15} className="text-mut" />
                <span className="text-[12px] text-on/85">huangguoai.com</span>
                <span className="ml-auto text-[10.5px] text-primary">复制</span>
              </button>
            </div>

            <button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on pressable">知道了</button>
          </div>
        </Modal>

        <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330}>
          <div className="p-5">
            <div className="text-[14.5px] font-bold text-on">清理缓存</div>
            <p className="text-[12px] text-mut leading-relaxed mt-2">
              将清除封面与播放列表缓存、喜欢与收藏标记、观看历史和搜索历史。账号登录状态会保留。
            </p>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">取消</button>
              <button disabled={clearing} onClick={async () => {
                setClearing(true);
                try { await api.clearCache(); } catch { /* 忽略 */ }
                clearLocal();
                setClearing(false);
                setClearOpen(false);
                toast("缓存已清理", "ok");
              }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[12.5px] font-semibold text-on-primary pressable disabled:opacity-60">
                {clearing ? "清理中…" : "确定清理"}
              </button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
