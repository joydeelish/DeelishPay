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

async function saveRecovery(filePath, data) {
  const tempPath = `${filePath}.tmp`;

  await fs.writeFile(
    tempPath,
    JSON.stringify(data, null, 2),
    { mode: 0o600 }
  );

  await fs.rename(tempPath, filePath);
}
async function getFundingNote() {
  const files = (await fs.readdir(notesDir))
    .filter((file) => file.endsWith(".json"));

  for (const file of files) {
    const fullPath = path.join(notesDir, file);

    const note = JSON.parse(
      await fs.readFile(fullPath, "utf8")
    );

    if (
      note.secret &&
      note.commitment &&
      note.amountWei &&
      note.asset
    ) {
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
  const { reviewId } = req.body;

  if (!/^[0-9a-f-]{36}$/i.test(reviewId || "")) {
    return res.status(400).json({ error: "Invalid review ID." });
  }

  const item = pending.get(reviewId);

  if (!item) {
    return res.status(404).json({
      error: "Payment review expired. Check recovery records before preparing again."
    });
  }

  if (busy) {
    return res.status(409).json({ error: "Another payment is processing." });
  }

  busy = true;
  pending.delete(reviewId);

  const recoveryPath = path.join(pendingDir, `${reviewId}.json`);

  try {
    const { payment, sourcePath } = item;

    const recovery = {
      status: "submitting",
      sourcePath,
      txHash: null,
      sealedTicket: payment.sealedTicket,
      paymentCommitment: payment.paymentNote.commitment,
      change: {
        ...payment.changeNote,
        amountWei: payment.changeNote.amountWei.toString(),
      },
    };

    // Persist before contacting the relay.
    await saveRecovery(recoveryPath, recovery);

    let txHash;

    try {
      txHash = await relayIntent(payment.intent);
    } catch (error) {
      recovery.status = "submission_unknown";
      recovery.error = error.message;
      await saveRecovery(recoveryPath, recovery);
      throw new Error(
        "Relay submission is uncertain. Do not submit this payment again."
      );
    }

    // Save the hash immediately.
    recovery.txHash = txHash;
    recovery.status = "submitted";
    await saveRecovery(recoveryPath, recovery);

    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      recovery.status = "reverted";
      await saveRecovery(recoveryPath, recovery);

      throw new Error("The transfer transaction reverted.");
    }

    recovery.status = "transfer_confirmed";
    await saveRecovery(recoveryPath, recovery);

    // Create the change note only after transfer confirmation.
    const changePath = path.join(
      notesDir,
      `${payment.changeNote.commitment}.json`
    );

    await fs.writeFile(
      changePath,
      JSON.stringify(recovery.change, null, 2),
      { mode: 0o600, flag: "wx" }
    );

    recovery.status = "memo_pending";
    await saveRecovery(recoveryPath, recovery);

    // Publish encrypted recipient memo.
    await relayMemo({
      chainId: net.chainId,
      paymentCommitment: payment.paymentNote.commitment,
      memo: stringToHex(payment.sealedTicket),
    });

    recovery.status = "memo_published";
    await saveRecovery(recoveryPath, recovery);

    await fs.rename(sourcePath, `${sourcePath}.spent`);
    await fs.unlink(recoveryPath);

    return res.json({
      success: true,
      txHash,
      message: "Private payment confirmed and memo published.",
    });

  } catch (error) {
    console.error("Payment execution error:", error);

    return res.status(500).json({
      error: error.message,
      message: "Do not retry the payment until its recovery status is checked.",
    });

  } finally {
    busy = false;
  }
});
app.post("/api/payment/recover/:reviewId", async (req, res) => {
  if (busy) {
    return res.status(409).json({ error: "Another payment is processing." });
  }

  const { reviewId } = req.params;

  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) {
    return res.status(400).json({ error: "Invalid review ID." });
  }

  busy = true;

  const recoveryPath = path.join(pendingDir, `${reviewId}.json`);

  try {
    const recovery = JSON.parse(
      await fs.readFile(recoveryPath, "utf8")
    );

    if (!recovery.txHash ||
        !["memo_pending", "transfer_confirmed"].includes(recovery.status)) {
      return res.status(409).json({
        error: "This payment is not ready for memo recovery."
      });
    }

    const receipt = await client.waitForTransactionReceipt({
      hash: recovery.txHash,
    });

    if (receipt.status !== "success") {
      return res.status(409).json({
        error: "Transfer has not been confirmed successfully."
      });
    }

    const changePath = path.join(
      notesDir,
      `${recovery.change.commitment}.json`
    );

    try {
      await fs.writeFile(
        changePath,
        JSON.stringify(recovery.change, null, 2),
        { mode: 0o600, flag: "wx" }
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    await relayMemo({
      chainId: net.chainId,
      paymentCommitment: recovery.paymentCommitment,
      memo: stringToHex(recovery.sealedTicket),
    });

    recovery.status = "memo_published";
    await saveRecovery(recoveryPath, recovery);

    await fs.rename(
      recovery.sourcePath,
      `${recovery.sourcePath}.spent`
    );

    await fs.unlink(recoveryPath);

    return res.json({
      success: true,
      txHash: recovery.txHash,
      message: "Memo recovered and published.",
    });

  } catch (error) {
    console.error("Recovery error:", error);

    return res.status(500).json({
      error: "Recovery incomplete. Keep the recovery record and do not resend."
    });

    } finally {
    busy = false;
  }
});

app.listen(3001, "0.0.0.0", () => {
  console.log("DeelishPay payment API listening on port 3001");
});