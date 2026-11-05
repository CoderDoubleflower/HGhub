import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store";
import { isNative, logLine } from "./api";
import SiteAccess from "./components/SiteAccess";
import "./index.css";

if (!isNative) document.documentElement.classList.add("web-host");
try {
  document.documentElement.classList.toggle("theme-light", localStorage.getItem("hghub_theme") === "light");
} catch { /* Browser storage can be disabled. */ }

/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  void logLine(`[${kind}] ${msg}`);
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SiteAccess>
      <AppProvider>
        <App />
      </AppProvider>
    </SiteAccess>
  </React.StrictMode>,
);
