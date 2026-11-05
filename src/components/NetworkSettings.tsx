import { useEffect, useState, type FormEvent } from "react";
import { webApi, type NetworkSettings as Settings, type NetworkTest } from "../api";
import { useStore } from "../store";
import { useAccess } from "./SiteAccess";
import { ILink, ILogout } from "../icons";

export default function NetworkSettings() {
  const { username, loginRequired, logout } = useAccess();
  const { toast } = useStore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [proxyUrl, setProxyUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NetworkTest | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try { setSettings(await webApi.settings()); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const save = async (value: string) => {
    if (busy || testing) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const updated = await webApi.saveSettings(value);
      setSettings(updated);
      setProxyUrl("");
      setEditing(false);
      toast(value ? "代理已保存，新的请求立即生效" : "已切换为直连", "ok");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing) void save(proxyUrl.trim());
  };

  const test = async () => {
    if (testing || busy) return;
    setTesting(true);
    setError("");
    setResult(null);
    try { setResult(await webApi.testSettings()); }
    catch (e) { setError((e as Error).message); }
    finally { setTesting(false); }
  };

  return (
    <section className="mt-5 rounded-(--r-md) bg-s2 p-4" aria-labelledby="network-settings-heading">
      <h2 id="network-settings-heading" className="flex items-center gap-2 text-[15px] font-semibold"><ILink size={17} className="text-primary" />网络与代理</h2>
      <div className="text-[12px] text-mut leading-relaxed mt-2">代理用于服务器请求数据、图片和视频，保存后对所有浏览器生效。</div>
      {loading ? (
        <div className="py-5 text-[13px] text-mut" role="status">正在读取设置…</div>
      ) : settings ? (
        <>
          <div className="my-4 text-[12px] leading-relaxed text-mut">
            <span className={`inline-flex items-center gap-1.5 font-medium ${settings.proxyConfigured ? "text-primary" : "text-on"}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current" />{settings.proxyConfigured ? "使用代理" : "直接连接"}
            </span>
            {settings.proxySource === "environment" && <span className="ml-2">来自部署配置</span>}
            {settings.proxyConfigured && <div className="mt-1 break-all font-mono text-[11px]">{settings.proxyUrl}</div>}
          </div>
          <form onSubmit={submit} className="space-y-3">
            <label htmlFor="proxy-url" className="block text-[13px] font-medium">代理地址</label>
            <input id="proxy-url" value={proxyUrl} onChange={(e) => { setProxyUrl(e.target.value); setEditing(true); setResult(null); }}
              placeholder={settings.proxyConfigured ? "输入新地址以替换当前代理" : "http://192.168.1.10:7890"}
              autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" maxLength={2048} className="web-field" aria-describedby="proxy-hint" />
            <p id="proxy-hint" className="text-[11px] text-mut leading-relaxed">支持 HTTP、HTTPS、SOCKS5 / SOCKS5H。留空保存可切换直连；未编辑时会保留当前配置。</p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={!editing || busy || testing} className="min-h-11 px-4 rounded-(--r-sm) bg-primary text-on-primary text-[13px] font-semibold pressable disabled:opacity-45">{busy ? "保存中…" : "保存设置"}</button>
              <button type="button" onClick={test} disabled={busy || testing || editing} className="min-h-11 px-4 rounded-(--r-sm) bg-s4 text-on text-[13px] pressable disabled:opacity-45">{testing ? "检测中…" : "测试当前连接"}</button>
              {settings.proxyConfigured && <button type="button" onClick={() => { setProxyUrl(""); setEditing(true); setResult(null); }} disabled={busy || testing} className="min-h-11 px-3 text-[12px] text-mut pressable">清空地址</button>}
            </div>
            {editing && <p className="text-[11px] text-mut">{proxyUrl.trim() ? "新地址尚未保存。" : "保存后将停用当前代理，改为直连。"}</p>}
          </form>
          <p className="mt-4 text-[11px] text-mut leading-relaxed">默认使用 host 网络，宿主机上的代理可填写 <code>http://127.0.0.1:7890</code>；代理在其他设备上时，填写该设备的局域网地址，并在代理软件中允许局域网连接。</p>
          {result && <p role="status" className={`mt-3 text-[12px] leading-relaxed ${result.ok ? "text-primary" : "text-danger"}`}>{result.ok ? `连接成功 · HTTP ${result.status ?? 200} · ${result.ms} ms` : `连接失败：${result.error || (result.status ? `HTTP ${result.status}` : "请检查代理地址和网络")}`}</p>}
        </>
      ) : <button type="button" onClick={load} className="mt-3 text-primary text-[13px] min-h-11 pressable">重新读取设置</button>}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger leading-relaxed break-words">{error}</p>}
      {loginRequired && <div className="mt-5 pt-4 border-t border-current/10 flex items-center gap-3">
        <div className="flex-1 min-w-0 text-[12px] text-mut">访问账号 <span className="text-on break-all">{username}</span></div>
        <button type="button" disabled={leaving} onClick={async () => {
          setLeaving(true);
          try { await logout(); }
          catch (e) { setError((e as Error).message); setLeaving(false); }
        }} className="flex items-center gap-1.5 min-h-11 px-3 rounded-(--r-sm) text-[12px] bg-s3 pressable disabled:opacity-60"><ILogout size={14} />{leaving ? "退出中…" : "退出网页登录"}</button>
      </div>}
    </section>
  );
}
