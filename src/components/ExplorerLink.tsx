/**
 * ExplorerLink — renders an Arc Testnet explorer link for a tx or address.
 * Never renders without a real hash/address.
 */
import { ExternalLink } from "lucide-react";
import { buildTxExplorerUrl, buildAddressExplorerUrl } from "@/onchain-facts";
import { arcTestnet } from "viem/chains";
import { formatAddr } from "@/lib/format";

const CHAIN_ID = arcTestnet.id;

interface TxLinkProps {
  hash:       string;
  label?:     string;
  className?: string;
}

export function TxLink({ hash, label, className = "" }: TxLinkProps) {
  if (!hash || hash === "0x") return null;
  const url = buildTxExplorerUrl(CHAIN_ID, hash);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-hover)]
                  text-xs transition-colors mono ${className}`}
    >
      {label ?? formatAddr(hash)}
      <ExternalLink size={11} />
    </a>
  );
}

interface AddrLinkProps {
  address:    string;
  label?:     string;
  shorten?:   boolean;
  className?: string;
}

export function AddrLink({ address, label, shorten = true, className = "" }: AddrLinkProps) {
  if (!address || address === "0x") return null;
  const url = buildAddressExplorerUrl(CHAIN_ID, address);
  const display = label ?? (shorten ? formatAddr(address) : address);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-hover)]
                  text-xs transition-colors mono ${className}`}
    >
      {display}
      <ExternalLink size={11} />
    </a>
  );
}
