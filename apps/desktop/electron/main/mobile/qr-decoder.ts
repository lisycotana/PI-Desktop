import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Ship the decoder from the locked local package; camera frames never leave the page.
export const mobileQrDecoder = readFileSync(createRequire(import.meta.url).resolve("jsqr"), "utf8");
