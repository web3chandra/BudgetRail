/**
 * USDCBalance — reads the ERC-20 USDC balance for an address.
 *
 * On Arc: native balance IS USDC at 18 decimals (gas view).
 * ERC-20 balanceOf IS USDC at 6 decimals (display view).
 * We show ONLY the ERC-20 view. Never sum or display both.
 */
import { useReadContract } from "wagmi";
import { erc20Abi } from "viem";
import { arcTestnet } from "viem/chains";
import { getUsdc } from "@/onchain-facts";
import { formatUsdcShort } from "@/lib/format";
import { TokenUSDC } from "@web3icons/react";

const CHAIN_ID = arcTestnet.id;
const USDC     = getUsdc(CHAIN_ID)!;

interface USDCBalanceProps {
  address: `0x${string}`;
  label?:  string;
  className?: string;
}

export function USDCBalance({ address, label = "Balance", className = "" }: USDCBalanceProps) {
  const { data, isLoading, error } = useReadContract({
    address: USDC.address,
    abi:     erc20Abi,
    functionName: "balanceOf",
    args:    [address],
    chainId: CHAIN_ID,
    query:   { refetchInterval: 15_000 },
  });

  const display = isLoading
    ? "..."
    : error
    ? "—"
    : formatUsdcShort(data as bigint ?? 0n);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <TokenUSDC variant="branded" size={16} />
      <span className="text-[var(--subtle)] text-xs">{label}</span>
      <span className="tabular font-semibold text-sm text-[var(--ink)]">{display}</span>
    </div>
  );
}
