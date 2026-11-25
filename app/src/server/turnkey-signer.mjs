
import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import { createWalletClient, createPublicClient, http } from "viem";
import { mainnetNetwork } from "@gloamtrade/sdk";

const required = [
  "TURNKEY_ORGANIZATION_ID",
  "TURNKEY_AGENT_API_PUBLIC_KEY",
  "TURNKEY_AGENT_API_PRIVATE_KEY",
  "TURNKEY_SIGN_WITH",
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

const turnkey = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.TURNKEY_AGENT_API_PUBLIC_KEY,
  apiPrivateKey: process.env.TURNKEY_AGENT_API_PRIVATE_KEY,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
});

const account = await createAccount({
  client: turnkey.apiClient(),
  organizationId: process.env.TURNKEY_ORGANIZATION_ID,
  signWith: process.env.TURNKEY_SIGN_WITH,
});

if (
  account.address.toLowerCase() !==
  process.env.TURNKEY_SIGN_WITH.toLowerCase()
) {
  throw new Error("Turnkey wallet address mismatch!");
}

const network = mainnetNetwork("robinhood");
if (!network) throw new Error("Robinhood mainnet unavailable");

const wallet = createWalletClient({
  account,
  chain: network.chain,
  transport: http(network.rpcUrl),
});

const publicClient = createPublicClient({
  chain: network.chain,
  transport: http(network.rpcUrl),
});

console.log("Turnkey signer connected!");
console.log("Wallet:", wallet.account.address);
console.log("Network:", network.label);
console.log("Chain ID:", await publicClient.getChainId());
console.log("Transaction sent: NO");
export { wallet, publicClient, network };