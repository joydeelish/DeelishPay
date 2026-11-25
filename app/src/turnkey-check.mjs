
import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";

const required = [
  "TURNKEY_ORGANIZATION_ID",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_SIGN_WITH",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is missing`);
  }
}

const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
  apiPrivateKey: process.env.TURNKEY_AGENT_API_PRIVATE_KEY,
apiPublicKey: process.env.TURNKEY_AGENT_API_PUBLIC_KEY,
});

const account = await createAccount({
  client: turnkeyClient.apiClient(),
  organizationId: process.env.TURNKEY_ORGANIZATION_ID,
  signWith: process.env.TURNKEY_SIGN_WITH,
});

console.log("DeelishPay Turnkey connection successful!");
console.log("Agent address:", account.address);
