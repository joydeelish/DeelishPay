import { generateReceiveKey } from "@gloamtrade/sdk";
import { writeFileSync } from "node:fs";

const key = await generateReceiveKey();

writeFileSync(
  "src/server/receive-key.json",
  JSON.stringify(key),
  { mode: 0o600 }
);

console.log("New DeelishPay tag:", key.tag);
console.log("Private key saved locally.");