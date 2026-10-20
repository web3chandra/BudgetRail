/** Build explorer URLs for Arc chains. */
export function buildTxExplorerUrl(chainId: number, txHash: string): string {
  const base =
    chainId === 5042002
      ? "https://explorer.testnet.arc.io"
      : chainId === 5042
      ? "https://explorer.arc.io"
      : null;
  return base ? `${base}/tx/${txHash}` : `chain:${chainId}/tx/${txHash}`;
}
