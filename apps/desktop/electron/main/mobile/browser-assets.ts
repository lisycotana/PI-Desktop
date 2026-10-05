import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { mobileAssets } from "./web-assets";

export type BrowserAssets = Record<string, { type: string; body: string | Buffer; gzip?: Buffer }>;
const types: Record<string,string> = {".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8",".svg":"image/svg+xml",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".png":"image/png",".jpg":"image/jpeg",".wasm":"application/wasm"};

/** Read the immutable build once. Requests only select exact entries from this map. */
export async function loadBrowserAssets(root: string): Promise<BrowserAssets> {
  const assets: BrowserAssets = {"/icon.svg":mobileAssets["/icon.svg"],"/manifest.webmanifest":mobileAssets["/manifest.webmanifest"]};
  async function walk(directory:string,prefix:string) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);const key=prefix+"/"+entry.name;
      if(entry.isDirectory())await walk(path,key);
      else if(entry.isFile())assets[key==="/mobile.html"?"/":key]={type:types[extname(entry.name)]||"application/octet-stream",body:await readFile(path)};
    }
  }
  await walk(root,"");
  if(!assets["/"])throw new Error("Mobile browser build is missing");
  // Browser assets are cached by their Vite content hashes. API data is never cached.
  assets["/sw.js"]={type:"text/javascript; charset=utf-8",body:'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("pi-mobile-shell-")).map(k=>caches.delete(k))))])));'};
  for(const asset of Object.values(assets)) {
    if(asset.type.startsWith("text/")||asset.type==="image/svg+xml")asset.gzip=gzipSync(asset.body);
  }
  return assets;
}
