import { mobileBrandData } from "./brand-asset";
import { mobileHtml, mobileCss } from "./client-shell";
import { mobileScript } from "./client-script";
import { mobileQrDecoder } from "./qr-decoder";

const html = mobileHtml;
const css = mobileCss;

const sw = `const CACHE="pi-mobile-shell-v8";const SHELL=["/","/app.css","/qr-decoder.js","/app.js","/icon.svg","/manifest.webmanifest"];self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))));self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("pi-mobile-shell-")&&k!==CACHE).map(k=>caches.delete(k))))));self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(e.request.method!=="GET"||u.origin!==self.location.origin||u.search||!SHELL.includes(u.pathname))return;e.respondWith(fetch(e.request).catch(()=>caches.match(u.pathname)));});`;

export const mobileAssets: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: html },
  "/app.css": { type: "text/css; charset=utf-8", body: css },
  "/app.js": { type: "text/javascript; charset=utf-8", body: mobileScript },
  "/qr-decoder.js": { type: "text/javascript; charset=utf-8", body: mobileQrDecoder },
  "/sw.js": { type: "text/javascript; charset=utf-8", body: sw },
  "/icon.svg": { type: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><image href="${mobileBrandData}" width="512" height="512"/></svg>` },
  "/manifest.webmanifest": { type: "application/manifest+json", body: JSON.stringify({ name: "PI Desktop Mobile", short_name: "PI Mobile", start_url: "/", scope: "/", display: "standalone", background_color: "#181818", theme_color: "#181818", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] }) },
};
