import "server-only";
import type { InvestigationDataset, ScanParameters, TokenSecuritySnapshot } from "@/domain/investigations/types";
import { readProviderConfiguration, type ProviderConfiguration } from "./config";
import { collectBaseInvestigation } from "./core";
import { createProviderTransport, validateProviderDestination } from "./transport";
import { createDeadline } from "@/lib/deadline";
import { collectTokenMetadata } from "@/providers/token-websites";
import { createSqdFundingQuery } from "./sqd-funding";
import { createGoPlusTokenQuery, emptyGoPlusSnapshot } from "./goplus";
import { goPlusTokenUrl } from "@/domain/investigations/token-security";
import { UpstreamFailure } from "./errors";
import { collectChainAndMetadata } from "./collection-parallel";
import { createAlchemyTransferPageReader } from "./alchemy-transfers";
import { createAlchemyFundingHistoryReader } from "./alchemy-funding";

export interface CollectionOptions { signal?: AbortSignal; onProgress?: (stage: string) => Promise<void> }

export async function collectInvestigationWithConfig(parameters: ScanParameters, configuration: ProviderConfiguration, options: CollectionOptions = {}): Promise<InvestigationDataset> {
  const deadline = createDeadline(configuration.scanTimeoutMs, options.signal ? [options.signal] : []);
  const { signal } = deadline;
  let securitySnapshot: TokenSecuritySnapshot | undefined;
  try {
    signal.throwIfAborted();
    const validatedConfiguration = await validateProviderDestination(configuration, signal);
    signal.throwIfAborted();
    await options.onProgress?.("Checking source-reported token metadata alongside blockchain acquisition");
    signal.throwIfAborted();
    const { dataset, metadata } = await collectChainAndMetadata({ signal,
      collectMetadata: (collectionSignal) => collectTokenMetadata(parameters.token, { signal: collectionSignal }),
      collectDataset: (collectionSignal, tokenMetadata) => {
        const transport = createProviderTransport(validatedConfiguration, collectionSignal);
        const logTransport = validatedConfiguration.logRpcUrl ? createProviderTransport({ ...validatedConfiguration, rpcUrl: validatedConfiguration.logRpcUrl, rpcFallbackUrls: [] }, collectionSignal) : null;
        const alchemyTransport = validatedConfiguration.alchemyRpcUrl ? createProviderTransport({ ...validatedConfiguration, rpcUrl: validatedConfiguration.alchemyRpcUrl, rpcFallbackUrls: [] }, collectionSignal) : null;
        const goPlus = createGoPlusTokenQuery(configuration.timeoutMs, collectionSignal, configuration.goPlusAccessToken);
        return collectBaseInvestigation(parameters, { ...transport,
          ...(alchemyTransport && (configuration.transferSource === "alchemy" || configuration.fundingSource === "alchemy") ? { indexedRpc: alchemyTransport.rpc } : {}),
          ...(configuration.transferSource === "alchemy" && alchemyTransport ? { transferPage: createAlchemyTransferPageReader(alchemyTransport.rpc) } : {}),
          ...(configuration.fundingSource === "alchemy" && alchemyTransport ? { fundingHistory: createAlchemyFundingHistoryReader(alchemyTransport.rpc), creatorFundingHistory: createAlchemyFundingHistoryReader(alchemyTransport.rpc, "outbound"), fundingIndexSource: "alchemy" as const } : {}),
          ...(logTransport ? { logRpc: logTransport.rpc, logRpcSource: logTransport.rpcSource } : {}),
          poolCandidates: async () => {
            const { marketSnapshot } = await tokenMetadata;
            collectionSignal.throwIfAborted();
            return marketSnapshot.status === "reported" && marketSnapshot.pairAddress ? [marketSnapshot.pairAddress] : [];
          },
          ...(!configuration.blockscoutApiKey ? {
            holderProvider: "GoPlus" as const, holderSourceUrl: goPlusTokenUrl, holderIndexIndependentOfRpc: true,
            holderPage: async () => {
              try {
                const data = await goPlus(parameters.token);
                securitySnapshot = data.snapshot;
                return { tokenAddress: parameters.token, items: data.addresses.map((address) => ({ address })), nextCursor: null, complete: false };
              } catch (error) {
                if (error instanceof UpstreamFailure) securitySnapshot = emptyGoPlusSnapshot(parameters.token, "unavailable", new Date().toISOString());
                throw error;
              }
            },
          } : {}),
          ...(configuration.fundingSource === "sqd-public-testing" ? { sqdFundingPage: createSqdFundingQuery(configuration.timeoutMs, collectionSignal) } : {}),
          limits: configuration.limits, signal: collectionSignal, onProgress: options.onProgress });
      },
    });
    signal.throwIfAborted();
    return { ...dataset, token: { ...dataset.token, ...metadata, ...(securitySnapshot ? { securitySnapshot } : {}) } };
  } finally { deadline.dispose(); }
}

export async function collectInvestigation(parameters: ScanParameters, options: CollectionOptions = {}): Promise<InvestigationDataset> {
  return collectInvestigationWithConfig(parameters, readProviderConfiguration(), options);
}
