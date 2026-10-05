import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createContext, Script } from "node:vm";
import QRCode from "qrcode";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { mobileAssets } = await import("../electron/main/mobile/web-assets.ts");

test("the shipped browser decoder reads an ordinary website pairing QR without BarcodeDetector", () => {
  const payload = "https://desktop.example.ts.net/#" + new URLSearchParams({pair:"fixture-one-use-code",expires:"2026-10-04T08:00:00Z"});
  const qr = QRCode.create(payload,{errorCorrectionLevel:"M"});
  const width = (qr.modules.size + 8) * 5;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / 5) - 4; const col = Math.floor(x / 5) - 4;
    const black = row >= 0 && col >= 0 && row < qr.modules.size && col < qr.modules.size && qr.modules.get(row,col);
    const index = (y * width + x) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = black ? 0 : 255; pixels[index + 3] = 255;
  }
  const browser = createContext({});
  new Script(mobileAssets["/qr-decoder.js"].body).runInContext(browser);
  assert.equal(browser.jsQR(pixels,width,width).data,payload);
  assert.match(mobileAssets["/"].body,/src="\/qr-decoder.js"/);
  assert.doesNotMatch(mobileAssets["/app.js"].body,/BarcodeDetector/);
});
