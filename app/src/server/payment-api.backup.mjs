import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPublicClient, http, parseUnits, stringToHex } from "viem";

import {
  mainnetNetwork,
  syncTree,
  buildPrivatePaymentWithReceipt,
  artifactProver,

  relayIntent,
  relayMemo,
} from "@gloamtrade/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

const transferArtifacts = {
  wasm: path.resolve(here, "../../transfer.wasm"),
  zkey: path.resolve(here, "../../final/transfer_final.zkey"),
};
const app = express();
app.use(express.json());

const net = mainnetNetwork("robinhood");
if (!net) throw new Error("Robinhood mainnet unavailable");

const recipient = process.env.DEELISHPAY_RECIPIENT_TAG;
if (!recipient) throw new Error("Missing DEELISHPAY_RECIPIENT_TAG");

const notesDir = path.resolve("notes");
const pendingDir = path.resolve("private-pending");
await fs.mkdir(pendingDir, { recursive: true });

const client = createPublicClient({
  chain: net.chain,
  transport: http(net.rpcUrl),
});

const pending = new Map();
let busy = false;

async function getFundingNote() {
  const files = (await fs.readdir(notesDir))
    .filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const fullPath = path.join(notesDir, file);
    const note = JSON.parse(await fs.readFile(fullPath, "utf8"));

    if (note.secret && note.commitment && note.amountWei && note.asset) {
      return { note, fullPath };
    }
  }

  throw new Error("No spendable note found.");
}

app.post("/api/payment/prepare", async (req, res) => {
  if (pending.size > 0 || busy) {
  return res.status(409).json({
    error: "A payment is already awaiting confirmation."
  });
}
  try {
    if (busy) {
      return res.status(409).json({ error: "A payment is already being processed." });
    }

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 0.1) {
      return res.status(400).json({
        error: "For this first test, enter an amount up to 0.1 USDG."
      });
    }

    const { note, fullPath } = await getFundingNote();
    const amountWei = parseUnits(String(amount), 6);

    if (amountWei >= BigInt(note.amountWei)) {
      return res.status(400).json({ error: "Insufficient note balance." });
    }

    const synced = await syncTree(client, {
      pool: net.pool,
      fromBlock: net.deployBlock,
    });

    const merklePath = await synced.pathForCommitment(note.commitment);
    if (!merklePath) {
      return res.status(400).json({
        error: "Could not find the note in the current Gloam tree."
      });
    }

    const payment = await buildPrivatePaymentWithReceipt({
      payTo: recipient,
      chainId: net.chainId,
      poolAddress: net.pool,
      asset: note.asset,
      amountWei,
      from: {
        secretHex: note.secret,
        amountWei: BigInt(note.amountWei),
        path: merklePath,
      },
            prove: artifactProver(transferArtifacts),

      receipt: {
        verifier: "deelishpay",
        reveal: false,
      },
    });
    const reviewId = randomUUID();

    pending.set(reviewId, {
      payment,
      sourcePath: fullPath,
      amountWei,
    });

    res.json({
      reviewId,
      amount,
      recipient: "Your personal Gloam wallet",
    });
  } catch (error) {
    console.error("Payment preparation error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/payment/confirm", async (req, res) => {
  const reviewId = req.body.reviewId;
  const item = pending.get(reviewId);

  if (!item) {
    return res.status(404).json({ error: "Payment review expired. Prepare it again." });
  }

  if (busy) {
    return res.status(409).json({ error: "Another payment is processing." });
  }

  busy = true;
  pending.delete(reviewId);

  try {
    const { payment, sourcePath } = item;

    const change = {
      ...payment.changeNote,
      amountWei: payment.changeNote.amountWei.toString(),
    };

    const changePath = path.join(
      notesDir,
      `${payment.changeNote.commitment}.json`
    );

    // Persist recovery information before submitting.
    await fs.writeFile(
      changePath,
      JSON.stringify(change, null, 2),
      { mode: 0o600, flag: "wx" }
    );

    const recoveryPath = path.join(
      pendingDir,
      `${reviewId}.json`
    );

    await fs.writeFile(
      recoveryPath,
      JSON.stringify({
        sealedTicket: payment.sealedTicket,
        paymentCommitment: payment.paymentNote.commitment,
        changePath,
        sourcePath,
        status: "submitting",
      }),
      { mode: 0o600, flag: "wx" }
    );

    const txHash = await relayIntent(payment.intent);

    const receipt = await client.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== "success") {
      throw new Error("Gloam transfer transaction reverted.");
    }

    // Publish the encrypted ticket only after the transfer lands.
    await relayMemo({
      chainId: net.chainId,
      paymentCommitment: payment.paymentNote.commitment,
      memo: stringToHex(payment.sealedTicket),
    });

    // The original note has now been spent.
    await fs.rename(
      sourcePath,
      `${sourcePath}.spent`
    );

    await fs.unlink(recoveryPath);

    res.json({
      success: true,
      txHash,
      message: "Private payment confirmed and memo published.",
    });
  } catch (error) {
    console.error("Payment execution error:", error);
    res.status(500).json({
      error: "Payment may need recovery. Do not retry or spend either note until its status is checked.",
    });
  } finally {
    busy = false;
  }
});

app.listen(3001, "0.0.0.0", () => {
  console.log("DeelishPay payment API listening on port 3001");
});
