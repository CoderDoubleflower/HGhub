import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AUTH_REQUIRED_EVENT, APP_VERSION, isNative, webApi, type AccessSession } from "../api";
import { ILogin, Logo } from "../icons";

type Access = { username: string; logout: () => Promise<void> };
const AccessContext = createContext<Access>({ username: "", logout: async () => {} });
export const useAccess = () => useContext(AccessContext);

/** Mount the application only after the server has confirmed the access session. */
export default function SiteAccess({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AccessSession | null>(isNative ? { authenticated: true } : null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(!isNative);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  const check = useCallback(async () => {
    setChecking(true);
    setError("");
    try { setSession(await webApi.session()); }
    catch (e) { setError((e as Error).message); }
    finally { setChecking(false); }
  }, []);

  useEffect(() => {
    if (isNative) return;
    void check();
    const expired = () => {
      setSession({ authenticated: false });
      setPassword("");
      setError("访问登录已过期，请重新登录");
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
  }, [check]);

  const logout = useCallback(async () => {
    await webApi.logout();
    setSession({ authenticated: false });
    setPassword("");
    setError("");
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await webApi.login(username.trim(), password);
      const confirmed = await webApi.session();
      if (!confirmed.authenticated) throw new Error("无法保存登录状态，请确认浏览器允许此站点使用 Cookie");
      setPassword("");
      setSession(confirmed);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (session?.authenticated) {
    return <AccessContext.Provider value={{ username: session.username || "", logout }}>{children}</AccessContext.Provider>;
  }

  return (
    <main className="site-access">
      <div className="site-access-content">
        <div className="flex items-center gap-3 mb-9">
          <Logo size={42} />
          <div><div className="text-[25px] font-bold tracking-tight">HGhub</div><div className="text-[12px] text-mut mt-0.5">随时打开，接着观看</div></div>
        </div>
        <h1 className="text-[25px] font-semibold leading-tight">登录你的网页服务</h1>
        <p className="text-[13px] leading-relaxed text-mut mt-3 mb-6">使用部署时设置的访问账号。进入后，可在「我的」中登录平台账号和设置代理。</p>
        {checking ? (
          <div className="flex items-center gap-3 py-8 text-mut" role="status"><div className="w-5 h-5 spinner" />正在连接服务…</div>
        ) : session === null ? (
          <div>
            <p role="alert" className="text-[13px] text-danger leading-relaxed">{error}</p>
            <button type="button" onClick={check} className="mt-5 h-12 w-full rounded-(--r-sm) bg-primary text-on-primary font-semibold pressable">重新连接</button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="block text-[13px] font-medium">
              访问账号
              <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128}
                className="web-field mt-2" placeholder="部署时设置的账号" />
            </label>
            <label className="block text-[13px] font-medium">
              访问密码
              <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" maxLength={1024}
                className="web-field mt-2" placeholder="输入访问密码" />
            </label>
            {error && <p role="alert" className="text-[13px] text-danger leading-relaxed">{error}</p>}
            <button type="submit" disabled={busy} className="h-12 mt-1 rounded-(--r-sm) bg-primary text-on-primary font-semibold flex items-center justify-center gap-2 pressable disabled:opacity-60">
              {busy ? <><div className="w-4 h-4 spinner" />正在登录…</> : <><ILogin size={18} />进入 HGhub</>}
            </button>
          </form>
        )}
        <p className="text-[11px] text-dim mt-8">HGhub Web · {APP_VERSION}</p>
      </div>
    </main>
  );
}
