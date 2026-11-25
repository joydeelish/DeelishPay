
import {
  buildPrivatePaymentWithReceipt,
  artifactProver,
  circuitArtifactFiles,
} from "@gloamtrade/sdk";

/**
 * Build a private payment for a Gloam receive tag.
 * This does not submit a transaction.
 */
export async function preparePrivatePayment({
  net,
  note,
  path,
  amountWei,
  recipientTag,
}) {
  if (!note?.secret || !note?.amountWei || !note?.asset) {
    throw new Error("Funding note is incomplete.");
  }

  if (!path) {
    throw new Error("Missing note membership path.");
  }

  if (BigInt(amountWei) <= 0n) {
    throw new Error("Payment amount must be above zero.");
  }

  const payment = await buildPrivatePaymentWithReceipt({
    payTo: recipientTag,
    chainId: net.chainId,
    poolAddress: net.pool,
    asset: note.asset,
    amountWei: BigInt(amountWei),

    from: {
      secretHex: note.secret,
      amountWei: BigInt(note.amountWei),
      path,
    },

    prove: artifactProver(
      circuitArtifactFiles("transfer", net.chainId)
    ),

    receipt: {
      verifier: "deelishpay",
      reveal: false,
    },
  });

  return {
    intent: payment.intent,
    paymentNote: payment.paymentNote,
    changeNote: payment.changeNote,
    sealedTicket: payment.sealedTicket,
    memo: payment.memo,
  };
}
