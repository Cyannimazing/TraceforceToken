/** Network capabilities are explicit. Adding a chain requires its own verified
 * acquisition adapter; an EVM address alone never implies support. */
export const investigationNetworks = {
  base: { slug: "base", name: "Base", chainId: 8453, family: "evm", explorer: "https://basescan.org", enabled: true },
} as const;

export type InvestigationNetwork = keyof typeof investigationNetworks;

export function resolveInvestigationNetwork(value: string = "base") {
  if (!Object.hasOwn(investigationNetworks, value)) throw new Error("This network does not have an enabled investigation adapter.");
  return investigationNetworks[value as InvestigationNetwork];
}

export interface NetworkAcquisitionAdapter<TParameters, TDataset, TOptions> {
  network: InvestigationNetwork;
  collect(parameters: TParameters, options: TOptions): Promise<TDataset>;
}
