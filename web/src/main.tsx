import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installAuthFetch } from "./auth/token";
import { basePathname } from "./lib/url";

// V53: install the fetch wrapper before React mounts so the first /api/*
// call already carries the Bearer header (if a token is in localStorage).
installAuthFetch();

// The server injects <base href> into index.html. Plain "#…" links resolve
// against the base, so if the page was opened at another path (/vault without
// the slash, /vault/index.html, a SPA fallback) every hash link would load a
// new document. Align the URL with the base dir first.
if (document.querySelector("base")) {
  const baseDir = basePathname();
  if (window.location.pathname !== baseDir) {
    window.history.replaceState(
      window.history.state,
      "",
      baseDir + window.location.search + window.location.hash,
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
