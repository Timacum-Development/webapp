import { createModule, mutation, action } from "vuex-class-component";
import {
  ProposedFromTransaction,
  ProposedToTransaction,
  ProposedConvertTransaction,
  LiquidityParams,
  OpposingLiquidParams,
  OpposingLiquid,
  TradingModule,
  LiquidityModule,
  BaseToken,
  CreatePoolModule,
  CreatePoolParams,
  ModalChoice,
  ViewToken,
  ViewRelay,
  TokenPrice,
  Section,
  Step,
  HistoryModule,
  ViewAmount,
  ModuleParam,
  ConvertReturn,
  UserPoolBalances,
  ReserveFeed,
  PoolTokenPosition,
  CreateV1PoolEthParams,
  TxResponse,
  V1PoolResponse,
  ViewTradeEvent,
  ViewLiquidityEvent,
  ViewRemoveEvent,
  ViewAddEvent,
  ViewAmountWithMeta,
  FocusPoolRes,
  ProtectedLiquidity,
  ProtectedLiquidityCalculated,
  ProtectLiquidityParams,
  OnUpdate,
  ViewProtectedLiquidity,
  ViewLockedBalance,
  ProtectionRes,
  ViewAmountDetail,
  WeiExtendedAsset
} from "@/types/bancor";
import { ethBancorApi } from "@/api/bancorApiWrapper";
import {
  web3,
  Relay,
  Token,
  fetchReserveBalance,
  compareString,
  findOrThrow,
  updateArray,
  networkTokens,
  isOdd,
  multiSteps,
  EthNetworks,
  PoolType,
  Anchor,
  TraditionalRelay,
  ChainLinkRelay,
  SmartToken,
  PoolContainer,
  sortAlongSide,
  RelayWithReserveBalances,
  sortByLiqDepth,
  matchReserveFeed,
  zeroAddress,
  buildSingleUnitCosts,
  findChangedReserve,
  getLogs,
  DecodedEvent,
  ConversionEventDecoded,
  getConverterLogs,
  DecodedTimedEvent,
  AddLiquidityEvent,
  RemoveLiquidityEvent,
  bancorSubgraph,
  chainlinkSubgraph,
  traverseLockedBalances,
  calculateProtectionLevel,
  LockedBalance,
  rewindBlocksByDays
} from "@/api/helpers";
import { ContractSendMethod } from "web3-eth-contract";
import {
  ABIContractRegistry,
  ethErc20WrapperContract,
  ethReserveAddress
} from "@/api/eth/ethAbis";
import {
  getApprovedBalanceWei,
  getReturnByPath,
  liquidationLimit,
  getConvertersByAnchors,
  getAnchors,
  getConvertibleTokenAnchors,
  conversionPath,
  getTokenSupplyWei,
  existingPool,
  protectionById,
  getRemoveLiquidityReturn
} from "@/api/eth/contractWrappers";
import { toWei, fromWei, toHex, asciiToHex } from "web3-utils";
import Decimal from "decimal.js";
import axios, { AxiosResponse } from "axios";
import { vxm } from "@/store";
import wait from "waait";
import {
  uniqWith,
  differenceWith,
  zip,
  partition,
  first,
  omit,
  toPairs,
  fromPairs,
  chunk,
  last
} from "lodash";
import {
  buildNetworkContract,
  buildRegistryContract,
  buildV28ConverterContract,
  buildV2Converter,
  buildContainerContract,
  buildConverterContract,
  buildTokenContract,
  buildLiquidityProtectionContract,
  buildLiquidityProtectionStoreContract
} from "@/api/eth/contractTypes";
import {
  MinimalRelay,
  expandToken,
  generateEthPath,
  shrinkToken,
  TokenSymbol,
  removeLeadingZeros,
  calculateHistoricPoolBalanceByConversions
} from "@/api/eth/helpers";
import { ethBancorApiDictionary } from "@/api/eth/bancorApiRelayDictionary";
import { getSmartTokenHistory, fetchSmartTokens } from "@/api/eth/zumZoom";
import { sortByNetworkTokens } from "@/api/sortByNetworkTokens";
import { findNewPath } from "@/api/eos/eosBancorCalc";
import { priorityEthPools } from "./staticRelays";
import BigNumber from "bignumber.js";
import { knownVersions } from "@/api/eth/knownConverterVersions";
import { MultiCall, ShapeWithLabel, DataTypes } from "eth-multicall";
import moment from "moment";
import { getNetworkVariables } from "../../config";

const samePoolAmount = (liq1Balance: string, liq2Balance: string) => {
  const liq1 = new BigNumber(liq1Balance);
  const liq2 = new BigNumber(liq2Balance);

  const first = liq1.isLessThanOrEqualTo(liq2.plus(1));
  const second = liq2.isLessThanOrEqualTo(liq1.plus(1));

  const passed = first && second;
  return passed;
};

const samePointOfEntry = (a: ProtectedLiquidity, b: ProtectedLiquidity) =>
  compareString(a.poolToken, b.poolToken) &&
  a.timestamp == b.timestamp &&
  compareString(a.owner, b.owner) &&
  samePoolAmount(a.poolAmount, b.poolAmount);

// returns the rate of 1 pool token in reserve token units
const calculatePoolTokenRate = (
  poolTokenSupply: string,
  reserveTokenBalance: string
) => new BigNumber(reserveTokenBalance).times(2).div(poolTokenSupply);

const daysAsSeconds = (days: number): number =>
  moment.duration(days, "days").asSeconds();
const thirtyDaysInSeconds = daysAsSeconds(30);
const oneHundredDaysInSeconds = daysAsSeconds(100);

const get_volumes = async (converter: string) =>
  bancorSubgraph(`
{
  converter(id:"${converter}") {
    id
    activated
    volumes {
      token { 
        symbol
        id
      }
      sellVolume
      buyVolume
      totalVolume
    }
    createdAtTimestamp
  }
}
`);

const secondsInADay = 60 * 60 * 24;
const timestamp_days_ago = (days: number) =>
  moment().unix() - days * secondsInADay;

const get_exchange_snapshots = async (
  exchange: string,
  blockNumbers: [string, string][]
) => {
  const requests = blockNumbers.map(
    ([label, number]) => `
    
    ${label}:converter(
      id:"${exchange}"
      block:{
        number: ${number}
      }
    ) {
      id
      volumes {
        token { id }
        totalVolume
      }
    }
  
  `
  );

  const around = ["{", ...requests, "}"];

  const requestString = around.join("");
  console.log(requests, requestString, "goop");

  try {
    const res = await bancorSubgraph(requestString);

    console.log(res, "came back in sub graph");
    return res;
  } catch (e) {
    console.log("failed", e);
  }
};

const get_exchange_snapshot_volume = async (
  exchange: string,
  blockNumber: string
) =>
  bancorSubgraph(`
{
  before:converter(
    id:"${exchange}"
    block:{
      number: ${blockNumber}
    }
  ) {
    id
    volumes {
      token { symbol }
      totalVolume
    }
  }
  afterr:converter(
    id:"${exchange}"
  ) {
    id
    volumes {
      token { symbol }
      totalVolume
    }
  }
}
`);

const getVolumeStats = async (blockNumbers: string[]) => {
  const labelAndBlocks = blockNumbers.map(
    number => [`a${number}`, number] as [string, string]
  );

  interface VolumeRes {
    converters: Converter[];
  }

  interface Converter {
    anchor: string;
    id: string;
    volumes: Volume[];
    balances: Balance[];
  }

  interface Balance {
    token: Token;
    stakedAmount: string;
    balance: string;
    weight: string;
  }

  interface Volume {
    token: Token;
    totalVolume: string;
  }

  interface Token {
    id: string;
  }

  const requests = labelAndBlocks.map(
    ([label, block]) => `
  
    ${label}:converters(block: { number: ${block} }, orderBy: createdAtBlockNumber, orderDirection: desc) {
      id
      anchor
      volumes {
        token {
          id
        }
        totalVolume
      }
      balances {
        token {
          id
        }
        stakedAmount
        balance
        weight
      }
    }
  `
  );
  const finalRequest = ["{", ...requests, "}"].join("");

  const res = await bancorSubgraph(finalRequest);

  return toPairs(res).map(
    ([block, converters]) =>
      [block.slice(1), converters] as [string, Converter[]]
  );
};

const bntToken = "0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c";

const usdPriceOfEth = async (blockNumbers: string[]) => {
  interface ChainkLinkRes {
    assetPair: AssetPair;
    latestHourlyCandle: LatestHourlyCandle;
  }

  enum AssetPair {
    EthUsd = "ETH/USD"
  }

  interface LatestHourlyCandle {
    medianPrice: string;
  }

  const labelAndBlocks = blockNumbers.map(
    number => [`a${number}`, number] as [string, string]
  );

  const requests = labelAndBlocks.map(
    ([label, block]) => `

    ${label}:priceFeed(block:{number:${block}} id: "0xf79d6afbb6da890132f9d7c355e3015f15f3406f") {
      assetPair
      latestHourlyCandle {
        medianPrice
      }
    }

  `
  );

  const finalRequest = ["{", ...requests, "}"].join("");
  const res = await chainlinkSubgraph(finalRequest);
  const arrRes = toPairs(res).filter(([_, data]) => data) as [
    string,
    ChainkLinkRes
  ][];

  const medianPriceToDec = (medianPrice: string) =>
    new BigNumber(medianPrice).dividedBy(100000000).toNumber();
  const data = arrRes.map(
    ([blockLabel, data]) =>
      [blockLabel.slice(1), data] as [string, ChainkLinkRes]
  );

  const prices = data.map(
    ([blockNumber, data]) =>
      [blockNumber, medianPriceToDec(data.latestHourlyCandle.medianPrice)] as [
        string,
        number
      ]
  );
  return prices as [string, number][];
};

const converterBalances = async (skip: number = 0) => {
  console.log("converterBalances", "skipping", skip);

  interface Data {
    converterBalances: ConverterBalance[];
  }

  interface ConverterBalance {
    balance: string;
    converter: Converter;
    id: string;
    poolToken: PoolToken | null;
    stakedAmount: string;
    token: Token;
    weight: string;
  }

  interface Converter {
    activated: boolean;
    anchor: string;
    createdAtBlockNumber: string;
    id: string;
    type: string;
  }

  interface PoolToken {
    id: string;
    supply: string;
    symbol: string;
  }

  interface Token {
    symbol: string;
  }

  const res = (await bancorSubgraph(`
{
  converterBalances(skip: ${skip}) {
    id
    converter {
      id
      anchor
      activated
      createdAtBlockNumber
      type
    }
    poolToken {
      id
      symbol
      supply
    }
    token {
      symbol
    }
    stakedAmount
    balance
    weight
  }
}


`)) as Data;

  return res;
};

const getPool = async (anchorId: string) => {
  const res = await bancorSubgraph(`
    
    {
      converters(
        where: {anchor: "${anchorId}"}, 
      ) {
        id
        anchor
      }
    }
    
  `);

  return res;
};
const totalBntVolumeAtBlocks = async (blocks: string[]) => {
  const [usdPrices, res] = await Promise.all([
    usdPriceOfEth(blocks),
    getVolumeStats(blocks)
  ]);

  console.log(res, "duprew");
  // For every block
  // Get the BNT/ETH anchor
  // Work out the price of BNT in ETH tokens
  // Times that by the price of ETH to work out the USD price of BNT
  // Return an array of [block, usdPriceOfBnt]

  const xx = res.map(([blockNumber, converters]) => [
    blockNumber,
    converters.filter(converter =>
      converter.balances.some(balance =>
        compareString(
          balance.token.id,
          "0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c"
        )
      )
    )
  ]);

  const totalVolumeAtBlock = res.map(([block, converters]) => {
    const uniqueAnchors = uniqWith(
      converters.map(converter => converter.anchor),
      compareString
    );
    const groupedByAnchors = uniqueAnchors.map(anchor => ({
      anchor,
      converters: converters
        .filter(converter => compareString(converter.anchor, anchor))
        .map(obj => omit(obj, "anchor"))
    }));

    const volumes = groupedByAnchors.map(group =>
      group.converters.flatMap(converter =>
        converter.volumes.find(volume =>
          compareString(volume.token.id, bntToken)
        )
      )
    );

    const liquidity = groupedByAnchors.map(group =>
      group.converters.flatMap(converter =>
        converter.balances.find(volume =>
          compareString(volume.token.id, bntToken)
        )
      )
    );

    const filteredLiquidity = liquidity
      .filter(vol => vol && vol.length > 0)
      .map(vol => vol.filter(Boolean))
      .filter(vol => vol && vol.length > 0)
      .map(vol => vol!.map(con => con!.balance))
      .map(vol =>
        vol.reduce((acc, item) => new BigNumber(item).plus(acc).toString())
      );

    const totalLiquidity =
      filteredLiquidity.length > 0
        ? filteredLiquidity.reduce((acc, item) =>
            new BigNumber(item).plus(acc).toString()
          )
        : "0";

    const filteredVolumes = volumes
      .filter(vol => vol && vol.length > 0)
      .map(vol => vol.filter(Boolean))
      .filter(vol => vol && vol.length > 0)
      .map(vol => vol!.map(con => con!.totalVolume))
      .map(vol =>
        vol.reduce((acc, item) => new BigNumber(item).plus(acc).toString())
      );

    const totalVolume =
      filteredVolumes.length > 0
        ? filteredVolumes.reduce((acc, item) =>
            new BigNumber(item).plus(acc).toString()
          )
        : "0";
    return [block, totalVolume, totalLiquidity] as VolumeAndLiq;
  });

  const blockSummaries = totalVolumeAtBlock.sort((a, b) =>
    new BigNumber(b[1]).minus(a[1]).toNumber()
  );
  return blockSummaries;
};

const notBadRelay = (converterAndAnchor: ConverterAndAnchor) =>
  !compareString(
    converterAndAnchor.anchorAddress,
    "0x368B3D50E51e8bf62E6C73fc389e4102B9aEB8e2"
  );

const decodedToTimedDecoded = <T>(
  event: DecodedEvent<T>,
  knownBlockNumber: number,
  knownBlockNumberTime: number
): DecodedTimedEvent<T> => ({
  ...event,
  blockTime: estimateBlockTimeUnix(
    Number(event.blockNumber),
    knownBlockNumber,
    knownBlockNumberTime
  )
});

const tokenAddressesInEvent = (
  event:
    | DecodedEvent<ConversionEventDecoded>
    | DecodedEvent<AddLiquidityEvent>
    | DecodedEvent<RemoveLiquidityEvent>
): string[] => {
  if (Object.keys(event.data).includes("from")) {
    const actualEvent = event as DecodedEvent<ConversionEventDecoded>;
    const res = [actualEvent.data.from.address, actualEvent.data.to.address];
    const isArrayOfStrings = res.every(address => typeof address == "string");
    if (!isArrayOfStrings)
      throw new Error("Failed to get token addresses in event");
    return res;
  } else if (Object.keys(event.data).includes("tokenAdded")) {
    const actualEvent = event as DecodedEvent<AddLiquidityEvent>;
    return [actualEvent.data.tokenAdded];
  } else if (Object.keys(event.data).includes("tokenRemoved")) {
    const actualEvent = event as DecodedEvent<RemoveLiquidityEvent>;
    return [actualEvent.data.tokenRemoved];
  } else {
    throw new Error("Failed to find token");
  }
};

const estimateBlockTimeUnix = (
  blockNumber: number,
  knownBlockNumber: number,
  knownBlockNumberTime: number,
  averageBlockTimeSeconds = 13
): number => {
  if (knownBlockNumber < blockNumber)
    throw new Error("Write more maths to support this");
  const blockGap = knownBlockNumber - blockNumber;
  const timeGap = blockGap * averageBlockTimeSeconds;
  return knownBlockNumberTime - timeGap;
};

const addLiquidityEventToView = (
  addLiquidity: DecodedTimedEvent<AddLiquidityEvent>[],
  tokens: ViewToken[],
  createBlockExplorerTxLink: (hash: string) => string,
  createBlockExplorerAccountLink: (account: string) => string
): ViewLiquidityEvent<ViewAddEvent> => {
  const firstItem = first(addLiquidity)!;
  const account = firstItem.data.trader;

  return {
    account,
    type: "add",
    accountLink: createBlockExplorerAccountLink(account),
    data: {
      tokensAdded: addLiquidity.map(event => {
        const token = findOrThrow(tokens, token =>
          compareString(token.contract, event.data.tokenAdded)
        );
        const decAmount = shrinkToken(event.data.amount, token.precision);
        return viewTokenToViewAmountWithMeta(decAmount, token);
      })
    },
    txHash: firstItem.txHash,
    txLink: createBlockExplorerTxLink(firstItem.txHash),
    unixTime: firstItem.blockTime,
    valueTransmitted: 0
  };
};

const viewTokenToViewAmountWithMeta = (
  amount: string,
  token: ViewToken
): ViewAmountWithMeta => ({
  amount: amount,
  decimals: token.precision,
  id: token.id,
  logo: token.logo,
  symbol: token.symbol
});

const removeLiquidityEventToView = (
  removeLiquidity: DecodedTimedEvent<RemoveLiquidityEvent>[],
  tokens: ViewToken[],
  createBlockExplorerTxLink: (hash: string) => string,
  createBlockExplorerAccountLink: (account: string) => string
): ViewLiquidityEvent<ViewRemoveEvent> => {
  const firstItem = first(removeLiquidity)!;
  const account = firstItem.data.trader;

  return {
    account,
    type: "remove",
    accountLink: createBlockExplorerAccountLink(account),
    data: {
      tokensRemoved: removeLiquidity.map(event => {
        const token = findOrThrow(tokens, token =>
          compareString(token.id, event.data.tokenRemoved)
        );
        const decAmount = shrinkToken(event.data.amount, token.precision);
        return viewTokenToViewAmountWithMeta(decAmount, token);
      })
    },
    txHash: firstItem.txHash,
    txLink: createBlockExplorerTxLink(firstItem.txHash),
    unixTime: firstItem.blockTime,
    valueTransmitted: 0
  };
};

const conversionEventToViewTradeEvent = (
  conversion: DecodedTimedEvent<ConversionEventDecoded>,
  tokenPrices: ViewToken[],
  createBlockExplorerTxLink: (hash: string) => string,
  createBlockExplorerAccountLink: (account: string) => string
): ViewLiquidityEvent<ViewTradeEvent> => {
  const fromToken = findOrThrow(
    tokenPrices,
    price => compareString(price.id, conversion.data.from.address),
    `failed finding token meta passed to conversion event to view trade ${conversion.data.from.address}`
  );
  const toToken = findOrThrow(
    tokenPrices,
    price => compareString(price.id, conversion.data.to.address),
    `failed finding token meta passed to conversion event to view trade ${conversion.data.to.address}`
  );

  const fromAmountDec = shrinkToken(
    conversion.data.from.weiAmount,
    fromToken.precision
  );

  const toAmountDec = shrinkToken(
    conversion.data.to.weiAmount,
    toToken.precision
  );

  return {
    txLink: createBlockExplorerTxLink(conversion.txHash),
    accountLink: createBlockExplorerAccountLink(conversion.data.trader),
    valueTransmitted: new BigNumber(fromAmountDec)
      .times(fromToken.price || 0)
      .toNumber(),
    type: "swap",
    unixTime: conversion.blockTime,
    account: conversion.data.trader,
    txHash: conversion.txHash,
    data: {
      from: viewTokenToViewAmountWithMeta(fromAmountDec, fromToken),
      to: viewTokenToViewAmountWithMeta(toAmountDec, toToken)
    }
  };
};

type Wei = string;

const calculateExpectedPoolTokenReturnV2 = (
  poolTokenSupply: Wei,
  stakedReserveBalance: Wei,
  reserveTokenAmountToDeposit: Wei
): Wei =>
  new BigNumber(poolTokenSupply)
    .div(stakedReserveBalance)
    .times(reserveTokenAmountToDeposit)
    .toFixed(0);

const calculateShareOfPool = (
  poolTokensToAdd: Wei,
  poolTokenSupply: Wei,
  existingUserPoolTokenBalance?: Wei
): number => {
  if (new BigNumber(poolTokenSupply).eq(0)) return 1;

  const suggestedSmartTokens = new BigNumber(poolTokensToAdd).plus(
    existingUserPoolTokenBalance || 0
  );

  const suggestedSmartTokenSupply = new BigNumber(poolTokenSupply).plus(
    poolTokensToAdd
  );

  const shareOfPool = suggestedSmartTokens
    .div(suggestedSmartTokenSupply)
    .toNumber();

  return shareOfPool;
};

const relayIncludesReserves = (reserves: string[]) => (relay: Relay) =>
  relay.reserves.every(reserve =>
    reserves.some(r => compareString(reserve.contract, r))
  );

const compareRelayByReserves = (a: Relay, b: Relay) =>
  a.reserves.every(reserve =>
    b.reserves.some(r => compareString(reserve.contract, r.contract))
  );

const rawAbiV2ToStacked = (
  rawAbiV2: RawAbiV2PoolBalances
): StakedAndReserve => {
  const primaryReserveWeight =
    rawAbiV2.effectiveReserveWeights && rawAbiV2.effectiveReserveWeights[0];
  const secondaryReserveWeight =
    rawAbiV2.effectiveReserveWeights && rawAbiV2.effectiveReserveWeights[1];

  const reserveOneIsPrimaryReserve = compareString(
    rawAbiV2.reserveOne,
    rawAbiV2.primaryReserveToken
  );

  const reserveOneReserveWeight = reserveOneIsPrimaryReserve
    ? primaryReserveWeight
    : secondaryReserveWeight;
  const reserveTwoReserveWeight = reserveOneIsPrimaryReserve
    ? secondaryReserveWeight
    : primaryReserveWeight;

  return {
    converterAddress: rawAbiV2.converterAddress,
    reserves: [
      {
        reserveAddress: rawAbiV2.reserveOne,
        stakedBalance: rawAbiV2.reserveOneStakedBalance,
        reserveWeight: reserveOneReserveWeight,
        poolTokenAddress: rawAbiV2.reserveOnePoolToken
      },
      {
        reserveAddress: rawAbiV2.reserveTwo,
        stakedBalance: rawAbiV2.reserveTwoStakedBalance,
        reserveWeight: reserveTwoReserveWeight,
        poolTokenAddress: rawAbiV2.reserveTwoPoolToken
      }
    ]
  };
};

const getAnchorTokenAddresses = (relay: Relay): string[] => {
  if (relay.converterType == PoolType.ChainLink) {
    const actualRelay = relay as ChainLinkRelay;
    return actualRelay.anchor.poolTokens.map(x => x.poolToken.contract);
  } else if (relay.converterType == PoolType.Traditional) {
    const actualRelay = relay as TraditionalRelay;
    return [actualRelay.anchor.contract];
  } else {
    throw new Error("Failed to identify type of relay passed");
  }
};

interface RefinedAbiRelay {
  anchorAddress: string;
  reserves: [string, string];
  version: number;
  converterType: PoolType;
  converterAddress: string;
  connectorToken1: string;
  connectorToken2: string;
  connectorTokenCount: string;
  conversionFee: string;
  owner: string;
}

const decToPpm = (dec: number | string): string =>
  new BigNumber(dec).times(oneMillion).toFixed(0);

const determineConverterType = (
  converterType: string | undefined
): PoolType => {
  if (typeof converterType == "undefined") {
    return PoolType.Traditional;
  } else if (Number(converterType) == 32) {
    return PoolType.Traditional;
  } else if (Number(converterType) == 1) {
    return PoolType.Traditional;
  } else if (Number(converterType) == 2) {
    return PoolType.ChainLink;
  } else if (Number(converterType) == 0) {
    return PoolType.Liquid;
  }
  throw new Error("Failed to determine the converter type");
};

const smartTokenAnchor = (smartToken: Token) => ({
  anchor: smartToken,
  converterType: PoolType.Traditional
});

interface UsdValue {
  id: string;
  usdPrice: string;
}

const trustedStables = (network: EthNetworks): UsdValue[] => {
  if (network == EthNetworks.Mainnet) {
    return [
      { id: "0x309627af60f0926daa6041b8279484312f2bf060", usdPrice: "1" }
    ];
  }
  return [];
};

const calculateSlippage = (
  slippageLessRate: BigNumber,
  slippagedRate: BigNumber
): BigNumber => {
  if (slippagedRate.gt(slippageLessRate)) throw new Error("Rates are bad");
  const result = slippageLessRate.minus(slippagedRate).abs();
  return result.div(slippageLessRate);
};

const buildRate = (amountEntered: BigNumber, returnAmount: BigNumber) =>
  returnAmount.div(amountEntered);

const buildRelayFeedChainkLink = ({
  relays,
  usdPriceOfBnt
}: {
  relays: RawV2Pool[];
  usdPriceOfBnt: number;
}) => relays.flatMap(relay => buildReserveFeedsChainlink(relay, usdPriceOfBnt));

const buildReserveFeedsTraditional = (
  relay: RelayWithReserveBalances,
  knownUsdPrices: UsdValue[]
): ReserveFeed[] => {
  const reservesBalances = relay.reserves.map(reserve => {
    const reserveBalance = findOrThrow(
      relay.reserveBalances,
      balance => compareString(balance.id, reserve.contract),
      "failed to find a reserve balance for reserve"
    );

    const decAmount = shrinkToken(reserveBalance.amount, reserve.decimals);
    const knownUsdPrice = knownUsdPrices.find(price =>
      compareString(price.id, reserve.contract)
    );
    return {
      reserve,
      decAmount,
      knownUsdPrice
    };
  });

  const [networkReserve, tokenReserve] = sortByNetworkTokens(
    reservesBalances,
    balance => balance.reserve.symbol.toUpperCase()
  );

  const cryptoCostOfTokenReserve = new BigNumber(networkReserve.decAmount)
    .dividedBy(tokenReserve.decAmount)
    .toNumber();
  const cryptoCostOfNetworkReserve = new BigNumber(
    tokenReserve.decAmount
  ).dividedBy(networkReserve.decAmount);

  let usdCostOfTokenReserve: number;
  let usdCostOfNetworkReserve: number;

  if (networkReserve.knownUsdPrice) {
    usdCostOfTokenReserve = new BigNumber(cryptoCostOfTokenReserve)
      .times(networkReserve.knownUsdPrice.usdPrice)
      .toNumber();
    usdCostOfNetworkReserve = new BigNumber(cryptoCostOfNetworkReserve)
      .times(usdCostOfTokenReserve)
      .toNumber();
  } else if (tokenReserve.knownUsdPrice) {
    usdCostOfNetworkReserve = new BigNumber(cryptoCostOfNetworkReserve)
      .times(tokenReserve.knownUsdPrice.usdPrice)
      .toNumber();
    usdCostOfTokenReserve = new BigNumber(cryptoCostOfTokenReserve)
      .times(usdCostOfNetworkReserve)
      .toNumber();
  } else {
    throw new Error(
      "Cannot determine the price without knowing one of the reserve prices"
    );
  }

  if (Number.isNaN(usdCostOfNetworkReserve)) usdCostOfNetworkReserve = 0;

  const liqDepth = new BigNumber(networkReserve.decAmount)
    .times(usdCostOfNetworkReserve)
    .toNumber();

  return [
    {
      reserveAddress: tokenReserve.reserve.contract,
      poolId: relay.id,
      costByNetworkUsd: usdCostOfTokenReserve,
      liqDepth,
      priority: 10
    },
    {
      reserveAddress: networkReserve.reserve.contract,
      poolId: relay.id,
      liqDepth,
      costByNetworkUsd: usdCostOfNetworkReserve,
      priority: 10
    }
  ];
};

const duplicateWith = <T>(
  arr: readonly T[],
  comparator: (a: T, b: T) => boolean
) =>
  arr.filter(
    (item, index, arr) => arr.findIndex(i => comparator(item, i)) !== index
  );

const compareById = (a: { id: string }, b: { id: string }) =>
  compareString(a.id, b.id);

const compareReserveFeedByReserveAddress = (a: ReserveFeed, b: ReserveFeed) =>
  compareString(a.reserveAddress, b.reserveAddress);

const reserveFeedToUsdPrice = (reserveFeed: ReserveFeed): UsdValue => ({
  id: reserveFeed.reserveAddress,
  usdPrice: String(reserveFeed.costByNetworkUsd)
});

const buildPossibleReserveFeedsTraditional = (
  v1Pools: RelayWithReserveBalances[],
  initialKnownPrices: UsdValue[]
): ReserveFeed[] => {
  if (initialKnownPrices.length == 0)
    throw new Error("Must know the price of at least one token");
  const duplicatePrices = duplicateWith(initialKnownPrices, compareById);
  if (duplicatePrices.length > 0)
    throw new Error("Cannot pass multiple prices of a single token");

  const attemptedRelays = v1Pools.map(pool => {
    try {
      const res = buildReserveFeedsTraditional(pool, initialKnownPrices);
      return res;
    } catch (e) {
      return false;
    }
  });

  const [fulfilled, failed] = partition(attemptedRelays, Boolean);
  const flatReserveFeeds = ((fulfilled as unknown) as ReserveFeed[][])
    .flat(2)
    .sort(sortByLiqDepth);
  if (failed.length == 0) return flatReserveFeeds;
  const uniquePrices = uniqWith(
    flatReserveFeeds,
    compareReserveFeedByReserveAddress
  ).map(reserveFeedToUsdPrice);
  const learntPrices = uniqWith(
    [...initialKnownPrices, ...uniquePrices],
    compareById
  );
  const hasLearntNewPrices = learntPrices.length > initialKnownPrices.length;
  return hasLearntNewPrices
    ? buildPossibleReserveFeedsTraditional(v1Pools, learntPrices)
    : flatReserveFeeds;
};

const buildReserveFeedsChainlink = (
  relay: RawV2Pool,
  usdPriceOfBnt: number
): ReserveFeed[] => {
  const reserveBalances = relay.reserves;
  const reserveWeights = relay.reserves.map(balance => balance.reserveWeight);

  const noReserveWeights = reserveWeights.every(
    weight => typeof weight == "undefined"
  );
  if (noReserveWeights) return [];

  const sortedTokens = sortByNetworkTokens(
    reserveBalances,
    reserve => reserve.token.symbol
  ).map(token => ({
    ...token,
    decAmount: shrinkToken(token.stakedBalance, token.token.decimals),
    decWeight: new BigNumber(token.reserveWeight as string).div(oneMillion)
  }));

  const [secondaryReserveToken, primaryReserveToken] = sortedTokens;

  const secondarysPrice =
    secondaryReserveToken.token.symbol == "USDB" ? 1 : usdPriceOfBnt;

  const secondarysLiqDepth = new BigNumber(
    secondaryReserveToken.decAmount
  ).times(secondarysPrice);

  const wholeLiquidityDepth = secondarysLiqDepth.div(
    secondaryReserveToken.decWeight
  );
  const primaryLiquidityDepth = wholeLiquidityDepth.minus(secondarysLiqDepth);

  const result = [
    {
      reserveAddress: primaryReserveToken.token.contract,
      poolId: relay.anchorAddress,
      priority: 10,
      liqDepth: primaryLiquidityDepth.toNumber(),
      costByNetworkUsd: primaryLiquidityDepth
        .div(primaryReserveToken.decAmount)
        .toNumber()
    },
    {
      reserveAddress: secondaryReserveToken.token.contract,
      poolId: relay.anchorAddress,
      priority: 10,
      liqDepth: secondarysLiqDepth.toNumber(),
      costByNetworkUsd: secondarysPrice
    }
  ];
  return result;
};

const defaultImage = "https://ropsten.etherscan.io/images/main/empty-token.png";
const ORIGIN_ADDRESS = DataTypes.originAddress;

type TotalVolumeAndLiquidity = [string, string, string, number];

type VolumeAndLiq = [string, string, string];

const relayShape = (converterAddress: string) => {
  const contract = buildV28ConverterContract(converterAddress);
  return {
    converterAddress: ORIGIN_ADDRESS,
    owner: contract.methods.owner(),
    converterType: contract.methods.converterType(),
    version: contract.methods.version(),
    connectorTokenCount: contract.methods.connectorTokenCount(),
    conversionFee: contract.methods.conversionFee(),
    connectorToken1: contract.methods.connectorTokens(0),
    connectorToken2: contract.methods.connectorTokens(1)
  };
};

const poolTokenShape = (address: string) => {
  const contract = buildContainerContract(address);
  return {
    symbol: contract.methods.symbol(),
    decimals: contract.methods.decimals(),
    poolTokens: contract.methods.poolTokens(),
    contract: ORIGIN_ADDRESS
  };
};

const v2PoolBalanceShape = (
  contractAddress: string,
  reserveOne: string,
  reserveTwo: string
) => {
  const contract = buildV2Converter(contractAddress);
  return {
    converterAddress: ORIGIN_ADDRESS,
    primaryReserveToken: contract.methods.primaryReserveToken(),
    secondaryReserveToken: contract.methods.secondaryReserveToken(),
    reserveOne,
    reserveTwo,
    reserveOnePoolToken: contract.methods.poolToken(reserveOne),
    reserveTwoPoolToken: contract.methods.poolToken(reserveTwo),
    reserveOneStakedBalance: contract.methods.reserveStakedBalance(reserveOne),
    reserveTwoStakedBalance: contract.methods.reserveStakedBalance(reserveTwo),
    effectiveReserveWeights: contract.methods.effectiveReserveWeights()
  };
};

const liquidityProtectionShape = (contractAddress: string) => {
  const contract = buildLiquidityProtectionContract(contractAddress);
  return {
    minProtectionDelay: contract.methods.minProtectionDelay(),
    maxProtectionDelay: contract.methods.maxProtectionDelay(),
    lockDuration: contract.methods.lockDuration(),
    networkToken: contract.methods.networkToken(),
    govToken: contract.methods.govToken(),
    maxSystemNetworkTokenAmount: contract.methods.maxSystemNetworkTokenAmount(),
    maxSystemNetworkTokenRatio: contract.methods.maxSystemNetworkTokenRatio()
  };
};

const calculatePercentIncrease = (
  small: number | string,
  big: number | string
): string => {
  const profit = new BigNumber(big).minus(small);
  return profit.div(small).toString();
};

interface TokenWei {
  tokenContract: string;
  weiAmount: string;
}

const notBlackListed = (blackListedAnchors: string[]) => (
  converterAnchor: ConverterAndAnchor
) =>
  !blackListedAnchors.some(black =>
    compareString(black, converterAnchor.anchorAddress)
  );

interface RawV2Pool {
  reserves: {
    token: Token;
    reserveAddress: string;
    stakedBalance: string;
    reserveWeight: string | undefined;
    poolTokenAddress: string;
  }[];
  converterAddress: string;
  anchorAddress: string;
}

interface V2Response {
  reserveFeeds: ReserveFeed[];
  pools: (RelayWithReserveBalances | ChainLinkRelay)[];
}

const sortFeedByExtraProps = (a: ReserveFeed, b: ReserveFeed) => {
  if (a.change24H || a.volume24H) return -1;
  if (b.change24H || a.volume24H) return 1;
  return 0;
};

const compareAnchorAndConverter = (
  a: ConverterAndAnchor,
  b: ConverterAndAnchor
) =>
  compareString(a.anchorAddress, b.anchorAddress) &&
  compareString(a.converterAddress, b.converterAddress);
interface RawAbiRelay {
  connectorToken1: string;
  connectorToken2: string;
  connectorTokenCount: string;
  conversionFee: string;
  owner: string;
  version: string;
  converterType?: string;
}

const zipAnchorAndConverters = (
  anchorAddresses: string[],
  converterAddresses: string[]
): ConverterAndAnchor[] => {
  if (anchorAddresses.length !== converterAddresses.length)
    throw new Error(
      "was expecting as many anchor addresses as converter addresses"
    );
  const zipped = zip(anchorAddresses, converterAddresses) as [string, string][];
  return zipped.map(([anchorAddress, converterAddress]) => ({
    anchorAddress: anchorAddress!,
    converterAddress: converterAddress!
  }));
};

const pickEthToken = (obj: any): Token => ({
  contract: obj.contract,
  decimals: obj.decimals,
  network: "ETH",
  symbol: obj.symbol
});

interface AbiRelay extends RawAbiRelay {
  converterAddress: string;
}

interface RawAbiToken {
  contract: string;
  symbol: string;
  decimals: string;
}

const prioritiseV2Pools = (a: ViewRelay, b: ViewRelay) => {
  if (a.v2 && b.v2) return 0;
  if (!a.v2 && !b.v2) return 0;
  if (a.v2 && !b.v2) return -1;
  if (!a.v2 && b.v2) return 1;
  return 0;
};

interface RawAbiCentralPoolToken extends RawAbiToken {
  poolTokens?: string[];
}

interface AbiCentralPoolToken extends RawAbiCentralPoolToken {
  contract: string;
}

interface ConverterAndAnchor {
  converterAddress: string;
  anchorAddress: string;
}

const networkTokenAddresses = [
  "0x309627af60F0926daa6041B8279484312f2bf060",
  "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C"
];

const metaToModalChoice = (meta: TokenMeta): ModalChoice => ({
  id: meta.contract,
  contract: meta.contract,
  symbol: meta.symbol,
  img: meta.image
});

const isTraditional = (relay: Relay): boolean =>
  typeof relay.anchor == "object" &&
  relay.converterType == PoolType.Traditional;

const isChainLink = (relay: Relay): boolean =>
  Array.isArray((relay.anchor as PoolContainer).poolTokens) &&
  relay.converterType == PoolType.ChainLink;

const assertTraditional = (relay: Relay): TraditionalRelay => {
  if (isTraditional(relay)) {
    return relay as TraditionalRelay;
  }
  throw new Error("Not a traditional relay");
};

const assertChainlink = (relay: Relay): ChainLinkRelay => {
  if (isChainLink(relay)) {
    return relay as ChainLinkRelay;
  }
  throw new Error("Not a chainlink relay");
};

const generateEtherscanTxLink = (txHash: string, ropsten: boolean = false) =>
  `https://${ropsten ? "ropsten." : ""}etherscan.io/tx/${txHash}`;

const generateEtherscanAccountLink = (
  account: string,
  ropsten: boolean = false
) => `https://${ropsten ? "ropsten." : ""}etherscan.io/address/${account}`;

interface AnchorProps {
  anchor: Anchor;
  converterType: PoolType;
}

const iouTokensInRelay = (relay: Relay): Token[] => {
  if (relay.converterType == PoolType.ChainLink) {
    const poolContainer = relay.anchor as PoolContainer;
    const poolTokens = poolContainer.poolTokens;
    const tokens = poolTokens.map(token => token.poolToken);
    return tokens;
  } else if (relay.converterType == PoolType.Traditional) {
    const smartToken = relay.anchor as SmartToken;
    return [smartToken];
  } else throw new Error("Failed to identify pool");
};

const reserveTokensInRelay = (relay: Relay): Token[] => relay.reserves;

const tokensInRelay = (relay: Relay): Token[] => [
  ...reserveTokensInRelay(relay),
  ...iouTokensInRelay(relay)
];

const relayToMinimal = (relay: Relay): MinimalRelay => ({
  contract: relay.contract,
  reserves: relay.reserves.map(
    (reserve): TokenSymbol => ({
      contract: reserve.contract,
      symbol: reserve.symbol
    })
  ),
  anchorAddress: isTraditional(relay)
    ? (relay.anchor as SmartToken).contract
    : (relay.anchor as PoolContainer).poolContainerAddress
});

const sortSmartTokenAddressesByHighestLiquidity = (
  tokens: TokenPrice[],
  smartTokenAddresses: string[]
): string[] => {
  const sortedTokens = tokens
    .slice()
    .sort((a, b) => b.liquidityDepth - a.liquidityDepth);

  const sortedDictionary = sortedTokens
    .map(
      token =>
        ethBancorApiDictionary.find(dic =>
          compareString(token.id, dic.tokenId)
        )!
    )
    .filter(Boolean);

  const res = sortAlongSide(
    smartTokenAddresses,
    pool => pool,
    sortedDictionary.map(x => x.smartTokenAddress)
  );

  const isSame = res.every((item, index) => smartTokenAddresses[index] == item);
  if (isSame)
    console.warn(
      "Sorted by Highest liquidity sorter is returning the same array passed"
    );
  return res;
};

interface EthOpposingLiquid {
  smartTokenAmountWei: ViewAmount;
  opposingAmount?: string;
  shareOfPool: number;
  singleUnitCosts: ViewAmount[];
  reserveBalancesAboveZero: boolean;
}

interface RawAbiV2PoolBalances {
  converterAddress: string;
  reserveOne: string;
  reserveTwo: string;
  reserveOnePoolToken: string;
  reserveTwoPoolToken: string;
  primaryReserveToken: string;
  secondaryReserveToken: string;
  reserveOneStakedBalance: string;
  reserveTwoStakedBalance: string;
  effectiveReserveWeights: { 0: string; 1: string } | undefined;
}

interface RawAbiReserveBalance {
  converterAddress: string;
  reserveOne: string;
  reserveTwo: string;
}

const hasTwoConnectors = (relay: RefinedAbiRelay) => {
  const test = Number(relay.connectorTokenCount) == 2;
  if (!test)
    console.warn(
      "Dropping relay",
      relay.anchorAddress,
      "because it does not have a connector count of two"
    );
  return test;
};

const networkTokenIncludedInReserves = (networkTokenAddresses: string[]) => (
  relay: RefinedAbiRelay
) => {
  const test = relay.reserves.some(reserve =>
    networkTokenAddresses.some(networkAddress =>
      compareString(networkAddress, reserve)
    )
  );
  if (!test)
    console.warn(
      "Dropping",
      relay.anchorAddress,
      "because it does not feature a network token"
    );
  return test;
};

interface StakedAndReserve {
  converterAddress: string;
  reserves: {
    reserveAddress: string;
    stakedBalance: string;
    reserveWeight: string | undefined;
    poolTokenAddress: string;
  }[];
}

const polishTokens = (tokenMeta: TokenMeta[], tokens: Token[]) => {
  const ethReserveToken: Token = {
    contract: ethReserveAddress,
    decimals: 18,
    network: "ETH",
    symbol: "ETH"
  };

  const ethHardCode = updateArray(
    tokens,
    token => compareString(token.contract, ethReserveAddress),
    _ => ethReserveToken
  );

  const decimalIsWrong = (decimals: number | undefined) =>
    typeof decimals == "undefined" || Number.isNaN(decimals);

  const missingDecimals = updateArray(
    ethHardCode,
    token => decimalIsWrong(token.decimals),
    missingDecimal => {
      const meta = tokenMeta.find(x =>
        compareString(x.contract, missingDecimal.contract)
      )!;
      if (Object.keys(meta).includes("precision")) {
        return {
          ...missingDecimal,
          decimals: meta.precision!
        };
      }
      console.warn(
        "Token Meta couldnt help determine decimals of token address",
        missingDecimal.contract
      );
      return {
        ...missingDecimal
      };
    }
  ).filter(token => !decimalIsWrong(token.decimals));

  const missingSymbol = updateArray(
    missingDecimals,
    token => !token.symbol,
    tokenWithoutSymbol => {
      const meta = tokenMeta.find(x =>
        compareString(x.contract, tokenWithoutSymbol.contract)
      )!;
      if (meta.symbol) {
        return {
          ...tokenWithoutSymbol,
          symbol: meta.symbol
        };
      } else {
        console.warn("Dropping", tokenWithoutSymbol, "due to no symbol");
        return {
          ...tokenWithoutSymbol
        };
      }
    }
  ).filter(token => token.symbol);

  const addedEth = [...missingSymbol, ethReserveToken];
  const uniqueTokens = uniqWith(addedEth, (a, b) =>
    compareString(a.contract, b.contract)
  );

  const difference = differenceWith(tokens, uniqueTokens, (a, b) =>
    compareString(a.contract, b.contract)
  );
  if (difference.length > 0) {
    console.warn(
      "Polish tokens is dropping",
      difference,
      "tokens",
      "sending back",
      uniqueTokens
    );
  }
  return uniqueTokens;
};

const seperateMiniTokens = (tokens: AbiCentralPoolToken[]) => {
  const smartTokens = tokens
    .filter(token => !token.poolTokens)
    .map(pickEthToken);

  const poolTokenAddresses = tokens
    .filter(token => Array.isArray(token.poolTokens))
    .map(token => ({
      anchorAddress: token.contract,
      poolTokenAddresses: token.poolTokens as string[]
    }));

  const rebuiltLength = poolTokenAddresses.length + smartTokens.length;
  if (rebuiltLength !== tokens.length) {
    console.error("failed to rebuild properly");
  }
  return { smartTokens, poolTokenAddresses };
};

const tokenShape = (contractAddress: string) => {
  const contract = buildTokenContract(contractAddress);
  const template = {
    contract: ORIGIN_ADDRESS,
    symbol: contract.methods.symbol(),
    decimals: contract.methods.decimals()
  };
  return template;
};

const reserveBalanceShape = (contractAddress: string, reserves: string[]) => {
  const contract = buildConverterContract(contractAddress);
  const [reserveOne, reserveTwo] = reserves;
  return {
    converterAddress: ORIGIN_ADDRESS,
    reserveOne: contract.methods.getConnectorBalance(reserveOne),
    reserveTwo: contract.methods.getConnectorBalance(reserveTwo)
  };
};
interface RegisteredContracts {
  BancorNetwork: string;
  BancorConverterRegistry: string;
  LiquidityProtection: string;
  LiquidityProtectionStore: string;
}

const percentageOfReserve = (percent: number, existingSupply: string): string =>
  new Decimal(percent).times(existingSupply).toFixed(0);

const percentageIncrease = (deposit: string, existingSupply: string): number =>
  new Decimal(deposit).div(existingSupply).toNumber();

const calculateOppositeFundRequirement = (
  deposit: string,
  depositsSupply: string,
  oppositesSupply: string
): string => {
  const increase = percentageIncrease(deposit, depositsSupply);
  return percentageOfReserve(increase, oppositesSupply);
};

const calculateOppositeLiquidateRequirement = (
  reserveAmount: string,
  reserveBalance: string,
  oppositeReserveBalance: string
) => {
  const increase = percentageIncrease(reserveAmount, reserveBalance);
  return percentageOfReserve(increase, oppositeReserveBalance);
};

const oneMillion = new BigNumber(1000000);

const calculateFundReward = (
  reserveAmount: string,
  reserveSupply: string,
  smartSupply: string
) => {
  Decimal.set({ rounding: 0 });

  const smartSupplyNumber = new Decimal(smartSupply);
  if (smartSupplyNumber.eq(0)) {
    throw new Error("Client side geometric mean not yet supported");
  }
  return new Decimal(reserveAmount)
    .div(reserveSupply)
    .times(smartSupplyNumber)
    .times(0.99)
    .toFixed(0);
};

const calculateLiquidateCost = (
  reserveAmount: string,
  reserveBalance: string,
  smartSupply: string
) => {
  const percent = percentageIncrease(reserveAmount, reserveBalance);
  return percentageOfReserve(percent, smartSupply);
};

const percentDifference = (smallAmount: string, bigAmount: string) =>
  new Decimal(smallAmount).div(bigAmount).toNumber();

const tokenMetaDataEndpoint =
  "https://raw.githubusercontent.com/Velua/eth-tokens-registry/master/tokens.json";

interface TokenMeta {
  id: string;
  image: string;
  contract: string;
  symbol: string;
  name: string;
  precision?: number;
}

const metaToTokenAssumedPrecision = (token: TokenMeta): Token => ({
  contract: token.contract,
  decimals: token.precision!,
  network: "ETH",
  symbol: token.symbol
});

const getTokenMeta = async (currentNetwork: EthNetworks) => {
  const networkVars = getNetworkVariables(currentNetwork);
  if (currentNetwork == EthNetworks.Ropsten) {
    return [
      {
        symbol: "BNT",
        contract: networkVars.bntToken,
        decimals: 18
      },
      {
        symbol: "DAI",
        contract: "0xc2118d4d90b274016cb7a54c03ef52e6c537d957",
        decimals: 18
      },
      {
        symbol: "WBTC",
        contract: "0xbde8bb00a7ef67007a96945b3a3621177b615c44",
        decimals: 8
      },
      {
        symbol: "BAT",
        contract: "0x443fd8d5766169416ae42b8e050fe9422f628419",
        decimals: 18
      },
      {
        symbol: "LINK",
        contract: "0x20fe562d797a42dcb3399062ae9546cd06f63280",
        decimals: 18
      },
      {
        contract: "0x4F5e60A76530ac44e0A318cbc9760A2587c34Da6",
        symbol: "YYYY"
      },
      {
        contract: "0x63B75DfA4E87d3B949e876dF2Cd2e656Ec963466",
        symbol: "YYY"
      },
      {
        contract: "0xAa2A908Ca3E38ECEfdbf8a14A3bbE7F2cA2a1BE4",
        symbol: "XXX"
      },
      {
        contract: "0xe4158797A5D87FB3080846e019b9Efc4353F58cC",
        symbol: "XXX"
      }
    ].map(
      (x): TokenMeta => ({
        ...x,
        id: x.contract,
        image: defaultImage,
        name: x.symbol
      })
    );
  }
  if (currentNetwork !== EthNetworks.Mainnet)
    throw new Error("Ropsten and Mainnet supported only.");

  const res: AxiosResponse<TokenMeta[]> = await axios.get(
    tokenMetaDataEndpoint
  );

  const drafted = res.data
    .filter(({ symbol, contract, image }) =>
      [symbol, contract, image].every(Boolean)
    )
    .map(x => ({ ...x, id: x.contract }));

  const existingEth = drafted.find(x => compareString(x.symbol, "eth"))!;

  const withoutEth = drafted.filter(meta => !compareString(meta.symbol, "eth"));
  const addedEth = {
    ...existingEth,
    id: ethReserveAddress,
    contract: ethReserveAddress
  };
  const final = [addedEth, existingEth, ...withoutEth];
  return uniqWith(final, (a, b) => compareString(a.id, b.id));
};

const compareRelayById = (a: Relay, b: Relay) => compareString(a.id, b.id);

const VuexModule = createModule({
  strict: false
});

interface LiquidityProtectionSettings {
  minDelay: number;
  maxDelay: number;
  lockedDelay: number;
  govToken: string;
  networkToken: string;
  maxSystemNetworkTokenAmount: string;
  maxSystemNetworkTokenRatio: string;
}

interface RawLiquidityProtectionSettings {
  minProtectionDelay: string;
  maxProtectionDelay: string;
  lockDuration: string;
  govToken: string;
  networkToken: string;
  maxSystemNetworkTokenAmount: string;
  maxSystemNetworkTokenRatio: string;
}

export class EthBancorModule
  extends VuexModule.With({ namespaced: "ethBancor/" })
  implements TradingModule, LiquidityModule, CreatePoolModule, HistoryModule {
  registeredAnchorAddresses: string[] = [];
  convertibleTokenAddresses: string[] = [];
  loadingPools: boolean = true;

  bancorApiTokens: TokenPrice[] = [];
  relaysList: readonly Relay[] = [];
  tokenBalances: { id: string; balance: string }[] = [];
  bntUsdPrice: number = 0;
  tokenMeta: TokenMeta[] = [];
  availableHistories: string[] = [];
  contracts: RegisteredContracts = {
    BancorNetwork: "",
    BancorConverterRegistry: "",
    LiquidityProtection: "",
    LiquidityProtectionStore: ""
  };
  initiated: boolean = false;
  failedPools: string[] = [];
  currentNetwork: EthNetworks = EthNetworks.Mainnet;
  slippageTolerance = 0;
  useTraditionalCalls = true;

  liquidityProtectionSettings: LiquidityProtectionSettings = {
    minDelay: moment.duration("30", "days").asSeconds(),
    maxDelay: moment.duration("100", "days").asSeconds(),
    lockedDelay: moment.duration("24", "hours").asSeconds(),
    networkToken: "",
    govToken: "",
    maxSystemNetworkTokenAmount: "",
    maxSystemNetworkTokenRatio: ""
  };

  @mutation setTraditionalCalls(status: boolean) {
    this.useTraditionalCalls = status;
  }

  @mutation setLiquidityProtectionSettings(
    settings: LiquidityProtectionSettings
  ) {
    this.liquidityProtectionSettings = settings;
  }

  @action async fetchLiquidityProtectionSettings(contractAddress: string) {
    const [[settings]] = ((await this.multi([
      [liquidityProtectionShape(contractAddress)]
    ])) as unknown) as [RawLiquidityProtectionSettings][];

    const newSettings = {
      minDelay: Number(settings.minProtectionDelay),
      maxDelay: Number(settings.maxProtectionDelay),
      lockedDelay: Number(settings.lockDuration),
      govToken: settings.govToken,
      networkToken: settings.networkToken,
      maxSystemNetworkTokenRatio: settings.maxSystemNetworkTokenRatio,
      maxSystemNetworkTokenAmount: settings.maxSystemNetworkTokenAmount
    } as LiquidityProtectionSettings;
    this.setLiquidityProtectionSettings(newSettings);
    this.fetchBulkTokenBalances([newSettings.govToken]);
    return newSettings;
  }

  get stats() {
    return {
      totalLiquidityDepth: this.tokens.reduce(
        (acc, item) => acc + (item.liqDepth || 0),
        0
      ),
      nativeTokenPrice: {
        symbol: "ETH",
        price:
          this.tokens.find(token => compareString("ETH", token.symbol))!
            .price || 0
      },
      twentyFourHourTradeCount: this.liquidityHistory.data.length
    };
  }

  whiteListedPools: string[] = [];

  @mutation setWhiteListedPools(anchors: string[]) {
    this.whiteListedPools = anchors;
  }

  @action async fetchWhiteListedV1Pools(
    liquidityProtectionStoreAddress?: string
  ) {
    const contractAddress =
      liquidityProtectionStoreAddress ||
      this.contracts.LiquidityProtectionStore;
    const liquidityProtection = buildLiquidityProtectionStoreContract(
      contractAddress
    );
    const whiteListedPools = await liquidityProtection.methods
      .whitelistedPools()
      .call();
    this.setWhiteListedPools(whiteListedPools);
    console.log(whiteListedPools, "are white listed pools");
    return whiteListedPools;
  }

  @action async protectLiquidityTx({
    anchorAddress,
    amountWei
  }: {
    anchorAddress: string;
    amountWei: string;
  }) {
    const liquidityProtectionAddress = this.contracts.LiquidityProtection;
    const contract = buildLiquidityProtectionContract(
      liquidityProtectionAddress
    );
    return this.resolveTxOnConfirmation({
      tx: contract.methods.protectLiquidity(anchorAddress, amountWei)
    });
  }

  @action async unProtectLiquidityTx({
    id1,
    id2
  }: {
    id1: string;
    id2: string;
  }) {
    const liquidityProtectionAddress = this.contracts.LiquidityProtection;
    const contract = buildLiquidityProtectionContract(
      liquidityProtectionAddress
    );
    return this.resolveTxOnConfirmation({
      tx: contract.methods.unprotectLiquidity(id1, id2)
    });
  }

  @action async unprotectLiquidity({
    id1,
    id2
  }: {
    id1: string;
    id2: string;
  }): Promise<TxResponse> {
    const res = await this.unProtectLiquidityTx({ id1, id2 });

    (async () => {
      await wait(700);
      this.fetchLockedBalances();
      this.fetchProtectionPositions();
      await wait(4000);
      this.fetchLockedBalances();
      this.fetchProtectionPositions();
    })();

    return {
      blockExplorerLink: await this.createExplorerLink(res),
      txId: res
    };
  }

  protectedPositionsArr: ProtectedLiquidityCalculated[] = [];

  @mutation setProtectedPositions(positions: ProtectedLiquidityCalculated[]) {
    console.log(positions, "are the positions getting set!");
    this.protectedPositionsArr = positions;
  }

  @action async fetchProtectionPositions(storeAddress?: string) {
    console.log("fetchProtectionPositions");
    console.count("fetchProtectionPositions");
    const liquidityStore =
      storeAddress || this.contracts.LiquidityProtectionStore;
    console.log(storeAddress, "is the new address", liquidityStore);
    if (!this.isAuthenticated) {
      return;
    }
    try {
      const contract = buildLiquidityProtectionStoreContract(liquidityStore);
      const owner = this.isAuthenticated;
      console.time("time to get ID count");
      const idCount = Number(
        await contract.methods.protectedLiquidityCount(owner).call()
      );
      console.timeEnd("time to get ID count");
      if (idCount == 0) return;
      console.time("time to get ids");
      const ids = await contract.methods.protectedLiquidityIds(owner).call();
      console.timeEnd("time to get ids");
      console.time("time to get all positions");
      const allPositions = await Promise.all(
        ids.map(id => protectionById(liquidityStore, id))
      );
      console.timeEnd("time to get all positions");
      console.log(allPositions, "are all positions");
      if (allPositions.length !== idCount)
        throw new Error("ID count does not match returned positions");

      console.log("contracts", this.contracts.LiquidityProtection);

      const lpContract = buildLiquidityProtectionContract(
        this.contracts.LiquidityProtection
      );

      console.time("secondsToGetCurrentBlock");
      const currentBlockNumber = await web3.eth.getBlockNumber();
      console.timeEnd("secondsToGetCurrentBlock");

      const blockHeightOneDayAgo = rewindBlocksByDays(currentBlockNumber, 1);
      // const blockHeightOneWeekAgo = rewindBlocksByDays(currentBlockNumber, 7);
      // const blockHeightOneMonthAgo = rewindBlocksByDays(currentBlockNumber, 30);

      const timeScales = [
        blockHeightOneDayAgo
        // blockHeightOneWeekAgo
        // blockHeightOneMonthAgo
      ];

      console.log(timeScales, "are the time scales");

      const uniqueAnchors = uniqWith(
        allPositions.map(pos => pos.poolToken),
        compareString
      );
      const historicalBalances = await Promise.all(
        uniqueAnchors.map(async anchor => {
          const balances = await this.fetchRelayBalances({
            poolId: anchor,
            blockHeight: blockHeightOneDayAgo
          });
          return {
            poolId: anchor,
            ...balances
          };
        })
      );

      const rois = await Promise.all(
        allPositions.map(
          async (position, posIndex): Promise<ProtectedLiquidityCalculated> => {
            try {
              const [oneDayRoi] = await Promise.all(
                timeScales.map(async blockHeight => {
                  console.log(
                    "historical balance ",
                    historicalBalances,
                    posIndex
                  );
                  const poolBalance = findOrThrow(historicalBalances, pool =>
                    compareString(pool.poolId, position.poolToken)
                  );

                  const historicalReserveBalances = poolBalance.reserves.map(
                    (reserve): WeiExtendedAsset => ({
                      weiAmount: reserve.weiAmount,
                      contract: reserve.contract
                    })
                  );

                  const poolTokenSupply = poolBalance.smartTokenSupplyWei;

                  const [tknReserveBalance, opposingTknBalance] = sortAlongSide(
                    historicalReserveBalances,
                    balance => balance.contract,
                    [position.reserveToken]
                  );

                  const poolToken = position.poolToken;
                  const reserveToken = position.reserveToken;
                  const reserveAmount = position.reserveAmount;
                  const poolRateN = new BigNumber(tknReserveBalance.weiAmount)
                    .times(2)
                    .toString();
                  const poolRateD = poolTokenSupply;

                  const reserveRateN = opposingTknBalance.weiAmount;
                  const reserveRateD = tknReserveBalance.weiAmount;

                  const poolRoi = await lpContract.methods
                    .poolROI(
                      poolToken,
                      reserveToken,
                      reserveAmount,
                      poolRateN,
                      poolRateD,
                      reserveRateN,
                      reserveRateD
                    )
                    .call();

                  console.log(poolRoi, "is raw pool ROI number");
                  return poolRoi;
                })
              );

              const rawRoiToDecPercentIncrease = (wei: string): BigNumber =>
                new BigNumber(wei).div(oneMillion).minus(1);

              const finalOneDayRoi = rawRoiToDecPercentIncrease(oneDayRoi)
                .times(365)
                .toString();
              // const finalOneWeekRoi = rawRoiToDecPercentIncrease(oneWeekRoi)
              //   .times(52)
              //   .toString();
              // const finalOneMonthRoi = rawRoiToDecPercentIncrease(oneMonthRoi)
              //   .times(12)
              //   .toString();

              const fullWaitTime =
                Number(position.timestamp) +
                Number(this.liquidityProtectionSettings.maxDelay);

              try {
                const liquidityReturn = await getRemoveLiquidityReturn(
                  this.contracts.LiquidityProtection,
                  position.id,
                  oneMillion.toString(),
                  fullWaitTime
                );

                return {
                  ...position,
                  liquidityReturn,
                  oneDayDec: finalOneDayRoi
                  // oneWeekDec: finalOneWeekRoi
                  // oneMonthDec: finalOneMonthRoi
                };
              } catch (e) {
                console.error("failed again", e);
                console.log(posIndex, "one");
                throw new Error("Failed getting remove liquidity return");
              }
            } catch (e) {
              console.log(e, "error fetching pool balances");
              console.log(posIndex, "two");
              throw new Error("");
            }
          }
        )
      );

      console.log("success!", rois);

      this.setProtectedPositions(rois);
      if (this.loadingProtectedPositions) {
        await wait(2);
        this.setLoadingPositions(false);
      }
      return rois;
    } catch (e) {
      console.error("Failed fetching protection positions", e.message);
    }
  }

  @action async addProtection({
    poolId,
    reserveAmount,
    onUpdate
  }: {
    poolId: string;
    reserveAmount: ViewAmount;
    onUpdate: OnUpdate;
  }): Promise<TxResponse> {
    const pool = this.relay(poolId);

    if (!pool.whitelisted) {
      throw new Error("Pool must be whitelisted to protect liquidity");
    }

    const liqudityProtectionContractAddress = this.contracts
      .LiquidityProtection;
    const contract = buildLiquidityProtectionContract(
      liqudityProtectionContractAddress
    );

    const reserveTokenAddress = reserveAmount.id;
    const token = this.token(reserveTokenAddress);
    const reserveAmountWei = expandToken(reserveAmount.amount, token.precision);

    const depositIsEth = compareString(reserveAmount.id, ethReserveAddress);

    const txHash = (await multiSteps({
      items: [
        {
          description: "Triggering approval..",
          task: async () => {
            if (!depositIsEth) {
              await this.triggerApprovalIfRequired({
                owner: this.isAuthenticated,
                spender: liqudityProtectionContractAddress,
                amount: reserveAmountWei,
                tokenAddress: reserveTokenAddress
              });
            }
          }
        },
        {
          description: "Adding liquidity..",
          task: async () => {
            return this.resolveTxOnConfirmation({
              tx: contract.methods.addLiquidity(
                poolId,
                reserveTokenAddress,
                reserveAmountWei
              ),
              ...(depositIsEth && { value: reserveAmountWei })
            });
          }
        }
      ],
      onUpdate
    })) as string;

    this.fetchProtectionPositions();
    this.fetchBulkTokenBalances([
      this.liquidityProtectionSettings.govToken,
      reserveTokenAddress
    ]);
    wait(2000).then(() => {
      this.fetchProtectionPositions();
      this.fetchBulkTokenBalances([
        this.liquidityProtectionSettings.govToken,
        reserveTokenAddress
      ]);
    });

    return {
      blockExplorerLink: await this.createExplorerLink(txHash),
      txId: txHash
    };
  }

  @action async removeProtection({
    decPercent,
    id
  }: {
    decPercent: number;
    id: string;
  }): Promise<TxResponse> {
    const dbId = id.split(":")[1];
    const contract = buildLiquidityProtectionContract(
      this.contracts.LiquidityProtection
    );
    const txHash = await this.resolveTxOnConfirmation({
      tx: contract.methods.removeLiquidity(dbId, decToPpm(decPercent))
    });

    (async () => {
      await wait(600);
      this.fetchLockedBalances();
      this.fetchProtectionPositions();
      await wait(2000);
      this.fetchLockedBalances();
      this.fetchProtectionPositions();
    })();

    return {
      blockExplorerLink: await this.createExplorerLink(txHash),
      txId: txHash
    };
  }

  @action async protectLiquidity({
    amount,
    onUpdate
  }: ProtectLiquidityParams): Promise<TxResponse> {
    const liquidityProtectionContractAddress = this.contracts
      .LiquidityProtection;

    const pool = await this.traditionalRelayById(amount.id);
    const poolToken = pool.anchor;
    if (!compareString(amount.id, poolToken.contract))
      throw new Error("Pool token does not match anchor ID");
    const poolTokenWei = expandToken(amount.amount, poolToken.decimals);

    const txHash = await multiSteps({
      items: [
        {
          description: "Approving transfer...",
          task: async () => {
            await this.triggerApprovalIfRequired({
              amount: poolTokenWei,
              owner: this.isAuthenticated,
              spender: liquidityProtectionContractAddress,
              tokenAddress: poolToken.contract
            });
          }
        },
        {
          description: "Adding liquidity protection...",
          task: async () => {
            return this.protectLiquidityTx({
              anchorAddress: poolToken.contract,
              amountWei: poolTokenWei
            });
          }
        }
      ],
      onUpdate
    });

    this.spamBalances([
      poolToken.contract,
      this.liquidityProtectionSettings.govToken
    ]);

    (async () => {
      this.fetchProtectionPositions();
      await wait(2000);
      this.fetchProtectionPositions();
      await wait(5000);
      this.fetchProtectionPositions();
    })();

    return {
      blockExplorerLink: await this.createExplorerLink(txHash),
      txId: txHash
    };
  }

  @mutation setTolerance(tolerance: number) {
    this.slippageTolerance = tolerance;
  }

  @action async setSlippageTolerance(tolerance: number) {
    this.setTolerance(tolerance);
  }

  @mutation setNetwork(network: EthNetworks) {
    this.currentNetwork = network;
  }

  @mutation setBancorApiTokens(tokens: TokenPrice[]) {
    this.bancorApiTokens = tokens;
  }

  lockedBalancesArr: LockedBalance[] = [];

  get lockedEth() {
    return this.lockedBalancesArr;
  }

  @mutation setLockedBalances(lockedBalances: LockedBalance[]) {
    this.lockedBalancesArr = lockedBalances;
  }

  @mutation setLoadingPositions(value: boolean) {
    this.loadingProtectedPositions = value;
  }

  @action async fetchLockedBalances(storeAddress?: string) {
    const owner = this.isAuthenticated;
    if (!owner) return;

    const contractAddress =
      storeAddress || this.contracts.LiquidityProtectionStore;
    const storeContract = buildLiquidityProtectionStoreContract(
      contractAddress
    );
    const lockedBalanceCount = Number(
      await storeContract.methods.lockedBalanceCount(owner).call()
    );

    const lockedBalances =
      lockedBalanceCount > 0
        ? await traverseLockedBalances(
            contractAddress,
            owner,
            lockedBalanceCount
          )
        : [];
    this.setLockedBalances(lockedBalances);

    return lockedBalances;
  }

  loadingProtectedPositions = true;

  get protectedLiquidity(): ViewProtectedLiquidity[] {
    const { minDelay, maxDelay } = this.liquidityProtectionSettings;
    const allowSingles = vxm.general.phase2;

    console.log(this.protectedPositionsArr, "was thing");
    const allPositions = this.protectedPositionsArr
      .filter(position => compareString(position.owner, this.isAuthenticated))
      .filter(position =>
        this.whiteListedPools.some(anchor =>
          compareString(position.poolToken, anchor)
        )
      );
    // this filter of removing white listed pools shouldn't stick around forever as it just kills any positions that might exist on non-whitelisted pools
    // in the event a white listed pool runs, LP creates a position then gov kills it
    // filter currently in place to clean up existing positions on ropsten essentially.

    const seperatedEntries = uniqWith(allPositions, samePointOfEntry);

    const joined = seperatedEntries.map(entry =>
      allPositions.filter(position => samePointOfEntry(position, entry))
    );
    const allFoundAtLeastOne = joined.every(
      entries => entries.length > 0 && entries.length < 3
    );
    console.log({ seperatedEntries, joined, allFoundAtLeastOne }, "xp");
    if (!allFoundAtLeastOne)
      throw new Error("Failed finding at least one entry or found above 2");

    const [singlesArr, doublesArr] = partition(
      joined,
      entries => entries.length == 1
    );

    const reviewedSingles = singlesArr
      .filter(() => allowSingles)
      .map(x => x[0])
      .map(
        (singleEntry): ViewProtectedLiquidity => {
          const isWhiteListed = this.whiteListedPools.some(whitelistedAnchor =>
            compareString(singleEntry.poolToken, whitelistedAnchor)
          );

          const startTime = Number(singleEntry.timestamp);
          const relay = findOrThrow(this.relaysList, relay =>
            compareString(relay.id, singleEntry.poolToken)
          );

          const reserveToken = this.token(singleEntry.reserveToken);
          const reservePrecision = reserveToken.precision;

          const reserveTokenDec = shrinkToken(
            singleEntry.reserveAmount,
            reservePrecision
          );

          const fullyProtectedDec = shrinkToken(
            singleEntry.liquidityReturn.targetAmount,
            reservePrecision
          );
          const protectionAchieved = calculateProtectionLevel(
            startTime,
            minDelay,
            maxDelay
          );

          return {
            id: `${singleEntry.poolToken}:${singleEntry.id}`,
            whitelisted: isWhiteListed,
            stake: {
              amount: reserveTokenDec,
              symbol: reserveToken.symbol,
              poolId: relay.id,
              unixTime: startTime,
              ...(reserveToken.price && {
                usdValue: new BigNumber(reserveTokenDec)
                  .times(reserveToken.price)
                  .toNumber()
              })
            },
            single: true,
            apr: {
              day: Number(singleEntry.oneDayDec)
              // month: Number(singleEntry.oneMonthDec),
              // week: Number(singleEntry.oneWeekDec)
            },
            insuranceStart: startTime + minDelay,
            fullCoverage: startTime + maxDelay,
            fullyProtected: {
              amount: fullyProtectedDec
            },
            protectedAmount: {
              amount: new BigNumber(fullyProtectedDec)
                .times(protectionAchieved)
                .toString(),
              symbol: reserveToken.symbol,
              ...(reserveToken.price && {
                usdValue: new BigNumber(fullyProtectedDec)
                  .times(reserveToken.price!)
                  .toNumber()
              })
            },
            coverageDecPercent: protectionAchieved,
            roi: Number(
              calculatePercentIncrease(reserveTokenDec, fullyProtectedDec)
            )
          } as ViewProtectedLiquidity;
        }
      );

    const reviewedDoubles = doublesArr
      .filter(double =>
        this.relays.some(relay => compareString(relay.id, double[0].poolToken))
      )
      .flatMap((doubles): ViewProtectedLiquidity | ViewProtectedLiquidity[] => {
        const first = doubles[0];
        const commonPoolToken = first.poolToken;
        const commonViewRelay = this.relay(commonPoolToken);
        const commonRelay = findOrThrow(this.relaysList, relay =>
          compareString(relay.id, commonPoolToken)
        );
        const isWhiteListed = this.whiteListedPools.some(whitelistedAnchor =>
          compareString(commonPoolToken, whitelistedAnchor)
        );

        const startTime = Number(first.timestamp);
        if (allowSingles) {
          return doubles.map(
            (singleEntry): ViewProtectedLiquidity => {
              const isWhiteListed = this.whiteListedPools.some(
                whitelistedAnchor =>
                  compareString(singleEntry.poolToken, whitelistedAnchor)
              );

              const startTime = Number(singleEntry.timestamp);
              const relay = findOrThrow(this.relaysList, relay =>
                compareString(relay.id, singleEntry.poolToken)
              );
              const smartToken = relay.anchor as SmartToken;
              const smartTokensWei = singleEntry.reserveAmount;
              const smartTokensDec = shrinkToken(
                smartTokensWei,
                smartToken.decimals
              );

              const reserveToken = this.token(singleEntry.reserveToken);
              const reservePrecision = reserveToken.precision;

              const reserveTokenDec = shrinkToken(
                singleEntry.reserveAmount,
                reserveToken.precision
              );

              const fullyProtectedDec = shrinkToken(
                singleEntry.liquidityReturn.targetAmount,
                reservePrecision
              );
              const protectionAchieved = calculateProtectionLevel(
                startTime,
                minDelay,
                maxDelay
              );

              console.log("oneDayDec", singleEntry.oneDayDec);

              return {
                id: `${singleEntry.poolToken}:${singleEntry.id}`,
                whitelisted: isWhiteListed,
                stake: {
                  amount: smartTokensDec,
                  symbol: reserveToken.symbol,
                  poolId: relay.id,
                  unixTime: startTime,
                  ...(reserveToken.price && {
                    usdValue: new BigNumber(reserveTokenDec)
                      .times(reserveToken.price!)
                      .toNumber()
                  })
                },
                fullyProtected: {
                  amount: "1.23"
                },
                protectedAmount: {
                  amount: fullyProtectedDec,
                  symbol: reserveToken.symbol,
                  ...(reserveToken.price && {
                    usdValue: new BigNumber(fullyProtectedDec)
                      .times(reserveToken.price!)
                      .toNumber()
                  })
                },
                apr: {
                  day: Number(singleEntry.oneDayDec)
                  // month: Number(singleEntry.oneMonthDec),
                  // week: Number(singleEntry.oneWeekDec)
                },
                single: true,
                insuranceStart: startTime + minDelay,
                fullCoverage: startTime + maxDelay,
                coverageDecPercent: calculateProtectionLevel(
                  startTime,
                  minDelay,
                  maxDelay
                ),
                roi: Number(
                  calculatePercentIncrease(reserveTokenDec, fullyProtectedDec)
                )
              } as ViewProtectedLiquidity;
            }
          );
        } else {
          const smartToken = commonRelay.anchor as SmartToken;
          const smartTokensWei = doubles
            .reduce(
              (acc, item) => new BigNumber(item.poolAmount).plus(acc),
              new BigNumber(0)
            )
            .toString();
          const smartTokensDec = shrinkToken(
            smartTokensWei,
            smartToken.decimals
          );

          const bntAddress = getNetworkVariables(this.currentNetwork).bntToken;

          const givenVBnt = shrinkToken(
            doubles.find(position =>
              compareString(bntAddress, position.reserveToken)
            )!.reserveAmount,
            18
          );

          return {
            id: `${commonPoolToken}:${doubles.map(pos => pos.id).join(":")}`,
            whitelisted: isWhiteListed,
            stake: {
              amount: smartTokensDec,
              symbol: smartToken.symbol,
              poolId: commonViewRelay.id,
              unixTime: startTime
            },
            apr: {
              day: 0,
              month: 0,
              week: 0
            },
            insuranceStart: startTime + minDelay,
            single: false,
            fullCoverage: startTime + maxDelay,
            fullyProtected: {
              amount: "12345.6789"
            },
            protectedAmount: {
              amount: smartTokensDec,
              symbol: smartToken.symbol
            },
            coverageDecPercent: calculateProtectionLevel(
              startTime,
              minDelay,
              maxDelay
            ),
            roi: Number(
              calculatePercentIncrease(smartTokensDec, smartTokensDec)
            ),
            givenVBnt
          } as ViewProtectedLiquidity;
        }
      });

    console.log({ reviewedDoubles, reviewedSingles });
    return [...reviewedDoubles, ...reviewedSingles];
  }

  get poolTokenPositions(): PoolTokenPosition[] {
    const allIouTokens = this.relaysList.flatMap(iouTokensInRelay);
    const existingBalances = this.tokenBalances.filter(
      balance =>
        balance.balance !== "0" &&
        allIouTokens.some(iouToken =>
          compareString(balance.id, iouToken.contract)
        )
    );

    const relevantRelays = this.relaysList.filter(relay =>
      iouTokensInRelay(relay).some(token =>
        existingBalances.some(balance =>
          compareString(balance.id, token.contract)
        )
      )
    );

    return relevantRelays.map(relay => {
      const anchorTokens = iouTokensInRelay(relay);
      const iouTokens = existingBalances.filter(existingBalance =>
        anchorTokens.some(anchor =>
          compareString(existingBalance.id, anchor.contract)
        )
      );

      const viewRelay = this.relay(relay.id);
      const isV1 = relay.converterType == PoolType.Traditional;
      if (isV1) {
        return {
          relay: viewRelay,
          smartTokenAmount: iouTokens[0].balance
        };
      } else {
        const chainkLinkRelay = relay as ChainLinkRelay;
        const reserveBalances = iouTokens.map(iouToken => {
          const relevantPoolTokenData = chainkLinkRelay.anchor.poolTokens.find(
            poolToken =>
              compareString(poolToken.poolToken.contract, iouToken.id)
          )!;
          return {
            balance: iouToken.balance,
            reserveId: relevantPoolTokenData.reserveId
          };
        });
        return {
          relay: viewRelay,
          poolTokens: reserveBalances
        };
      }
    });
  }

  get morePoolsAvailable() {
    const allPools = this.registeredAnchorAddresses;
    const remainingPools = allPools
      .filter(
        poolAddress =>
          !this.relaysList.some(relay => compareString(poolAddress, relay.id))
      )
      .filter(
        poolAddress =>
          !this.failedPools.some(failedPool =>
            compareString(failedPool, poolAddress)
          )
      );
    return remainingPools.length > 0;
  }

  get currentEthNetwork() {
    return vxm.ethWallet.currentNetwork as EthNetworks;
  }

  @mutation setLoadingPools(status: boolean) {
    this.loadingPools = status;
  }

  @mutation updateFailedPools(ids: string[]) {
    this.failedPools = uniqWith([...this.failedPools, ...ids], compareString);
  }

  @action async loadMorePools() {
    this.setLoadingPools(true);
    const remainingAnchorAddresses = this.registeredAnchorAddresses
      .filter(
        address =>
          !this.relaysList.some(relay => compareString(relay.id, address))
      )
      .filter(
        address =>
          !this.failedPools.some(failedPoolAddress =>
            compareString(address, failedPoolAddress)
          )
      );

    if (remainingAnchorAddresses && remainingAnchorAddresses.length > 0) {
      const remainingPools = await this.add(remainingAnchorAddresses);

      await this.addPoolsBulk(remainingPools);
    }
    this.setLoadingPools(false);
  }

  get secondaryReserveChoices(): ModalChoice[] {
    return this.newNetworkTokenChoices;
  }

  get primaryReserveChoices() {
    return (secondaryReserveId: string): ModalChoice[] => {
      const metaTokens = this.tokenMeta.filter(
        meta => !compareString(meta.id, secondaryReserveId)
      );
      const modalChoices = metaTokens.map(metaToModalChoice);
      const balances = this.tokenBalances;
      const tokensWithBalances = updateArray(
        modalChoices,
        token => balances.some(balance => compareString(balance.id, token.id)),
        token => ({
          ...token,
          balance: findOrThrow(balances, balance =>
            compareString(balance.id, token.id)
          ).balance
        })
      );

      return sortAlongSide(
        tokensWithBalances,
        choice => choice.id.toLowerCase(),
        this.tokens.map(token => token.id.toLowerCase())
      );
    };
  }

  get newNetworkTokenChoices(): ModalChoice[] {
    const toOffer = [
      { symbolName: "BNT", value: this.bntUsdPrice },
      { symbolName: "USDB", value: 1 }
    ];

    const addedMeta = toOffer
      .map(offer => ({
        ...offer,
        meta: this.tokenMeta.find(meta =>
          compareString(meta.symbol, offer.symbolName)
        )!
      }))
      .filter(offer => offer.meta);

    return addedMeta.map(meta => {
      const balance = this.tokenBalance(meta.meta.contract);
      const stringBalance =
        balance && new BigNumber(balance.balance).toString();
      return {
        id: meta.meta.id,
        contract: meta.meta.contract,
        img: meta.meta.image,
        symbol: meta.meta.symbol,
        balance: stringBalance,
        usdValue: meta.value
      };
    });
  }

  get newPoolTokenChoices() {
    return (networkToken: string): ModalChoice[] => {
      const tokenChoices = this.tokenMeta
        .map(meta => metaToModalChoice(meta))
        .map(modalChoice => {
          const balance = this.tokenBalance(modalChoice.contract);
          const stringBalance =
            balance && new BigNumber(balance.balance).toString();
          return {
            ...modalChoice,
            balance: stringBalance
          };
        })
        .filter(meta =>
          this.newNetworkTokenChoices.some(
            networkChoice => !compareString(networkChoice.id, meta.id)
          )
        )
        .filter(tokenChoice => tokenChoice.id !== networkToken)
        .filter(meta => {
          const suggestedReserveIds = [meta.id, networkToken];
          const existingRelayWithSameReserves = this.relaysList.some(relay => {
            const reserves = relay.reserves.map(reserve => reserve.contract);
            return suggestedReserveIds.every(id =>
              reserves.some(r => compareString(id, r))
            );
          });
          return !existingRelayWithSameReserves;
        })
        .filter((_, index) => index < 200);

      const sorted = sortAlongSide(
        tokenChoices,
        token => token.id.toLowerCase(),
        this.tokens.map(token => token.id.toLowerCase())
      ).sort((a, b) => Number(b.balance) - Number(a.balance));
      return sorted;
    };
  }

  get isAuthenticated() {
    return vxm.wallet.isAuthenticated;
  }

  @mutation moduleInitiated() {
    this.initiated = true;
  }

  @action async fetchNewConverterAddressFromHash(
    hash: string
  ): Promise<string> {
    const interval = 1000;
    const attempts = 10;

    for (let i = 0; i < attempts; i++) {
      const info = await web3.eth.getTransactionReceipt(hash);
      if (info) {
        return removeLeadingZeros(info.logs[0].address);
      }
      await wait(interval);
    }
    throw new Error("Failed to find new address in decent time");
  }

  @action async fetchNewSmartContractAddressFromHash(
    hash: string
  ): Promise<string> {
    const interval = 1000;
    const attempts = 10;

    for (let i = 0; i < attempts; i++) {
      const info = await web3.eth.getTransactionReceipt(hash);
      console.log(info, "was info");
      if (info) {
        return info.contractAddress!;
      }
      await wait(interval);
    }
    throw new Error("Failed to find new address in decent time");
  }

  @mutation resetData() {
    this.relaysList = [];
    this.tokenBalances = [];
    this.initiated = false;
  }

  @action async onNetworkChange(updatedNetwork: EthNetworks) {
    if (this.currentNetwork !== updatedNetwork) {
      this.resetData();
      this.init();
    }
  }

  @action async deployConverter({
    smartTokenName,
    smartTokenSymbol,
    reserveTokenAddresses,
    precision = 18
  }: {
    smartTokenName: string;
    smartTokenSymbol: string;
    reserveTokenAddresses: string[];
    precision?: number;
  }): Promise<string> {
    if (reserveTokenAddresses.length !== 2)
      throw new Error("Method deployConverter only supports 2 reserves");
    const contract = buildRegistryContract(
      this.contracts.BancorConverterRegistry
    );

    const smartTokenDecimals = precision;

    return this.resolveTxOnConfirmation({
      tx: contract.methods.newConverter(
        1,
        smartTokenName,
        smartTokenSymbol,
        smartTokenDecimals,
        50000,
        reserveTokenAddresses,
        ["500000", "500000"]
      )
    });
  }

  @action async deployV1Converter({
    poolTokenName,
    poolTokenSymbol,
    poolTokenPrecision,
    reserves
  }: {
    poolTokenName: string;
    poolTokenSymbol: string;
    poolTokenPrecision: number;
    reserves: { contract: string; ppmReserveWeight: string }[];
  }): Promise<string> {
    if (reserves.length == 0) throw new Error("Must have at least one reserve");
    const converterRegistryAddress = this.contracts.BancorConverterRegistry;
    const contract = buildRegistryContract(converterRegistryAddress);

    const reserveTokenAddresses = reserves.map(reserve => reserve.contract);
    const reserveWeights = reserves.map(reserve => reserve.ppmReserveWeight);

    const poolType = PoolType.Traditional;

    const poolAlreadyExists = await existingPool(
      converterRegistryAddress,
      poolType,
      reserveTokenAddresses,
      reserveWeights
    );
    if (poolAlreadyExists)
      throw new Error(`Similar pool already exists (${poolAlreadyExists})`);

    return this.resolveTxOnConfirmation({
      tx: contract.methods.newConverter(
        poolType,
        poolTokenName,
        poolTokenSymbol,
        poolTokenPrecision,
        50000,
        reserveTokenAddresses,
        reserveWeights
      )
    });
  }

  @action async fetchHistoryData(poolId: string) {
    const pool = await this.relayById(poolId);
    const reserveSymbols = pool.reserves.map(reserve => reserve.symbol);
    const sortedSymbols = sortByNetworkTokens(reserveSymbols, x => x);
    const [networkToken, primaryReserveToken] = sortedSymbols;
    return getSmartTokenHistory(primaryReserveToken.toLowerCase());
  }

  @action async createV1Pool({
    onUpdate,
    decFee,
    decimals,
    poolName,
    poolSymbol,
    reserves
  }: CreateV1PoolEthParams): Promise<V1PoolResponse> {
    const hasFee = new BigNumber(decFee).isGreaterThan(0);

    const {
      poolId,
      newConverterTx
    }: { poolId: string; newConverterTx: string } = await multiSteps({
      items: [
        {
          description: "Creating pool...",
          task: async () => {
            const converterRes = await this.deployV1Converter({
              reserves: reserves.map(reserve => ({
                contract: reserve.tokenId,
                ppmReserveWeight: decToPpm(reserve.decReserveWeight)
              })),
              poolTokenName: poolName,
              poolTokenSymbol: poolSymbol,
              poolTokenPrecision: decimals
            });

            const converterAddress = await this.fetchNewConverterAddressFromHash(
              converterRes
            );
            return { converterAddress, newConverterTx: converterRes };
          }
        },
        {
          description: "Transferring ownership...",
          task: async ({ converterAddress, newConverterTx }) => {
            await this.claimOwnership(converterAddress);
            return { converterAddress, newConverterTx };
          }
        },
        ...(hasFee
          ? [
              {
                description: "Setting fee...",
                task: async ({
                  converterAddress,
                  newConverterTx
                }: {
                  converterAddress: string;
                  newConverterTx: string;
                }) => {
                  await this.setFee({
                    converterAddress,
                    ppmFee: decToPpm(decFee)
                  });
                  return { converterAddress, newConverterTx };
                }
              }
            ]
          : []),
        {
          description: "Adding pool...",
          task: async ({
            converterAddress,
            newConverterTx
          }: {
            converterAddress: string;
            newConverterTx: string;
          }) => {
            const registeredAnchorAddresses = await this.fetchAnchorAddresses(
              this.contracts.BancorConverterRegistry
            );
            const convertersAndAnchors = await this.add(
              registeredAnchorAddresses
            );
            const converterAndAnchor = findOrThrow(
              convertersAndAnchors,
              converterAndAnchor =>
                compareString(
                  converterAndAnchor.converterAddress,
                  converterAddress
                ),
              "failed to find new pool in the contract registry"
            );
            await this.addPoolsBulk([converterAndAnchor]);
            return { newConverterTx, poolId: converterAndAnchor.anchorAddress };
          }
        }
      ],
      onUpdate
    });

    return {
      txId: newConverterTx,
      blockExplorerLink: await this.createExplorerLink(newConverterTx),
      poolId
    };
  }

  @action async createExplorerLink(txHash: string) {
    return generateEtherscanTxLink(
      txHash,
      this.currentNetwork == EthNetworks.Ropsten
    );
  }

  @action async approveTokenWithdrawals(
    approvals: {
      approvedAddress: string;
      amount: string;
      tokenAddress: string;
    }[]
  ) {
    return Promise.all(
      approvals.map(approval => {
        const tokenContract = buildTokenContract(approval.tokenAddress);

        return this.resolveTxOnConfirmation({
          tx: tokenContract.methods.approve(
            approval.approvedAddress,
            approval.amount
          ),
          gas: 70000
        });
      })
    );
  }

  @action async claimBnt(): Promise<TxResponse> {
    const contract = buildLiquidityProtectionContract(
      this.contracts.LiquidityProtection
    );

    const now = moment();
    const availableClaims = this.lockedBalancesArr
      .filter(balance => moment.unix(balance.expirationTime).isBefore(now))
      .sort((a, b) => a.index - b.index);

    const chunked = chunk(availableClaims, 5);
    const txRes = await Promise.all(
      chunked.map(arr => {
        const first = arr[0].index;
        const last = arr[arr.length - 1].index;
        return this.resolveTxOnConfirmation({
          tx: contract.methods.claimBalance(String(first), String(50))
        });
      })
    );
    const hash = last(txRes) as string;

    const bntAddress = getNetworkVariables(this.currentNetwork).bntToken;
    this.spamBalances([bntAddress]);

    (async () => {
      await wait(2000);
      this.fetchLockedBalances();
    })();
    this.fetchLockedBalances();

    return {
      blockExplorerLink: await this.createExplorerLink(hash),
      txId: hash
    };
  }

  @action async claimOwnership(converterAddress: string) {
    const converter = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converter.methods.acceptOwnership()
    });
  }

  @action async setFee({
    converterAddress,
    ppmFee
  }: {
    converterAddress: string;
    ppmFee: string;
  }) {
    const converterContract = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converterContract.methods.setConversionFee(ppmFee),
      resolveImmediately: true
    });
  }

  @action async resolveTxOnConfirmation({
    tx,
    gas,
    value,
    resolveImmediately = false,
    onHash
  }: {
    tx: ContractSendMethod;
    value?: string;
    gas?: number;
    resolveImmediately?: boolean;
    onHash?: (hash: string) => void;
  }): Promise<string> {
    console.log("received", tx);
    return new Promise((resolve, reject) => {
      let txHash: string;
      tx.send({
        from: this.isAuthenticated,
        ...(gas && { gas }),
        ...(value && { value: toHex(value) })
      })
        .on("transactionHash", (hash: string) => {
          txHash = hash;
          if (onHash) onHash(hash);
          if (resolveImmediately) {
            resolve(txHash);
          }
        })
        .on("confirmation", (confirmationNumber: number) => {
          resolve(txHash);
        })
        .on("error", (error: any) => reject(error));
    });
  }

  @action async addReserveToken({
    converterAddress,
    reserveTokenAddress
  }: {
    converterAddress: string;
    reserveTokenAddress: string;
  }) {
    const converter = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converter.methods.addReserve(reserveTokenAddress, 500000)
    });
  }

  get supportedFeatures() {
    return (symbolName: string) => {
      return ["addLiquidity", "removeLiquidity"];
    };
  }

  get wallet() {
    return "eth";
  }

  get tokens(): ViewToken[] {
    console.time("tokens");
    const ret = this.relaysList
      .filter(relay =>
        relay.reserves.every(reserve => reserve.reserveFeed && reserve.meta)
      )
      .flatMap(relay =>
        relay.reserves.map(reserve => {
          const { logo, name } = reserve.meta!;
          const balance = this.tokenBalance(reserve.contract);
          const balanceString =
            balance && new BigNumber(balance.balance).toString();

          const reserveFeed = reserve.reserveFeed!;
          return {
            id: reserve.contract,
            contract: reserve.contract,
            precision: reserve.decimals,
            symbol: reserve.symbol,
            name: name || reserve.symbol,
            ...(reserveFeed.costByNetworkUsd && {
              price: reserveFeed.costByNetworkUsd
            }),
            liqDepth: reserveFeed.liqDepth,
            logo,
            ...(reserveFeed.change24H && { change24h: reserveFeed.change24H }),
            ...(reserveFeed.volume24H && { volume24h: reserveFeed.volume24H }),
            ...(balance && { balance: balanceString })
          };
        })
      )
      .sort(sortByLiqDepth)
      .reduce<ViewToken[]>((acc, item) => {
        const existingToken = acc.find(token =>
          compareString(token.id!, item.id)
        );
        return existingToken
          ? updateArray(
              acc,
              token =>
                compareString(token.id!, item.id) && !isNaN(item.liqDepth),
              token => ({ ...token, liqDepth: token.liqDepth! + item.liqDepth })
            )
          : [...acc, item as ViewToken];
      }, []);
    console.timeEnd("tokens");
    return ret;
  }

  get tokenMetaObj() {
    return (id: string) => {
      return findOrThrow(
        this.tokenMeta,
        meta => compareString(id, meta.id),
        `Failed to find token meta for symbol with token contract of ${id}`
      );
    };
  }

  get tokenBalance() {
    return (tokenId: string) =>
      this.tokenBalances.find(token => compareString(token.id, tokenId));
  }

  get token(): (arg0: string) => ViewToken {
    return (id: string) =>
      findOrThrow(
        this.tokens,
        token => compareString(token.id, id),
        `failed to find token() with ID ${id} ethBancor`
      );
  }

  get relay() {
    return (id: string) =>
      findOrThrow(
        this.relays,
        relay => compareString(relay.id, id),
        `failed to find relay with id of ${id} in eth relay getter`
      );
  }

  get relays(): ViewRelay[] {
    console.time("relays");
    const toReturn = [...this.chainkLinkRelays, ...this.traditionalRelays]
      .sort(sortByLiqDepth)
      .sort(prioritiseV2Pools);

    console.timeEnd("relays");
    return toReturn;
  }

  get chainkLinkRelays(): ViewRelay[] {
    return (this.relaysList.filter(isChainLink) as ChainLinkRelay[])
      .filter(relay =>
        relay.reserves.every(reserve => reserve.reserveFeed && reserve.meta)
      )
      .map(relay => {
        const [networkReserve, tokenReserve] = relay.reserves;

        const { poolContainerAddress } = relay.anchor;

        return {
          id: poolContainerAddress,
          version: Number(relay.version),
          reserves: relay.reserves.map(reserve => ({
            reserveWeight: reserve.reserveWeight,
            id: reserve.contract,
            reserveId: poolContainerAddress + reserve.contract,
            logo: [reserve.meta!.logo],
            symbol: reserve.symbol,
            contract: reserve.contract,
            smartTokenSymbol: poolContainerAddress
          })),
          fee: relay.fee / 100,
          liqDepth: relay.reserves.reduce(
            (acc, item) => acc + item.reserveFeed!.liqDepth,
            0
          ),
          owner: relay.owner,
          symbol: tokenReserve.symbol,
          addLiquiditySupported: true,
          removeLiquiditySupported: true,
          whitelisted: false,
          liquidityProtection: false,
          focusAvailable: false,
          v2: true
        } as ViewRelay;
      });
  }

  get traditionalRelays(): ViewRelay[] {
    const availableHistories = this.availableHistories;

    const whiteListedPools = this.whiteListedPools;

    return (this.relaysList.filter(isTraditional) as TraditionalRelay[])
      .filter(relay =>
        relay.reserves.every(reserve => reserve.reserveFeed && reserve.meta)
      )
      .map(relay => {
        const [networkReserve, tokenReserve] = relay.reserves;

        const smartTokenSymbol = relay.anchor.symbol;
        const hasHistory = availableHistories.some(history =>
          compareString(smartTokenSymbol, history)
        );

        let liqDepth = relay.reserves.reduce(
          (acc, item) => acc + item.reserveFeed!.liqDepth,
          0
        );

        if (Number.isNaN(liqDepth)) {
          liqDepth = 0;
        }

        const whitelisted = whiteListedPools.some(whitelistedAnchor =>
          compareString(whitelistedAnchor, relay.anchor.contract)
        );

        const liquidityProtection =
          relay.reserves.some(reserve =>
            compareString(
              reserve.contract,
              this.liquidityProtectionSettings.networkToken
            )
          ) &&
          relay.reserves.length == 2 &&
          relay.reserves.every(reserve => reserve.reserveWeight == 0.5) &&
          Number(relay.version) >= 41 &&
          whitelisted;

        return {
          id: relay.anchor.contract,
          version: Number(relay.version),
          reserves: relay.reserves.map(reserve => ({
            id: reserve.contract,
            reserveWeight: reserve.reserveWeight,
            reserveId: relay.anchor.contract + reserve.contract,
            logo: [reserve.meta!.logo],
            symbol: reserve.symbol,
            contract: reserve.contract,
            smartTokenSymbol: relay.anchor.contract
          })),
          fee: relay.fee / 100,
          liqDepth,
          owner: relay.owner,
          symbol: tokenReserve.symbol,
          addLiquiditySupported: true,
          removeLiquiditySupported: true,
          liquidityProtection,
          whitelisted,
          focusAvailable: hasHistory,
          v2: false
        } as ViewRelay;
      });
  }

  @action async getGeometricMean(amounts: string[]) {
    const converter = buildConverterContract(
      getNetworkVariables(this.currentNetwork).converterContractForMaths
    );
    return converter.methods.geometricMean(amounts).call();
  }

  @mutation setTokenMeta(tokenMeta: TokenMeta[]) {
    this.tokenMeta = tokenMeta;
  }

  @action async triggerTx(actions: any[]) {
    // @ts-ignore
    return this.$store.dispatch("ethWallet/tx", actions, { root: true });
  }

  @action async fetchRelayBalances({
    poolId,
    blockHeight
  }: {
    poolId: string;
    blockHeight?: number;
  }) {
    const { reserves, version, contract } = await this.relayById(poolId);

    const converterContract = buildConverterContract(contract);
    const smartTokenContract = buildTokenContract(poolId);

    const requestAtParticularBlock = typeof blockHeight !== undefined;

    const [reserveBalances, smartTokenSupplyWei] = await Promise.all([
      Promise.all(
        reserves.map(reserve =>
          fetchReserveBalance(
            converterContract,
            reserve.contract,
            version,
            blockHeight
          )
        )
      ),
      requestAtParticularBlock
        ? // @ts-ignore
          smartTokenContract.methods.totalSupply().call(null, blockHeight)
        : smartTokenContract.methods.totalSupply().call()
    ]);

    return {
      reserves: reserves.map((reserve, index) => ({
        ...reserve,
        weiAmount: reserveBalances[index]
      })),
      smartTokenSupplyWei
    };
  }

  @action async calculateOpposingDepositInfo(
    opposingDeposit: OpposingLiquidParams
  ): Promise<EthOpposingLiquid> {
    const {
      id,
      reserves: reservesViewAmounts,
      changedReserveId
    } = opposingDeposit;
    const reserve = findChangedReserve(reservesViewAmounts, changedReserveId);

    const relay = await this.traditionalRelayById(id);

    const reserveToken = await this.tokenById(reserve.id);

    const tokenSymbol = reserveToken.symbol;
    const tokenAmount = reserve.amount;

    const smartTokenAddress = relay.anchor.contract;
    const smartTokenDecimals = relay.anchor.decimals;

    this.getUserBalance({ tokenContractAddress: smartTokenAddress });
    const { reserves, smartTokenSupplyWei } = await this.fetchRelayBalances({
      poolId: smartTokenAddress
    });

    const [sameReserve, opposingReserve] = sortByNetworkTokens(
      reserves,
      reserve => reserve.symbol,
      [tokenSymbol]
    );

    const reserveBalancesAboveZero = reserves.every(reserve =>
      new BigNumber(reserve.weiAmount).gt(0)
    );
    const sameReserveWei = expandToken(tokenAmount, sameReserve.decimals);

    const userSmartTokenBalance = this.tokenBalances.find(balance =>
      compareString(balance.id, smartTokenAddress)
    );

    const userSmartTokenBalanceWei =
      userSmartTokenBalance &&
      new BigNumber(userSmartTokenBalance.balance).gt(0)
        ? expandToken(userSmartTokenBalance.balance, smartTokenDecimals)
        : "0";

    if (!reserveBalancesAboveZero) {
      const matchedInputs = reservesViewAmounts.map(viewAmount => ({
        decAmount: viewAmount.amount,
        decimals: findOrThrow(reserves, reserve =>
          compareString(reserve.contract, viewAmount.id)
        ).decimals
      }));

      const notAllInputsAreNumbers = matchedInputs.some(input =>
        new BigNumber(input.decAmount).isNaN()
      );
      if (notAllInputsAreNumbers) {
        return {
          shareOfPool: 0,
          smartTokenAmountWei: { amount: "1", id: smartTokenAddress },
          singleUnitCosts: [],
          opposingAmount: undefined,
          reserveBalancesAboveZero
        };
      }
      const weiInputs = matchedInputs.map(input =>
        expandToken(input.decAmount, input.decimals)
      );
      const fundReward = await this.getGeometricMean(weiInputs);
      console.log(fundReward, "was returned with geometric mean");

      const shareOfPool = calculateShareOfPool(
        fundReward,
        smartTokenSupplyWei,
        userSmartTokenBalanceWei
      );

      const singleUnitCosts =
        matchedInputs.length == 2
          ? buildSingleUnitCosts(reservesViewAmounts[0], reservesViewAmounts[1])
          : [];

      return {
        shareOfPool,
        smartTokenAmountWei: { amount: fundReward, id: smartTokenAddress },
        singleUnitCosts,
        opposingAmount: undefined,
        reserveBalancesAboveZero
      };
    }

    const opposingAmount = calculateOppositeFundRequirement(
      sameReserveWei,
      sameReserve.weiAmount,
      opposingReserve.weiAmount
    );
    const fundReward = calculateFundReward(
      sameReserveWei,
      sameReserve.weiAmount,
      smartTokenSupplyWei
    );

    const shareOfPool = calculateShareOfPool(
      fundReward,
      smartTokenSupplyWei,
      userSmartTokenBalanceWei
    );

    const opposingReserveSupplyDec = shrinkToken(
      opposingReserve.weiAmount,
      opposingReserve.decimals
    );
    const sameReserveSupplyDec = shrinkToken(
      sameReserve.weiAmount,
      sameReserve.decimals
    );

    const singleUnitCosts = buildSingleUnitCosts(
      { id: opposingReserve.contract, amount: opposingReserveSupplyDec },
      { id: sameReserve.contract, amount: sameReserveSupplyDec }
    );

    const res = {
      opposingAmount: shrinkToken(opposingAmount, opposingReserve.decimals),
      smartTokenAmountWei: { id: smartTokenAddress, amount: fundReward },
      shareOfPool,
      singleUnitCosts: sortAlongSide(
        singleUnitCosts,
        unitCost => unitCost.id,
        relay.reserves.map(reserve => reserve.contract)
      ),
      reserveBalancesAboveZero
    };
    return res;
  }

  @action async fetchV2PoolBalances(
    relay: ChainLinkRelay
  ): Promise<StakedAndReserve> {
    const [reserveOne, reserveTwo] = relay.reserves;
    const [[poolBalace]] = ((await this.multi([
      [
        v2PoolBalanceShape(
          relay.contract,
          reserveOne.contract,
          reserveTwo.contract
        )
      ]
    ])) as unknown) as [RawAbiV2PoolBalances][];

    return rawAbiV2ToStacked(poolBalace);
  }

  @action async calculateOpposingDepositV2(
    opposingDeposit: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.chainLinkRelayById(opposingDeposit.id);

    const changedReserve = findChangedReserve(
      opposingDeposit.reserves,
      opposingDeposit.changedReserveId
    );
    const suggestedDepositDec = changedReserve.amount;

    const stakedAndReserveWeight = await this.fetchV2PoolBalances(relay);

    const [biggerWeight, smallerWeight] = stakedAndReserveWeight.reserves
      .map(reserve => ({
        ...reserve,
        decReserveWeight: new BigNumber(reserve.reserveWeight as string).div(
          oneMillion
        ),
        token: findOrThrow(
          relay.reserves,
          r => compareString(r.contract, reserve.reserveAddress),
          "failed to find token for weight"
        )
      }))
      .sort((a, b) => b.decReserveWeight.minus(a.decReserveWeight).toNumber());

    const weightsEqualOneMillion = new BigNumber(
      biggerWeight.reserveWeight as string
    )
      .plus(smallerWeight.reserveWeight as string)
      .eq(oneMillion);
    if (!weightsEqualOneMillion)
      throw new Error("Was expecting reserve weights to equal 100%");
    const distanceFromMiddle = biggerWeight.decReserveWeight.minus(0.5);

    const adjustedBiggerWeight = new BigNumber(biggerWeight.stakedBalance).div(
      new BigNumber(1).minus(distanceFromMiddle)
    );
    const adjustedSmallerWeight = new BigNumber(
      smallerWeight.stakedBalance
    ).div(new BigNumber(1).plus(distanceFromMiddle));

    const singleUnitCosts = buildSingleUnitCosts(
      {
        id: biggerWeight.reserveAddress,
        amount: shrinkToken(
          adjustedBiggerWeight.toString(),
          biggerWeight.token.decimals
        )
      },
      {
        id: smallerWeight.reserveAddress,
        amount: shrinkToken(
          adjustedSmallerWeight.toString(),
          smallerWeight.token.decimals
        )
      }
    );

    const sameReserve = findOrThrow(
      [biggerWeight, smallerWeight],
      weight => compareString(weight.reserveAddress, changedReserve.id),
      "failed to find same reserve"
    );

    const suggestedDepositWei = expandToken(
      suggestedDepositDec,
      sameReserve.token.decimals
    );

    const shareOfPool = new BigNumber(suggestedDepositWei)
      .div(sameReserve.stakedBalance)
      .toNumber();

    const v2Converter = buildV2Converter(relay.contract);
    const maxStakingEnabled = await v2Converter.methods
      .maxStakedBalanceEnabled()
      .call();
    console.log({ maxStakingEnabled });
    if (maxStakingEnabled) {
      const maxStakedBalance = await v2Converter.methods
        .maxStakedBalances(sameReserve.reserveAddress)
        .call();

      console.log({ maxStakedBalance });
      if (maxStakedBalance !== "0") {
        const currentBalance = new BigNumber(sameReserve.stakedBalance);
        const proposedTotalBalance = new BigNumber(suggestedDepositWei).plus(
          currentBalance
        );
        const maxStakedBalanceWei = new BigNumber(maxStakedBalance);
        if (proposedTotalBalance.gt(maxStakedBalanceWei)) {
          const remainingSpaceAvailableWei = maxStakedBalanceWei.minus(
            currentBalance
          );
          const remainingSpaceAvailableDec = shrinkToken(
            remainingSpaceAvailableWei.toString(),
            sameReserve.token.decimals
          );
          if (remainingSpaceAvailableWei.isLessThanOrEqualTo(0))
            throw new Error("This pool has reached the max liquidity cap");
          throw new Error(
            `This pool is currently capped and can receive ${remainingSpaceAvailableDec} additional tokens`
          );
        }
      }
    }

    const result = {
      opposingAmount: undefined,
      shareOfPool,
      singleUnitCosts
    };
    console.log(result, "was the result");
    return result;
  }

  @action async fetchSystemBalance(tokenAddress: string): Promise<string> {
    const isValidAddress = web3.utils.isAddress(tokenAddress);
    if (!isValidAddress)
      throw new Error(`${tokenAddress} is not a valid address`);
    const contract = buildLiquidityProtectionStoreContract(
      this.contracts.LiquidityProtectionStore
    );
    return contract.methods.systemBalance(tokenAddress).call();
  }

  @action async calculateProtectionNetworkToken({
    poolId,
    reserveAmount
  }: {
    poolId: string;
    reserveAmount: ViewAmount;
  }): Promise<ProtectionRes> {
    console.log("network token called");
    const reserveToken = this.token(reserveAmount.id);

    const [balances, poolTokenBalance] = await Promise.all([
      this.fetchRelayBalances({ poolId }),
      this.fetchSystemBalance(poolId)
    ]);

    if (new BigNumber(poolTokenBalance).eq(0)) {
      return {
        outputs: [],
        error: "Insufficient store balance"
      };
    }

    const liquidityProtectionNetworkBalance = findOrThrow(
      balances.reserves,
      reserve =>
        compareString(
          reserve.contract,
          this.liquidityProtectionSettings.networkToken
        ),
      "failed finding liquidity protection network token in reserve balances"
    );
    const bntValueOfPoolTokens = new BigNumber(poolTokenBalance).times(
      new BigNumber(liquidityProtectionNetworkBalance.weiAmount).div(
        balances.smartTokenSupplyWei
      )
    );

    const inputAmountWei = expandToken(
      reserveAmount.amount,
      reserveToken.precision
    );

    const notEnoughInStore =
      new BigNumber(inputAmountWei).isGreaterThan(bntValueOfPoolTokens) ||
      bntValueOfPoolTokens.isLessThan(10000000000000000);

    return {
      outputs: [],
      ...(notEnoughInStore && { error: "Insufficient store balance" })
    };
  }

  @action async calculateProtectionBaseToken({
    poolId,
    reserveAmount
  }: {
    poolId: string;
    reserveAmount: ViewAmount;
  }): Promise<ProtectionRes> {
    const reserveToken = this.token(reserveAmount.id);
    const [balances, poolTokenBalance] = await Promise.all([
      this.fetchRelayBalances({ poolId }),
      this.fetchSystemBalance(reserveToken.contract)
    ]);

    const networkTokenAddress = this.liquidityProtectionSettings.networkToken;
    const networkAmountWei = expandToken(reserveAmount.amount, 18);

    const networkReserve = findOrThrow(
      balances.reserves,
      reserve => compareString(reserve.contract, networkTokenAddress),
      "failed finding network token in pool balances"
    );
    const networkBalanceWei = networkReserve.weiAmount;
    const baseReserve = findOrThrow(
      balances.reserves,
      reserve => !compareString(reserve.contract, networkTokenAddress),
      "failed finding base token in pool balances"
    );
    const baseBalanceWei = baseReserve.weiAmount;

    const networkTokensToBeMinted = new BigNumber(networkAmountWei)
      .times(networkBalanceWei)
      .div(baseBalanceWei);
    const poolTokenRate = calculatePoolTokenRate(
      balances.smartTokenSupplyWei,
      networkBalanceWei
    );

    const currentPoolTokenSystemBalance = new BigNumber(poolTokenBalance);
    const newPoolTokenSystemBalance = currentPoolTokenSystemBalance
      .times(poolTokenRate)
      .div(2)
      .plus(networkTokensToBeMinted);

    const breachesMaxSystemBalance = newPoolTokenSystemBalance.isGreaterThan(
      this.liquidityProtectionSettings.maxSystemNetworkTokenAmount
    );
    const breachesRatio = newPoolTokenSystemBalance
      .times(oneMillion)
      .isGreaterThan(
        newPoolTokenSystemBalance
          .plus(networkBalanceWei)
          .times(this.liquidityProtectionSettings.maxSystemNetworkTokenRatio)
      );
    console.log(
      {
        currentPoolTokenSystemBalance: currentPoolTokenSystemBalance.toString(),
        proposedPoolTokenSystemBalance: newPoolTokenSystemBalance.toString()
      },
      "awkies"
    );

    let errorMessage = "";

    if (breachesMaxSystemBalance) {
      errorMessage = "Deposit breaches maximum liquidity";
    } else if (breachesRatio) {
      errorMessage = `Deposit breaches maximum ratio between ${networkReserve.symbol} and ${baseReserve.symbol}`;
    }

    return {
      outputs: [],
      ...(errorMessage && { error: errorMessage })
    };
  }

  @action async calculateProtectionSingle(params: {
    poolId: string;
    reserveAmount: ViewAmount;
  }): Promise<ProtectionRes> {
    const depositingNetworkToken = compareString(
      this.liquidityProtectionSettings.networkToken,
      params.reserveAmount.id
    );

    if (depositingNetworkToken) {
      return this.calculateProtectionNetworkToken(params);
    } else {
      return this.calculateProtectionBaseToken(params);
    }
  }

  @action async calculateProtectionDouble({
    poolTokenAmount
  }: {
    poolTokenAmount: ViewAmount;
  }): Promise<ProtectionRes> {
    const phase2 = vxm.general.phase2;

    const relay = findOrThrow(this.relaysList, relay =>
      compareString(relay.id, poolTokenAmount.id)
    );
    const smartToken = relay.anchor as SmartToken;

    const balances = await this.fetchRelayBalances({
      poolId: smartToken.contract
    });

    const outputs = balances.reserves.map(reserve => {
      console.log(reserve, balances, "dishes");
      const rate = new BigNumber(
        calculatePoolTokenRate(balances.smartTokenSupplyWei, reserve.weiAmount)
      ).div(2);

      const reserveAmount = rate.times(poolTokenAmount.amount);
      console.log(rate, "is long string");
      return {
        id: reserve.contract,
        amount: reserveAmount.toString(),
        symbol: reserve.symbol
      };
    });

    if (phase2) {
      return {
        outputs
      };
    } else {
      return {
        outputs: [
          {
            ...poolTokenAmount,
            symbol: smartToken.symbol
          }
        ]
      };
    }
  }

  @action async calculateOpposingDeposit(
    opposingDeposit: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.relayById(opposingDeposit.id);

    if (relay.converterType == PoolType.ChainLink) {
      return this.calculateOpposingDepositV2(opposingDeposit);
    } else {
      return this.calculateOpposingDepositInfo(opposingDeposit);
    }
  }

  @action async getUserBalance({
    tokenContractAddress,
    userAddress,
    keepWei = false
  }: {
    tokenContractAddress: string;
    userAddress?: string;
    keepWei?: boolean;
  }) {
    if (!tokenContractAddress)
      throw new Error("Token contract address cannot be falsy");
    const balance = await vxm.ethWallet.getBalance({
      accountHolder: userAddress || vxm.wallet.isAuthenticated,
      tokenContractAddress,
      keepWei
    });
    const currentBalance = this.tokenBalance(tokenContractAddress);
    const balanceDifferentToAlreadyStored =
      currentBalance && currentBalance.balance !== balance && !keepWei;
    const balanceNotStoredAndNotZero = new BigNumber(balance).gt(0) && !keepWei;

    if (balanceDifferentToAlreadyStored || balanceNotStoredAndNotZero) {
      this.updateBalance([tokenContractAddress, balance]);
    }
    return balance;
  }

  @action async relayById(relayId: string) {
    return findOrThrow(
      this.relaysList,
      relay => compareString(relay.id, relayId),
      "failed to find relay by id"
    );
  }

  @action async getUserBalancesTraditional({
    relayId,
    smartTokenDec
  }: {
    relayId: string;
    smartTokenDec?: string;
  }): Promise<UserPoolBalances> {
    const relay = await this.traditionalRelayById(relayId);

    const smartTokenUserBalance =
      smartTokenDec ||
      (await this.getUserBalance({
        tokenContractAddress: relay.anchor.contract
      }));

    const { smartTokenSupplyWei, reserves } = await this.fetchRelayBalances({
      poolId: relay.anchor.contract
    });

    const smartTokenDecimals = relay.anchor.decimals;

    const percent = new Decimal(smartTokenUserBalance).div(
      shrinkToken(smartTokenSupplyWei, smartTokenDecimals)
    );

    const maxWithdrawals: ViewAmount[] = reserves.map(reserve => ({
      id: reserve.contract,
      amount: shrinkToken(
        percent.times(reserve.weiAmount).toString(),
        reserve.decimals
      )
    }));

    return {
      maxWithdrawals,
      iouBalances: [{ id: "", amount: String(smartTokenUserBalance) }]
    };
  }

  @action async getPoolType(pool: string | Relay): Promise<PoolType> {
    let relay: Relay;
    if (typeof pool == "undefined") {
      throw new Error("Pool is undefined");
    } else if (typeof pool == "string") {
      const poolId = pool as string;
      relay = await this.relayById(poolId);
    } else {
      relay = pool as Relay;
    }
    return typeof relay.converterType !== "undefined" &&
      relay.converterType == PoolType.ChainLink
      ? PoolType.ChainLink
      : PoolType.Traditional;
  }

  @action async removeLiquidityReturn({
    converterAddress,
    poolTokenWei,
    poolTokenContract
  }: {
    converterAddress: string;
    poolTokenWei: string;
    poolTokenContract: string;
  }) {
    const v2Converter = buildV2Converter(converterAddress);

    const res = await v2Converter.methods
      .removeLiquidityReturnAndFee(poolTokenContract, poolTokenWei)
      .call();

    return { feeAmountWei: res[1], returnAmountWei: res[0] };
  }

  @action async getUserBalancesChainLink(
    relayId: string
  ): Promise<UserPoolBalances> {
    const relay = await this.chainLinkRelayById(relayId);
    const poolTokenBalances = await Promise.all(
      relay.anchor.poolTokens.map(async reserveAndPool => {
        const poolUserBalance = await this.getUserBalance({
          tokenContractAddress: reserveAndPool.poolToken.contract,
          keepWei: false
        });

        BigNumber.config({ EXPONENTIAL_AT: 256 });

        return {
          ...reserveAndPool,
          poolUserBalance: Number(poolUserBalance),
          reserveToken: findOrThrow(
            relay.reserves,
            reserve =>
              compareString(reserve.contract, reserveAndPool.reserveId),
            "failed to find reserve token"
          )
        };
      })
    );

    const v2Converter = buildV2Converter(relay.contract);
    const data = await Promise.all(
      poolTokenBalances.map(async poolTokenBalance => {
        const poolTokenBalanceWei = expandToken(
          poolTokenBalance.poolUserBalance,
          poolTokenBalance.poolToken.decimals
        );

        const maxWithdrawWei = (await v2Converter.methods
          .removeLiquidityReturnAndFee(
            poolTokenBalance.poolToken.contract,
            poolTokenBalanceWei
          )
          .call())[0];

        return {
          ...poolTokenBalance,
          maxWithdraw: shrinkToken(
            maxWithdrawWei,
            poolTokenBalance.reserveToken.decimals
          )
        };
      })
    );

    const maxWithdrawals = data.map(
      (x): ViewAmount => ({
        id: x.reserveId,
        amount: String(x.maxWithdraw)
      })
    );

    const iouBalances = data.map(
      (x): ViewAmount => ({
        id: x.reserveId,
        amount: new BigNumber(x.poolUserBalance).toString()
      })
    );

    console.log({ iouBalances, maxWithdrawals });

    return { iouBalances, maxWithdrawals };
  }

  @action async getUserBalances(relayId: string): Promise<UserPoolBalances> {
    if (!vxm.wallet.isAuthenticated)
      throw new Error("Cannot find users .isAuthenticated");

    const poolType = await this.getPoolType(relayId);
    console.log("detected pool type is", poolType);
    return poolType == PoolType.Traditional
      ? this.getUserBalancesTraditional({ relayId })
      : this.getUserBalancesChainLink(relayId);
  }

  @action async getTokenSupply(tokenAddress: string) {
    const contract = buildTokenContract(tokenAddress);
    return contract.methods.totalSupply().call();
  }

  @action async calculateOpposingWithdrawV2(
    opposingWithdraw: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.chainLinkRelayById(opposingWithdraw.id);

    const changedReserve = findChangedReserve(
      opposingWithdraw.reserves,
      opposingWithdraw.changedReserveId
    );
    const suggestedPoolTokenWithdrawDec = changedReserve.amount;

    const stakedAndReserveWeight = await this.fetchV2PoolBalances(relay);

    const matchedWeights = stakedAndReserveWeight.reserves.map(reserve => ({
      reserveWeight: reserve.reserveWeight,
      stakedBalance: reserve.stakedBalance,
      decReserveWeight: new BigNumber(reserve.reserveWeight as string).div(
        oneMillion
      ),
      reserveToken: findOrThrow(
        relay.reserves,
        r => compareString(r.contract, reserve.reserveAddress),
        "failed to find reserve token"
      ),
      poolToken: findOrThrow(
        relay.anchor.poolTokens,
        poolToken =>
          compareString(reserve.poolTokenAddress, poolToken.poolToken.contract),
        "failed to find pool token"
      )
    }));

    const [biggerWeight, smallerWeight] = matchedWeights.sort((a, b) =>
      b.decReserveWeight.minus(a.decReserveWeight).toNumber()
    );

    const weightsEqualOneMillion = new BigNumber(
      biggerWeight.reserveWeight as string
    )
      .plus(smallerWeight.reserveWeight as string)
      .eq(oneMillion);
    if (!weightsEqualOneMillion)
      throw new Error("Was expecting reserve weights to equal 100%");

    const distanceFromMiddle = biggerWeight.decReserveWeight.minus(0.5);

    const adjustedBiggerWeight = new BigNumber(biggerWeight.stakedBalance).div(
      new BigNumber(1).minus(distanceFromMiddle)
    );
    const adjustedSmallerWeight = new BigNumber(
      smallerWeight.stakedBalance
    ).div(new BigNumber(1).plus(distanceFromMiddle));

    const singleUnitCosts = sortAlongSide(
      buildSingleUnitCosts(
        {
          id: biggerWeight.reserveToken.contract,
          amount: shrinkToken(
            adjustedBiggerWeight.toString(),
            biggerWeight.reserveToken.decimals
          )
        },
        {
          id: smallerWeight.reserveToken.contract,
          amount: shrinkToken(
            adjustedSmallerWeight.toString(),
            smallerWeight.reserveToken.decimals
          )
        }
      ),
      unitCost => unitCost.id,
      relay.reserves.map(x => x.contract)
    );

    const sameReserve = findOrThrow(
      matchedWeights,
      weight => compareString(weight.reserveToken.contract, changedReserve.id),
      "failed to find same reserve"
    );

    const shareOfPool = new BigNumber(suggestedPoolTokenWithdrawDec)
      .div(
        shrinkToken(
          sameReserve.stakedBalance,
          sameReserve.reserveToken.decimals
        )
      )
      .toNumber();

    const suggestedWithdrawWei = expandToken(
      suggestedPoolTokenWithdrawDec,
      sameReserve.poolToken.poolToken.decimals
    );

    const [
      { returnAmountWei, feeAmountWei },
      liquidatationLimitWei
    ] = await Promise.all([
      this.removeLiquidityReturn({
        converterAddress: relay.contract,
        poolTokenContract: sameReserve.poolToken.poolToken.contract,
        poolTokenWei: suggestedWithdrawWei
      }),
      liquidationLimit({
        converterContract: relay.contract,
        poolTokenAddress: sameReserve.poolToken.poolToken.contract
      })
    ]);

    if (new BigNumber(suggestedWithdrawWei).gt(liquidatationLimitWei))
      throw new Error("Withdrawal amount above current liquidation limit");

    const noFeeLiquidityReturn = new BigNumber(returnAmountWei).plus(
      feeAmountWei
    );

    const feePercent = new BigNumber(feeAmountWei)
      .div(noFeeLiquidityReturn)
      .toNumber();

    const removeLiquidityReturnDec = shrinkToken(
      returnAmountWei,
      sameReserve.reserveToken.decimals
    );

    const result = {
      opposingAmount: undefined,
      shareOfPool,
      singleUnitCosts,
      withdrawFee: feePercent,
      expectedReturn: {
        id: sameReserve.reserveToken.contract,
        amount: removeLiquidityReturnDec
      }
    };
    console.log(result, "was the result");
    return result;
  }

  @action async calculateOpposingWithdraw(
    opposingWithdraw: OpposingLiquidParams
  ): Promise<OpposingLiquid> {
    const relay = await this.relayById(opposingWithdraw.id);
    if (relay.converterType == PoolType.ChainLink) {
      return this.calculateOpposingWithdrawV2(opposingWithdraw);
    } else {
      return this.calculateOpposingWithdrawInfo(opposingWithdraw);
    }
  }

  @action async traditionalRelayById(
    poolId: string
  ): Promise<TraditionalRelay> {
    const relay = await this.relayById(poolId);
    const traditionalRelay = assertTraditional(relay);
    return traditionalRelay;
  }

  @action async chainLinkRelayById(poolId: string): Promise<ChainLinkRelay> {
    const relay = await this.relayById(poolId);
    const chainlinkRelay = assertChainlink(relay);
    return chainlinkRelay;
  }

  @action async calculateOpposingWithdrawInfo(
    opposingWithdraw: OpposingLiquidParams
  ): Promise<EthOpposingLiquid> {
    const {
      id,
      reserves: reservesViewAmounts,
      changedReserveId
    } = opposingWithdraw;

    const reserve = findChangedReserve(reservesViewAmounts, changedReserveId);
    const tokenAmount = reserve.amount;
    const sameReserveToken = await this.tokenById(reserve.id);

    const relay = await this.traditionalRelayById(id);
    const smartTokenAddress = relay.anchor.contract;

    const { reserves, smartTokenSupplyWei } = await this.fetchRelayBalances({
      poolId: smartTokenAddress
    });

    const reserveBalancesAboveZero = reserves.every(reserve =>
      new BigNumber(reserve.weiAmount).gt(0)
    );

    const [sameReserve, opposingReserve] = sortByNetworkTokens(
      reserves,
      reserve => reserve.symbol,
      [sameReserveToken.symbol]
    );

    const sameReserveWei = expandToken(tokenAmount, sameReserve.decimals);
    const shareOfPool = new BigNumber(sameReserveWei)
      .div(sameReserve.weiAmount)
      .toNumber();

    const opposingValue = calculateOppositeLiquidateRequirement(
      sameReserveWei,
      sameReserve.weiAmount,
      opposingReserve.weiAmount
    );
    const liquidateCostWei = calculateLiquidateCost(
      sameReserveWei,
      sameReserve.weiAmount,
      smartTokenSupplyWei
    );

    const smartUserBalanceWei = await vxm.ethWallet.getBalance({
      accountHolder: vxm.wallet.isAuthenticated,
      tokenContractAddress: smartTokenAddress,
      keepWei: true
    });

    const percentDifferenceBetweenSmartBalance = percentDifference(
      liquidateCostWei,
      String(smartUserBalanceWei)
    );
    let smartTokenAmount: string;
    if (percentDifferenceBetweenSmartBalance > 0.99) {
      smartTokenAmount = String(smartUserBalanceWei);
    } else {
      smartTokenAmount = liquidateCostWei;
    }

    const sameReserveCost = shrinkToken(
      new BigNumber(opposingReserve.weiAmount)
        .div(sameReserve.weiAmount)
        .toString(),
      sameReserve.decimals
    );
    const opposingReserveCost = shrinkToken(
      new BigNumber(sameReserve.weiAmount)
        .div(opposingReserve.weiAmount)
        .toString(),
      opposingReserve.decimals
    );

    return {
      opposingAmount: shrinkToken(
        opposingValue,
        opposingReserve.decimals,
        true
      ),
      shareOfPool,
      smartTokenAmountWei: {
        id: smartTokenAddress,
        amount: smartTokenAmount
      },
      singleUnitCosts: [
        { id: sameReserve.contract, amount: sameReserveCost },
        { id: opposingReserve.contract, amount: opposingReserveCost }
      ],
      reserveBalancesAboveZero
    };
  }

  @action async removeLiquidityV2({
    converterAddress,
    poolToken,
    miniumReserveReturnWei = "1",
    onHash
  }: {
    converterAddress: string;
    poolToken: TokenWei;
    miniumReserveReturnWei: string;
    onHash?: (hash: string) => void;
  }) {
    const contract = buildV2Converter(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: contract.methods.removeLiquidity(
        poolToken.tokenContract,
        poolToken.weiAmount,
        miniumReserveReturnWei
      ),
      onHash
    });
  }

  @action async liquidate({
    converterAddress,
    smartTokenAmount
  }: {
    converterAddress: string;
    smartTokenAmount: string;
  }) {
    const converterContract = buildConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: converterContract.methods.liquidate(smartTokenAmount)
    });
  }

  @action async removeLiquidity({ reserves, id: relayId }: LiquidityParams) {
    const relay = await this.relayById(relayId);

    const preV11 = Number(relay.version) < 11;
    if (preV11)
      throw new Error("This Pool is not supported for adding liquidity");

    const postV28 = Number(relay.version) >= 28;

    const withdraw = reserves.find(reserve => reserve.amount)!;
    const converterAddress = relay.contract;

    let hash: string;
    if (postV28 && relay.converterType == PoolType.ChainLink) {
      const v2Relay = await this.chainLinkRelayById(relayId);
      const poolToken = findOrThrow(
        v2Relay.anchor.poolTokens,
        poolToken => compareString(poolToken.reserveId, withdraw.id),
        "failed to find pool token"
      );

      const poolTokenWeiAmount = expandToken(
        withdraw.amount,
        poolToken.poolToken.decimals
      );
      const weiPoolTokenBalance = (await this.getUserBalance({
        tokenContractAddress: poolToken.poolToken.contract,
        keepWei: true
      })) as string;

      const roundedWeiAmount = new BigNumber(poolTokenWeiAmount).gt(
        new BigNumber(weiPoolTokenBalance).times(0.995)
      )
        ? weiPoolTokenBalance
        : poolTokenWeiAmount;

      const expectedReserveReturn = await this.removeLiquidityReturn({
        converterAddress: relay.contract,
        poolTokenWei: roundedWeiAmount,
        poolTokenContract: poolToken.poolToken.contract
      });

      hash = await this.removeLiquidityV2({
        converterAddress,
        poolToken: {
          tokenContract: poolToken.poolToken.contract,
          weiAmount: roundedWeiAmount
        },
        miniumReserveReturnWei: await this.weiMinusSlippageTolerance(
          expectedReserveReturn.returnAmountWei
        )
      });
    } else if (postV28 && relay.converterType == PoolType.Traditional) {
      const traditionalRelay = await this.traditionalRelayById(relay.id);
      const { smartTokenAmountWei } = await this.calculateOpposingWithdrawInfo({
        id: relayId,
        reserves,
        changedReserveId: reserves[0].id
      });
      const userPoolBalance = await this.getUserBalancesTraditional({
        relayId,
        smartTokenDec: shrinkToken(
          smartTokenAmountWei.amount,
          traditionalRelay.anchor.decimals
        )
      });
      hash = await this.removeLiquidityV28({
        converterAddress,
        smartTokensWei: smartTokenAmountWei.amount,
        reserveTokens: relay.reserves.map(reserve => {
          const reserveBalances = userPoolBalance.maxWithdrawals;
          return {
            tokenAddress: reserve.contract,
            minimumReturnWei: expandToken(
              new BigNumber(
                reserveBalances.find(balance =>
                  compareString(balance.id, reserve.contract)
                )!.amount
              )
                .times(0.98)
                .toNumber(),
              reserve.decimals
            )
          };
        })
      });
    } else {
      const { smartTokenAmountWei } = await this.calculateOpposingWithdrawInfo({
        id: relayId,
        reserves,
        changedReserveId: reserves[0].id
      });
      hash = await this.liquidate({
        converterAddress,
        smartTokenAmount: smartTokenAmountWei.amount
      });
    }

    const anchorTokens = getAnchorTokenAddresses(relay);

    const tokenAddressesChanged = [
      ...relay.reserves.map(reserve => reserve.contract),
      ...anchorTokens
    ];
    this.spamBalances(tokenAddressesChanged);

    return {
      txId: hash,
      blockExplorerLink: await this.createExplorerLink(hash)
    };
  }

  @action async mintEthErc(ethDec: string) {
    return new Promise((resolve, reject) => {
      let txHash: string;
      web3.eth
        .sendTransaction({
          from: this.isAuthenticated,
          to: ethErc20WrapperContract,
          value: toHex(toWei(ethDec))
        })
        .on("transactionHash", (hash: string) => {
          txHash = hash;
        })
        .on("confirmation", (confirmationNumber: number) => {
          resolve(txHash);
        })
        .on("error", (error: any) => reject(error));
    });
  }

  @action async fundRelay({
    converterAddress,
    fundAmount,
    onHash
  }: {
    converterAddress: string;
    fundAmount: string;
    onHash?: (hash: string) => void;
  }) {
    const converterContract = buildConverterContract(converterAddress);
    return this.resolveTxOnConfirmation({
      tx: converterContract.methods.fund(fundAmount),
      gas: 950000,
      ...(onHash && { onHash })
    });
  }

  @action async addLiquidityV28({
    converterAddress,
    reserves,
    minimumReturnWei,
    onHash
  }: {
    converterAddress: string;
    reserves: TokenWei[];
    minimumReturnWei: string;
    onHash?: (hash: string) => void;
  }) {
    const contract = buildV28ConverterContract(converterAddress);

    const newEthReserve = reserves.find(reserve =>
      compareString(reserve.tokenContract, ethReserveAddress)
    );

    return this.resolveTxOnConfirmation({
      tx: contract.methods.addLiquidity(
        reserves.map(reserve => reserve.tokenContract),
        reserves.map(reserve => reserve.weiAmount),
        minimumReturnWei
      ),
      onHash,
      ...(newEthReserve && { value: newEthReserve.weiAmount })
    });
  }

  @action async addLiquidityV2({
    converterAddress,
    reserve,
    poolTokenMinReturnWei = "1",
    onHash
  }: {
    converterAddress: string;
    reserve: TokenWei;
    poolTokenMinReturnWei?: string;
    onHash?: (hash: string) => void;
  }) {
    const contract = buildV2Converter(converterAddress);

    const newEthReserve = compareString(
      reserve.tokenContract,
      ethReserveAddress
    );

    return this.resolveTxOnConfirmation({
      tx: contract.methods.addLiquidity(
        reserve.tokenContract,
        reserve.weiAmount,
        poolTokenMinReturnWei
      ),
      onHash: onHash,
      ...(newEthReserve && { value: reserve.weiAmount })
    });
  }

  @action async removeLiquidityV28({
    converterAddress,
    smartTokensWei,
    reserveTokens
  }: {
    converterAddress: string;
    smartTokensWei: string;
    reserveTokens: { tokenAddress: string; minimumReturnWei: string }[];
  }) {
    const contract = buildV28ConverterContract(converterAddress);

    return this.resolveTxOnConfirmation({
      tx: contract.methods.removeLiquidity(
        smartTokensWei,
        reserveTokens.map(token => token.tokenAddress),
        reserveTokens.map(token => token.minimumReturnWei)
      )
    });
  }

  @action async weiMinusSlippageTolerance(wei: string): Promise<string> {
    const slippageTolerance = vxm.bancor.slippageTolerance;
    if (typeof slippageTolerance !== "number")
      throw new Error("Error finding slippage tolerance");
    const percent = new BigNumber(1).minus(slippageTolerance);
    const newWei = new BigNumber(wei).times(percent).toFixed(0);
    console.log(newWei, "is new wei");
    return newWei;
  }

  @action async addToken(tokenAddress: string) {
    const isAddress = web3.utils.isAddress(tokenAddress);
    if (!isAddress) throw new Error(`${tokenAddress} is not a valid address`);

    const shape = tokenShape(tokenAddress);
    const [[token]] = (await this.multi([[shape]])) as [
      [{ symbol: string; decimals: string; contract: string }]
    ];

    const tokenAddressesMatch = compareString(token.contract, tokenAddress);
    if (!tokenAddressesMatch) throw new Error("RPC return was not expected");

    console.log(token, "was was return");
    if (!(token.symbol && token.decimals))
      throw new Error(
        "Failed parsing token information, please ensure this is an ERC-20 token"
      );

    this.addTokenToMeta({
      decimals: Number(token.decimals),
      symbol: token.symbol,
      tokenAddress: token.contract
    });
  }

  @mutation addTokenToMeta(token: {
    decimals: number;
    symbol: string;
    tokenAddress: string;
  }) {
    const tokenMetaList = this.tokenMeta;

    const tokenAlreadyExists = this.tokenMeta.some(meta =>
      compareString(meta.contract, token.tokenAddress)
    );
    if (tokenAlreadyExists) return;

    const tokenMeta: TokenMeta = {
      contract: token.tokenAddress,
      id: token.tokenAddress,
      image: defaultImage,
      name: token.symbol,
      symbol: token.symbol,
      precision: token.decimals
    };

    this.tokenMeta = [...tokenMetaList, tokenMeta];
  }

  @action async addLiquidity({
    id: relayId,
    reserves,
    onUpdate
  }: LiquidityParams) {
    const relay = await this.relayById(relayId);

    const preV11 = Number(relay.version) < 11;
    if (preV11)
      throw new Error("This Pool is not supported for adding liquidity");

    const postV28 = Number(relay.version) >= 28;

    const matchedBalances = reserves
      .filter(reserve => reserve.amount)
      .map(reserve => {
        const relayReserve = findOrThrow(
          relay.reserves,
          relayReserve => compareString(relayReserve.contract, reserve.id),
          "failed to match passed reserves"
        );
        return {
          ...relayReserve,
          amount: reserve.amount
        };
      });

    const steps: Step[] = [
      {
        name: "CheckBalance",
        description: "Updating balance approvals..."
      },
      {
        name: "Funding",
        description: "Now funding..."
      },
      {
        name: "BlockConfirmation",
        description: "Awaiting block confirmation..."
      },
      {
        name: "Done",
        description: "Done!"
      }
    ];

    onUpdate!(0, steps);

    const converterAddress = relay.contract;

    await Promise.all(
      matchedBalances.map(async balance => {
        if (
          compareString(balance.contract, ethErc20WrapperContract) &&
          !postV28
        ) {
          await this.mintEthErc(balance.amount!);
        }
        if (compareString(balance.contract, ethReserveAddress)) return;
        return this.triggerApprovalIfRequired({
          owner: this.isAuthenticated,
          amount: expandToken(balance.amount!, balance.decimals),
          spender: converterAddress,
          tokenAddress: balance.contract
        });
      })
    );

    onUpdate!(1, steps);

    let txHash: string;

    if (postV28 && relay.converterType == PoolType.Traditional) {
      console.log("treating as a traditional relay");
      const {
        smartTokenAmountWei,
        reserveBalancesAboveZero
      } = await this.calculateOpposingDepositInfo({
        id: relay.id,
        reserves,
        changedReserveId: reserves[0].id
      });

      const minimumReturnWei = reserveBalancesAboveZero
        ? await this.weiMinusSlippageTolerance(smartTokenAmountWei.amount)
        : "1";

      txHash = await this.addLiquidityV28({
        converterAddress,
        reserves: matchedBalances
          .filter(balance => new BigNumber(balance.amount).gt(0))
          .map(balance => ({
            tokenContract: balance.contract,
            weiAmount: expandToken(balance.amount, balance.decimals)
          })),
        minimumReturnWei,
        onHash: () => onUpdate!(2, steps)
      });
    } else if (postV28 && relay.converterType == PoolType.ChainLink) {
      console.log("treating as a chainlink v2 relay");
      const chainLinkRelay = await this.chainLinkRelayById(relay.id);
      const reserveToken = matchedBalances.map(balance => ({
        tokenContract: balance.contract,
        weiAmount: expandToken(balance.amount, balance.decimals)
      }))[0];
      const poolToken = chainLinkRelay.anchor.poolTokens.find(poolToken =>
        compareString(poolToken.reserveId, reserveToken.tokenContract)
      );
      if (!poolToken)
        throw new Error("Client side error - failed finding pool token");

      const [stakedReserveBalance, poolTokenSupply] = await Promise.all([
        this.fetchStakedReserveBalance({
          converterAddress: chainLinkRelay.contract,
          reserveTokenAddress: reserveToken.tokenContract
        }),
        getTokenSupplyWei(poolToken.poolToken.contract)
      ]);

      const expectedPoolTokenReturnWei = calculateExpectedPoolTokenReturnV2(
        poolTokenSupply,
        stakedReserveBalance,
        reserveToken.weiAmount
      );

      const poolTokenMinReturnWei = await this.weiMinusSlippageTolerance(
        expectedPoolTokenReturnWei
      );

      txHash = await this.addLiquidityV2({
        converterAddress,
        reserve: reserveToken,
        poolTokenMinReturnWei,
        onHash: () => onUpdate!(2, steps)
      });
    } else {
      console.log("treating as an old tradtional relay");
      const { smartTokenAmountWei } = await this.calculateOpposingDepositInfo({
        reserves,
        changedReserveId: reserves[0].id,
        id: relayId
      });

      const fundAmount = smartTokenAmountWei;

      txHash = await this.fundRelay({
        converterAddress,
        fundAmount: fundAmount.amount,
        onHash: () => onUpdate!(2, steps)
      });
    }

    onUpdate!(3, steps);

    const anchorTokens = getAnchorTokenAddresses(relay);

    const tokenAddressesChanged = [
      ...matchedBalances.map(x => x.contract),
      ...anchorTokens
    ];
    this.spamBalances(tokenAddressesChanged);
    return {
      txId: txHash,
      blockExplorerLink: await this.createExplorerLink(txHash)
    };
  }

  @action async spamBalances(tokenAddresses: string[]) {
    for (var i = 0; i < 5; i++) {
      tokenAddresses.forEach(tokenContractAddress =>
        this.getUserBalance({ tokenContractAddress })
      );
      await wait(1500);
    }
  }

  @action async fetchContractAddresses(contractRegistry: string) {
    if (!contractRegistry || !web3.utils.isAddress(contractRegistry))
      throw new Error("Must pass valid address");

    const hardCodedBytes: RegisteredContracts = {
      BancorNetwork: asciiToHex("BancorNetwork"),
      BancorConverterRegistry: asciiToHex("BancorConverterRegistry"),
      LiquidityProtectionStore: asciiToHex("LiquidityProtectionStore"),
      LiquidityProtection: asciiToHex("LiquidityProtection")
    };

    const registryContract = new web3.eth.Contract(
      ABIContractRegistry,
      contractRegistry
    );

    const arr = toPairs(hardCodedBytes) as [string, string][];

    try {
      const contractAddresses = await Promise.all(
        arr.map(
          async ([label, ascii]) =>
            [label, await registryContract.methods.addressOf(ascii).call()] as [
              string,
              string
            ]
        )
      );

      const object = (fromPairs(
        contractAddresses
      ) as unknown) as RegisteredContracts;
      this.setContractAddresses(object);
      return object;
    } catch (e) {
      console.error(
        `Failed fetching ETH contract addresses ${e.message} Contract Registry: ${contractRegistry}`
      );
      throw new Error(e.message);
    }
  }

  @mutation setContractAddresses(contracts: RegisteredContracts) {
    this.contracts = {
      ...this.contracts,
      ...contracts
    };
  }

  @action async warmEthApi() {
    const tokens = await ethBancorApi.getTokens();
    console.log(tokens, "are the tokens");
    this.setBancorApiTokens(tokens);
    return tokens;
  }

  @action async addPossiblePropsFromBancorApi(
    reserveFeeds: ReserveFeed[]
  ): Promise<ReserveFeed[]> {
    try {
      const tokens = this.bancorApiTokens;
      if (!tokens || tokens.length == 0) {
        return reserveFeeds;
        // throw new Error("There are no cached Bancor API tokens.");
      }
      const ethUsdPrice = findOrThrow(
        tokens,
        token => token.code == "ETH",
        "failed finding price of ETH from tokens request"
      ).price;
      console.log(ethUsdPrice, "is the eth USD price");

      const [bancorCovered, notCovered] = partition(reserveFeeds, feed => {
        const inDictionary = ethBancorApiDictionary.find(
          matchReserveFeed(feed)
        );
        if (!inDictionary) return false;
        return tokens.some(token => token.id == inDictionary.tokenId);
      });

      const newBancorCovered = bancorCovered.map(reserveFeed => {
        const dictionary = findOrThrow(
          ethBancorApiDictionary,
          matchReserveFeed(reserveFeed)
        );
        const tokenPrice = findOrThrow(
          tokens,
          token => token.id == dictionary.tokenId
        );

        return {
          ...reserveFeed,
          change24H: tokenPrice.change24h,
          volume24H: tokenPrice.volume24h.USD,
          costByNetworkUsd: reserveFeed.costByNetworkUsd || tokenPrice.price
        };
      });

      return [...newBancorCovered, ...notCovered];
    } catch (e) {
      console.warn(`Failed utilising Bancor API: ${e.message}`);
      return reserveFeeds;
    }
  }

  @action async updateRelayFeeds(suggestedFeeds: ReserveFeed[]) {
    const feeds = suggestedFeeds;

    const potentialRelaysToMutate = this.relaysList.filter(relay =>
      feeds.some(feed => compareString(feed.poolId, relay.id))
    );
    const relaysToMutate = potentialRelaysToMutate.filter(relay =>
      relay.reserves.some(reserve => {
        const feed = feeds.find(feed =>
          compareString(reserve.contract, feed.reserveAddress)
        );
        if (feed && !reserve.reserveFeed) return true;
        if (!feed) return false;
        const existingFeed = reserve.reserveFeed!;
        if (existingFeed) return feed.priority < existingFeed.priority;
      })
    );

    if (relaysToMutate.length > 0) {
      const updatedRelays = relaysToMutate.map(relay => ({
        ...relay,
        reserves: relay.reserves.map(reserve => {
          const feed = feeds.find(
            feed =>
              compareString(feed.reserveAddress, reserve.contract) &&
              compareString(feed.poolId, relay.id)
          );
          return {
            ...reserve,
            reserveFeed: feed
          };
        })
      }));

      this.updateRelays(updatedRelays);
    }
  }

  @action async fetchUsdPriceOfBnt() {
    const price = await vxm.bancor.fetchUsdPriceOfBnt();
    this.setBntUsdPrice(price);
    return price;
  }

  @mutation setBntUsdPrice(usdPrice: number) {
    this.bntUsdPrice = usdPrice;
  }

  @action async fetchStakedReserveBalance({
    converterAddress,
    reserveTokenAddress
  }: {
    converterAddress: string;
    reserveTokenAddress: string;
  }): Promise<string> {
    const contract = buildV2Converter(converterAddress);
    return contract.methods.reserveStakedBalance(reserveTokenAddress).call();
  }

  @action async fetchV2ConverterReserveWeights(converterAddress: string) {
    const contract = buildV2Converter(converterAddress);
    const weights = await contract.methods.effectiveReserveWeights().call();
    return [weights["0"], weights["1"]];
  }

  get loadingTokens() {
    return this.loadingPools;
  }

  get moreTokensAvailable() {
    return this.morePoolsAvailable;
  }

  @action async relaysContainingToken(tokenId: string): Promise<string[]> {
    return getConvertibleTokenAnchors({
      converterRegistryAddress: this.contracts.BancorConverterRegistry,
      tokenAddress: tokenId
    });
  }

  @action async loadMoreTokens(tokenIds?: string[]) {
    if (tokenIds && tokenIds.length > 0) {
      const anchorAddresses = await Promise.all(
        tokenIds.map(id => this.relaysContainingToken(id))
      );
      const anchorAddressesNotLoaded = anchorAddresses
        .flat(1)
        .filter(
          anchorAddress =>
            !this.relaysList.some(relay =>
              compareString(relay.id, anchorAddress)
            )
        );
      const convertersAndAnchors = await this.add(anchorAddressesNotLoaded);
      await this.addPoolsV2(convertersAndAnchors);
    } else {
      await this.loadMorePools();
    }
  }

  @mutation setAvailableHistories(smartTokenNames: string[]) {
    this.availableHistories = smartTokenNames;
  }

  @action async refresh() {
    console.log("refresh called on eth bancor, doing nothing");
  }

  @mutation setRegisteredAnchorAddresses(addresses: string[]) {
    this.registeredAnchorAddresses = addresses;
  }

  @mutation setConvertibleTokenAddresses(addresses: string[]) {
    this.convertibleTokenAddresses = addresses;
  }

  @action async conversionPathFromNetworkContract({
    from,
    to,
    networkContractAddress
  }: {
    from: string;
    to: string;
    networkContractAddress: string;
  }) {
    return conversionPath({ networkContractAddress, from, to });
  }

  @action async relaysRequiredForTrade({
    from,
    to,
    networkContractAddress
  }: {
    from: string;
    to: string;
    networkContractAddress: string;
  }) {
    try {
      const path = await this.conversionPathFromNetworkContract({
        from,
        to,
        networkContractAddress
      });
      const smartTokenAddresses = path.filter((_, index) => isOdd(index));
      if (smartTokenAddresses.length == 0)
        throw new Error("Failed to find any smart token addresses for path.");
      return smartTokenAddresses;
    } catch (e) {
      console.error(`relays required for trade failed ${e.message}`);
      throw new Error(`relays required for trade failed ${e.message}`);
    }
  }

  @action async poolsByPriority({
    anchorAddressess,
    tokenPrices
  }: {
    anchorAddressess: string[];
    tokenPrices?: TokenPrice[];
  }) {
    if (tokenPrices && tokenPrices.length > 0) {
      return sortSmartTokenAddressesByHighestLiquidity(
        tokenPrices,
        anchorAddressess
      );
    } else {
      return sortAlongSide(anchorAddressess, x => x, priorityEthPools);
    }
  }

  @action async bareMinimumPools({
    params,
    networkContractAddress,
    anchorAddressess,
    tokenPrices
  }: {
    params?: ModuleParam;
    networkContractAddress: string;
    anchorAddressess: string[];
    tokenPrices?: TokenPrice[];
  }): Promise<string[]> {
    const fromToken =
      params! && params!.tradeQuery! && params!.tradeQuery!.base!;
    const toToken =
      params! && params!.tradeQuery! && params!.tradeQuery!.quote!;

    const tradeIncluded = fromToken && toToken;
    const poolIncluded = params && params.poolQuery;

    if (tradeIncluded) {
      console.log("trade included...");
      const res = await this.relaysRequiredForTrade({
        from: fromToken,
        to: toToken,
        networkContractAddress
      });
      console.log(res, `was for ${fromToken} and ${toToken}`);
      return res;
    } else if (poolIncluded) {
      console.log("pool included...");
      return [poolIncluded];
    } else {
      console.log("should be loading first 5");
      const allPools = await this.poolsByPriority({
        anchorAddressess,
        tokenPrices
      });
      return allPools.slice(0, 3);
    }
  }

  @action async multi(groupsOfShapes: ShapeWithLabel[][]) {
    const networkVars = getNetworkVariables(this.currentNetwork);
    const multi = new MultiCall(web3, networkVars.multiCall, [
      500,
      100,
      50,
      10,
      1
    ]);

    const res = await multi.all(groupsOfShapes, {
      traditional: false
    });
    return res;
  }

  @action async refreshReserveBalances() {
    const v1Relays = this.relaysList.filter(
      relay => relay.converterType == PoolType.Traditional
    ) as TraditionalRelay[];
    const v2Relays = this.relaysList.filter(
      relay => relay.converterType == PoolType.ChainLink
    ) as ChainLinkRelay[];

    const v1RelayShapes = v1Relays.map(relay =>
      reserveBalanceShape(relay.contract, relay.reserves.map(r => r.contract))
    );
    const v2RelayPoolBalanceShapes = v2Relays.map(relay =>
      v2PoolBalanceShape(
        relay.contract,
        relay.reserves[0].contract,
        relay.reserves[1].contract
      )
    );

    const [v1RelayBalances, v2RelayBalances] = await this.multi([
      v1RelayShapes,
      v2RelayPoolBalanceShapes
    ]);
  }

  @action async addPoolsV2(
    convertersAndAnchors: ConverterAndAnchor[]
  ): Promise<V2Response> {
    const allAnchors = convertersAndAnchors.map(item => item.anchorAddress);
    const allConverters = convertersAndAnchors.map(
      item => item.converterAddress
    );

    const [rawRelays, poolAndSmartTokens] = ((await this.multi([
      allConverters.map(relayShape),
      allAnchors.map(poolTokenShape)
    ])) as [unknown, unknown]) as [AbiRelay[], AbiCentralPoolToken[]];

    const badRelays = rawRelays.filter(
      rawRelay => !(rawRelay.connectorToken1 && rawRelay.connectorToken2)
    );
    const badRelay = rawRelays
      .filter(x => x.connectorTokenCount == "2")
      .find(
        rawRelay =>
          compareString(
            rawRelay.connectorToken1,
            "0x57Ab1E02fEE23774580C119740129eAC7081e9D3"
          ) ||
          compareString(
            rawRelay.connectorToken2,
            "0x57Ab1E02fEE23774580C119740129eAC7081e9D3"
          )
      );

    const { poolTokenAddresses, smartTokens } = seperateMiniTokens(
      poolAndSmartTokens
    );

    const polished: RefinedAbiRelay[] = rawRelays
      .filter(x => Number(x.connectorTokenCount) == 2)
      .map(half => ({
        ...half,
        anchorAddress: findOrThrow(
          convertersAndAnchors,
          item => compareString(item.converterAddress, half.converterAddress),
          "failed to find anchor address"
        ).anchorAddress,
        reserves: [half.connectorToken1, half.connectorToken2] as [
          string,
          string
        ],
        version: Number(half.version),
        converterType: determineConverterType(half.converterType)
      }));

    const overWroteVersions = updateArray(
      polished,
      relay =>
        knownVersions.some(r =>
          compareString(r.converterAddress, relay.converterAddress)
        ),
      relay => ({
        ...relay,
        version: knownVersions.find(r =>
          compareString(r.converterAddress, relay.converterAddress)
        )!.version
      })
    );

    const passedFirstHalfs = overWroteVersions
      .filter(hasTwoConnectors)
      .filter(half =>
        poolTokenAddresses.some(poolTokenAddress =>
          compareString(poolTokenAddress.anchorAddress, half.anchorAddress)
        )
          ? poolTokenAddresses.find(poolTokenAddress =>
              compareString(poolTokenAddress.anchorAddress, half.anchorAddress)
            )!.poolTokenAddresses.length == 2
          : true
      );

    const verifiedV1Pools = passedFirstHalfs.filter(
      half => half.converterType == PoolType.Traditional
    );

    const verifiedV2Pools = passedFirstHalfs.filter(
      half => half.converterType == PoolType.ChainLink
    );

    console.log({ verifiedV1Pools, verifiedV2Pools });

    const reserveTokens = uniqWith(
      passedFirstHalfs.flatMap(half => half.reserves),
      compareString
    );

    console.time("secondWaterfall");

    const tokenInMeta = (tokenMeta: TokenMeta[]) => (address: string) =>
      tokenMeta.find(
        meta => compareString(address, meta.contract) && meta.precision
      );

    const allTokensRequired = [
      ...reserveTokens,
      ...poolTokenAddresses.flatMap(pool => pool.poolTokenAddresses)
    ].filter(tokenAddress => !compareString(tokenAddress, ethReserveAddress));

    const tokenAddressesKnown = allTokensRequired.filter(
      tokenInMeta(this.tokenMeta)
    );
    const tokensKnown = tokenAddressesKnown.map(address => {
      const meta = tokenInMeta(this.tokenMeta)(address)!;
      return metaToTokenAssumedPrecision(meta);
    });
    const tokenAddressesMissing = differenceWith(
      allTokensRequired,
      tokenAddressesKnown,
      compareString
    );

    const [
      reserveAndPoolTokensAbi,
      v1ReserveBalances,
      v2PoolReserveBalances
    ] = ((await this.multi([
      tokenAddressesMissing.map(tokenShape),
      verifiedV1Pools.map(v1Pool =>
        reserveBalanceShape(v1Pool.converterAddress, v1Pool.reserves)
      ),
      verifiedV2Pools.map(pool =>
        v2PoolBalanceShape(
          pool.converterAddress,
          pool.reserves[0],
          pool.reserves[1]
        )
      )
    ])) as [unknown, unknown, unknown]) as [
      RawAbiToken[],
      RawAbiReserveBalance[],
      RawAbiV2PoolBalances[]
    ];

    const stakedAndReserveWeights = v2PoolReserveBalances.map(
      rawAbiV2ToStacked
    );

    const reserveAndPoolTokens = reserveAndPoolTokensAbi.map(
      (token): Token => ({
        contract: token.contract,
        decimals: Number(token.decimals),
        network: "ETH",
        symbol: token.symbol
      })
    );

    const allTokens = [...reserveAndPoolTokens, ...tokensKnown];

    const polishedReserveAndPoolTokens = polishTokens(
      this.tokenMeta,
      allTokens
    );

    const matched = stakedAndReserveWeights.map(relay => ({
      ...relay,
      anchorAddress: findOrThrow(
        convertersAndAnchors,
        item => compareString(item.converterAddress, relay.converterAddress),
        "failed to match anchor address"
      ).anchorAddress,
      reserves: relay.reserves.map(reserve => ({
        ...reserve,
        token: polishedReserveAndPoolTokens.find(token =>
          compareString(token.contract, reserve.reserveAddress)
        )
      }))
    }));

    const confirmedTokenMatch = matched.filter(match =>
      match.reserves.every(reserve => reserve.token)
    ) as RawV2Pool[];

    console.log(confirmedTokenMatch, "touchy");

    const v2RelayFeeds = buildRelayFeedChainkLink({
      relays: confirmedTokenMatch,
      usdPriceOfBnt: this.bntUsdPrice
    });

    console.timeEnd("secondWaterfall");

    const v2Pools = verifiedV2Pools.map(
      (pool): ChainLinkRelay => {
        const rawPool = findOrThrow(
          confirmedTokenMatch,
          match => compareString(match.converterAddress, pool.converterAddress),
          `failed to find raw pool ${pool.converterAddress}`
        );

        return {
          anchor: {
            poolContainerAddress: rawPool.anchorAddress,
            poolTokens: rawPool.reserves.map(reserve => ({
              reserveId: reserve.reserveAddress,
              poolToken: findOrThrow(
                polishedReserveAndPoolTokens,
                token =>
                  compareString(token.contract, reserve.poolTokenAddress),
                `failed to find the pool token for ${reserve.poolTokenAddress}`
              )
            }))
          },
          contract: pool.converterAddress,
          id: rawPool.anchorAddress,
          converterType: PoolType.ChainLink,
          isMultiContract: false,
          network: "ETH",
          owner: pool.owner,
          reserves: rawPool.reserves.map(reserve => ({
            ...reserve.token,
            reserveWeight:
              typeof reserve.reserveWeight !== "undefined"
                ? Number(reserve.reserveWeight) / oneMillion.toNumber()
                : undefined
          })),
          version: String(pool.version),
          fee: Number(pool.conversionFee) / 10000
        };
      }
    );

    const v1Pools = verifiedV1Pools.map(pool => {
      const smartTokenAddress = pool.anchorAddress;
      const converterAddress = convertersAndAnchors.find(item =>
        compareString(item.anchorAddress, smartTokenAddress)
      )!.converterAddress;
      const polishedHalf = overWroteVersions.find(pol =>
        compareString(pol.converterAddress, converterAddress)
      )!;
      const smartToken = smartTokens.find(token =>
        compareString(token.contract, smartTokenAddress)
      )!;
      const anchorProps = smartTokenAnchor({
        ...smartToken,
        network: "ETH",
        decimals: Number(smartToken.decimals)
      });
      const reserveBalances = v1ReserveBalances.find(reserve =>
        compareString(reserve.converterAddress, converterAddress)
      )!;
      if (!reserveBalances) {
        console.log(
          pool.anchorAddress,
          "was dropped because it has no reserve balances"
        );
        return;
      }
      const zippedReserveBalances = [
        {
          contract: polishedHalf.connectorToken1,
          amount: reserveBalances.reserveOne
        },
        {
          contract: polishedHalf.connectorToken2,
          amount: reserveBalances.reserveTwo
        }
      ];
      const reserveTokens = zippedReserveBalances.map(
        reserve =>
          polishedReserveAndPoolTokens.find(token =>
            compareString(token.contract, reserve.contract)
          )!
      );

      const relay: RelayWithReserveBalances = {
        id: smartTokenAddress,
        reserves: reserveTokens.map(x => ({
          ...x,
          reserveWeight: 0.5,
          decimals: Number(x.decimals)
        })),
        reserveBalances: zippedReserveBalances.map(zip => ({
          amount: zip.amount,
          id: zip.contract
        })),
        contract: converterAddress,
        fee: Number(polishedHalf.conversionFee) / 10000,
        isMultiContract: false,
        network: "ETH",
        owner: polishedHalf.owner,
        version: String(polishedHalf.version),
        anchor: anchorProps.anchor,
        converterType: anchorProps.converterType
      };

      return relay;
    });

    const completeV1Pools = (v1Pools.filter(
      Boolean
    ) as RelayWithReserveBalances[]).filter(x => x.reserves.every(Boolean));

    const bntTokenAddress = getNetworkVariables(this.currentNetwork).bntToken;

    const knownPrices = [
      { id: bntTokenAddress, usdPrice: String(this.bntUsdPrice) },
      ...trustedStables(this.currentNetwork)
    ];

    console.log(knownPrices, "are the known prices passed");
    const traditionalRelayFeeds = buildPossibleReserveFeedsTraditional(
      completeV1Pools,
      knownPrices
    );

    const poolsFailedToBeCovered = completeV1Pools.filter(
      pool =>
        !(
          traditionalRelayFeeds.filter(feed =>
            compareString(feed.poolId, pool.id)
          ).length == 2
        )
    );
    console.log(
      completeV1Pools.length,
      "pools in",
      traditionalRelayFeeds.length / 2,
      "came back out",
      poolsFailedToBeCovered.map(x => x.reserves.map(r => r.symbol).join("")),
      "pools failed to be covered"
    );

    const reserveFeeds = [...traditionalRelayFeeds, ...v2RelayFeeds];
    const pools = [...v2Pools, ...completeV1Pools];

    // debug
    const failed = differenceWith(convertersAndAnchors, pools, (a, b) =>
      compareString(a.converterAddress, b.contract)
    );
    if (failed.length > 0) {
      console.warn(failed, "FAILS");
    }

    // end debug

    return {
      reserveFeeds,
      pools
    };
  }

  @mutation deletePools(ids: string[]) {
    this.relaysList = this.relaysList.filter(
      relay => !ids.some(id => compareString(relay.id, id))
    );
  }

  @action async reloadPools(anchorAndConverters: ConverterAndAnchor[]) {
    this.deletePools(anchorAndConverters.map(x => x.anchorAddress));
    this.addPoolsBulk(anchorAndConverters);
  }

  @action async add(anchorAddresses: string[]) {
    const converters = await this.fetchConverterAddressesByAnchorAddresses(
      anchorAddresses
    );
    return zipAnchorAndConverters(anchorAddresses, converters);
  }

  @action async pullConverterEvents({
    converterAddress,
    network,
    fromBlock
  }: {
    converterAddress: string;
    network: EthNetworks;
    fromBlock: number;
  }) {
    const res = await getConverterLogs(network, converterAddress, fromBlock);
    console.log(res, "was res");

    const uniqueAddHashes = uniqWith(
      res.addLiquidity.map(event => event.txHash),
      compareString
    );
    const uniqueRemoveHashes = uniqWith(
      res.removeLiquidity.map(event => event.txHash),
      compareString
    );

    const groupedAddLiquidityEvents = uniqueAddHashes.map(hash =>
      res.addLiquidity.filter(event => compareString(event.txHash, hash))
    );

    const groupedRemoveLiquidityEvents = uniqueRemoveHashes.map(hash =>
      res.removeLiquidity.filter(event => compareString(event.txHash, hash))
    );

    const tokens = this.tokens;

    const blockNow = await this.blockNumberHoursAgo(0);
    const timeNow = moment().unix();

    const removeEvents = groupedRemoveLiquidityEvents
      .filter(events => {
        const res = events.every(event =>
          tokenAddressesInEvent(event).every(address =>
            tokens.some(token => compareString(token.id, address))
          )
        );
        return res;
      })
      .map(events =>
        events.map(event =>
          decodedToTimedDecoded(event, blockNow.currentBlock, timeNow)
        )
      )
      .map(events =>
        removeLiquidityEventToView(
          events,
          tokens,
          hash =>
            generateEtherscanTxLink(
              hash,
              this.currentNetwork == EthNetworks.Ropsten
            ),
          account => generateEtherscanAccountLink(account)
        )
      );

    const addEvents = groupedAddLiquidityEvents
      .filter(events =>
        events.every(event =>
          tokenAddressesInEvent(event).every(address =>
            tokens.some(token => compareString(token.id, address))
          )
        )
      )
      .map(events =>
        events.map(event =>
          decodedToTimedDecoded(event, blockNow.currentBlock, timeNow)
        )
      )
      .map(events =>
        addLiquidityEventToView(
          events,
          tokens,
          hash =>
            generateEtherscanTxLink(
              hash,
              this.currentNetwork == EthNetworks.Ropsten
            ),
          account => generateEtherscanAccountLink(account)
        )
      );

    const conversionEvents = res.conversions
      .filter((event, index) => {
        const res = tokenAddressesInEvent(event).every(address =>
          tokens.some(token => compareString(token.id, address))
        );
        return res;
      })
      .map(event =>
        decodedToTimedDecoded(event, blockNow.currentBlock, timeNow)
      )
      .map(conversion =>
        conversionEventToViewTradeEvent(
          conversion,
          tokens,
          hash =>
            generateEtherscanTxLink(
              hash,
              this.currentNetwork == EthNetworks.Ropsten
            ),
          account => generateEtherscanAccountLink(account)
        )
      );

    return {
      addEvents,
      removeEvents,
      conversionEvents
    };
  }

  get volumeInfo() {
    return this.volumeArr;
  }

  // blockNumber, totalBntVolumeInBntTokens, unixTime
  volumeArr: TotalVolumeAndLiquidity[] = [];

  @mutation setVolume(volumeData: TotalVolumeAndLiquidity[]) {
    this.volumeArr = volumeData;
  }

  @action async pullBntInformation({ latestBlock }: { latestBlock: string }) {
    const rootBlocks = latestBlock;
    const timeNow = moment().unix();

    const averageBlockTimeSeconds = 13;
    const blocksPerMinute = 60 / averageBlockTimeSeconds;
    const blocksPerDay = blocksPerMinute * 60 * 24;
    const blocksPerWeek = blocksPerDay * 7;

    const backBlocks = parseInt(String(blocksPerWeek));
    const blocksToRequest = [...Array(26)]
      .map((_, index) => index + 1)
      .map(backNumber =>
        new BigNumber(rootBlocks)
          .minus(new BigNumber(backBlocks).times(backNumber))
          .toString()
      );
    const data = await totalBntVolumeAtBlocks(blocksToRequest);

    const withTimestamp = data.map(
      ([blockNumber, totalVolume, totalLiquidity]) => {
        const unixTime = estimateBlockTimeUnix(
          Number(blockNumber),
          Number(latestBlock),
          timeNow
        );
        return [
          blockNumber,
          totalVolume,
          totalLiquidity,
          unixTime
        ] as TotalVolumeAndLiquidity;
      }
    );

    this.setVolume(withTimestamp);
  }

  @action async pullEvents({
    networkContract,
    network,
    fromBlock
  }: {
    networkContract: string;
    network: EthNetworks;
    fromBlock: number;
  }) {
    const res = await getLogs(network, networkContract, fromBlock);

    const uniqTxHashes = uniqWith(res.map(x => x.txHash), compareString);

    const groups = uniqTxHashes.map(hash =>
      res.filter(x => compareString(x.txHash, hash))
    );

    const joinStartingAndTerminating = groups.map(
      (trades): DecodedEvent<ConversionEventDecoded> => {
        const firstTrade = trades[0];
        const lastTrade = trades[trades.length - 1];
        const { txHash: firstHash, blockNumber: firstBlockNumber } = firstTrade;
        const haveSameBlockNumber = trades.every(
          trade => trade.blockNumber == firstBlockNumber
        );
        const haveSameTxHash = trades.every(trade => trade.txHash == firstHash);
        if (!(haveSameBlockNumber && haveSameTxHash))
          throw new Error("Trades do not share the same block number and hash");

        return {
          ...firstTrade,
          data: {
            ...firstTrade.data,
            to: lastTrade.data.to
          }
        };
      }
    );
    return joinStartingAndTerminating;
  }

  liquidityHistoryArr: DecodedTimedEvent<ConversionEventDecoded>[] = [];

  @mutation setLiquidityHistory(
    events: DecodedTimedEvent<ConversionEventDecoded>[]
  ) {
    this.liquidityHistoryArr = events
      .slice()
      .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
  }

  get liquidityHistory() {
    const liquidityEvents = this.liquidityHistoryArr;
    const knownTokens = this.tokens;
    if (liquidityEvents.length == 0 || knownTokens.length == 0) {
      return {
        loading: true,
        data: []
      };
    }

    const conversionsSupported = liquidityEvents.filter(event =>
      tokenAddressesInEvent(event).every(tokenAddress =>
        knownTokens.some(t => compareString(tokenAddress, t.id))
      )
    );

    return {
      loading: false,
      data: conversionsSupported.map(conversion =>
        conversionEventToViewTradeEvent(
          conversion,
          knownTokens,
          hash =>
            generateEtherscanTxLink(
              hash,
              this.currentNetwork == EthNetworks.Ropsten
            ),
          account => generateEtherscanAccountLink(account)
        )
      )
    };
  }

  @action async blockNumberHoursAgo(hours: number) {
    const currentBlock = await web3.eth.getBlockNumber();
    const secondsPerBlock = 13.3;
    const secondsToRewind = moment.duration(hours, "hours").asSeconds();
    const blocksToRewind = parseInt(
      new BigNumber(secondsToRewind).div(secondsPerBlock).toString()
    );
    console.log(secondsToRewind, "are seconds to rewind", blocksToRewind);
    return {
      blockHoursAgo: currentBlock - blocksToRewind,
      currentBlock
    };
  }

  get availableBalances(): ViewLockedBalance[] {
    const now = moment();
    const bntPrice = this.bntUsdPrice;
    const balances = this.lockedBalancesArr.filter(lockedBalance =>
      moment.unix(lockedBalance.expirationTime).isSameOrBefore(now)
    );
    if (balances.length == 0) return [];

    if (balances.length == 1) {
      const balance = balances[0];
      const decBnt = shrinkToken(balance.amountWei, 18);
      const usdValue = new BigNumber(decBnt).times(bntPrice).toNumber();
      return [
        {
          id: String(balance.expirationTime),
          amount: decBnt,
          lockedUntil: balance.expirationTime,
          usdValue
        }
      ];
    }
    return [
      balances
        .map(
          (balance): ViewLockedBalance => {
            const decBnt = shrinkToken(balance.amountWei, 18);
            const usdValue = new BigNumber(decBnt).times(bntPrice).toNumber();
            return {
              id: String(balance.expirationTime),
              amount: decBnt,
              lockedUntil: balance.expirationTime,
              usdValue
            };
          }
        )
        .reduce((acc, item) => ({
          ...item,
          amount: new BigNumber(acc.amount).plus(item.amount).toString()
        }))
    ];
  }

  get lockedBalances(): ViewLockedBalance[] {
    const now = moment();
    const bntPrice = this.bntUsdPrice;
    const balances = this.lockedBalancesArr.filter(lockedBalance =>
      moment.unix(lockedBalance.expirationTime).isAfter(now)
    );
    return balances.map(
      (balance): ViewLockedBalance => {
        const decBnt = shrinkToken(balance.amountWei, 18);
        const usdValue = new BigNumber(decBnt).times(bntPrice).toNumber();
        return {
          id: String(balance.expirationTime),
          amount: decBnt,
          lockedUntil: balance.expirationTime,
          usdValue: usdValue
        };
      }
    );
  }

  @action async init(params?: ModuleParam) {
    console.log(params, "was init param on eth");
    console.time("ethResolved");
    console.time("timeToGetToInitialBulk");
    if (this.initiated) {
      console.log("returning already");
      return this.refresh();
    }

    BigNumber.config({ EXPONENTIAL_AT: 256 });

    const web3NetworkVersion = await web3.eth.getChainId();
    const currentNetwork: EthNetworks = web3NetworkVersion;
    console.log(currentNetwork, "is the current network");
    this.setNetwork(currentNetwork);
    const networkVariables = getNetworkVariables(currentNetwork);

    const testnetActive = currentNetwork == EthNetworks.Ropsten;

    if (
      params &&
      params.tradeQuery &&
      params.tradeQuery.quote &&
      testnetActive
    ) {
      params.tradeQuery.quote = networkVariables.bntToken;
    }

    try {
      let bancorApiTokens: TokenPrice[] = [];

      this.warmEthApi()
        .then(tokens => {
          bancorApiTokens = tokens;
        })
        .catch(_ => {});

      fetchSmartTokens()
        .then(availableSmartTokenHistories =>
          this.setAvailableHistories(
            availableSmartTokenHistories.map(history => history.id)
          )
        )
        .catch(_ => {});

      getTokenMeta(currentNetwork).then(this.setTokenMeta);
      this.fetchUsdPriceOfBnt();

      console.time("FirstPromise");
      const [
        contractAddresses,
        { currentBlock, blockHoursAgo }
      ] = await Promise.all([
        this.fetchContractAddresses(networkVariables.contractRegistry),
        this.blockNumberHoursAgo(24)
      ]);

      console.log(contractAddresses, "are contract addresses");

      this.pullBntInformation({ latestBlock: String(currentBlock) });
      this.fetchLiquidityProtectionSettings(
        contractAddresses.LiquidityProtection
      );
      this.fetchWhiteListedV1Pools(contractAddresses.LiquidityProtectionStore);
      if (this.isAuthenticated) {
        this.fetchProtectionPositions(
          contractAddresses.LiquidityProtectionStore
        );
        this.fetchLockedBalances(contractAddresses.LiquidityProtectionStore);
      }

      console.log(contractAddresses, "are contract addresses");
      console.timeEnd("FirstPromise");

      console.time("SecondPromise");
      const [registeredAnchorAddresses, currentBlockInfo] = await Promise.all([
        this.fetchAnchorAddresses(contractAddresses.BancorConverterRegistry),
        web3.eth.getBlock(currentBlock)
      ]);

      (async () => {
        const events = await this.pullEvents({
          network: currentNetwork,
          networkContract: contractAddresses.BancorNetwork,
          fromBlock: blockHoursAgo
        });
        const withDates = events.map(event =>
          decodedToTimedDecoded(
            event,
            currentBlock,
            Number(currentBlockInfo.timestamp)
          )
        );

        this.setLiquidityHistory(withDates);
      })();

      console.timeEnd("SecondPromise");

      this.setRegisteredAnchorAddresses(registeredAnchorAddresses);

      console.time("ThirdPromise");
      const [
        anchorAndConvertersMatched,
        bareMinimumAnchorAddresses
      ] = await Promise.all([
        this.add(registeredAnchorAddresses),
        this.bareMinimumPools({
          params,
          networkContractAddress: contractAddresses.BancorNetwork,
          anchorAddressess: registeredAnchorAddresses,
          ...(bancorApiTokens &&
            bancorApiTokens.length > 0 && { tokenPrices: bancorApiTokens })
        })
      ]);
      console.timeEnd("ThirdPromise");

      const blackListedAnchors = ["0x7Ef1fEDb73BD089eC1010bABA26Ca162DFa08144"];

      const passedAnchorAndConvertersMatched = anchorAndConvertersMatched.filter(
        notBlackListed(blackListedAnchors)
      );

      const requiredAnchors = bareMinimumAnchorAddresses.map(anchor =>
        findOrThrow(
          passedAnchorAndConvertersMatched,
          item => compareString(item.anchorAddress, anchor),
          "failed to find required anchors"
        )
      );

      const priorityAnchors = await this.poolsByPriority({
        anchorAddressess: passedAnchorAndConvertersMatched.map(
          x => x.anchorAddress
        ),
        tokenPrices: bancorApiTokens
      });

      const initialLoad = uniqWith(
        [...requiredAnchors],
        compareAnchorAndConverter
      );

      const remainingLoad = sortAlongSide(
        differenceWith(
          passedAnchorAndConvertersMatched,
          initialLoad,
          compareAnchorAndConverter
        ),
        anchor => anchor.anchorAddress,
        priorityAnchors
      );

      console.timeEnd("timeToGetToInitialBulk");

      const linkV2Anchor = "0xC42a9e06cEBF12AE96b11f8BAE9aCC3d6b016237";

      const linkPool = anchorAndConvertersMatched.find(anchor =>
        compareString(anchor.anchorAddress, linkV2Anchor)
      );
      if (linkPool) {
        const alreadyExisting = initialLoad.find(anchor =>
          compareString(anchor.anchorAddress, linkV2Anchor)
        );
        if (!alreadyExisting) {
          initialLoad.push(linkPool);
        }
      }

      const res = await this.addPools({
        sync: initialLoad,
        async: remainingLoad
      });
      console.log(res, "was res with initial pull of", initialLoad);
      console.timeEnd("initialPools");

      this.moduleInitiated();

      if (this.relaysList.length < 1) {
        console.error("Init resolved with less than 2 relay feeds or 1 relay.");
      }

      if (this.tokens.length == 0 || this.relays.length == 0) {
        throw new Error("Failed to load tokens or relays");
      }
      console.log("resolved with", this.tokens, this.relays);
      // @ts-ignore
      console.log("Eth resolving at", new Date() / 1);
      console.timeEnd("ethResolved");
    } catch (e) {
      console.error(`Threw inside ethBancor ${e.message}`);
      throw new Error(`Threw inside ethBancor ${e.message}`);
    }
  }

  @action async addPools({
    sync,
    async
  }: {
    sync: ConverterAndAnchor[];
    async: ConverterAndAnchor[];
  }) {
    const passedAsyncPools = async.filter(notBadRelay);
    const passedSyncPools = sync.filter(notBadRelay);

    const longToLoadConverters = [
      "0xfb64059D18BbfDc5EEdCc6e65C9F09de8ccAf5b6",
      "0xB485A5F793B1DEadA32783F99Fdccce9f28aB9a2",
      "0x444Bd9a308Bd2137208ABBcc3efF679A90d7A553",
      "0x5C8c7Ef16DaC7596C280E70C6905432F7470965E",
      "0x40c7998B5d94e00Cd675eDB3eFf4888404f6385F",
      "0x0429e43f488D2D24BB608EFbb0Ee3e646D61dE71",
      "0x7FF01DB7ae23b97B15Bc06f49C45d6e3d84df46f",
      "0x16ff969cC3A4AE925D9C0A2851e2386d61E75954",
      "0x72eC2FF62Eda1D5E9AcD6c4f6a016F0998ba1cB0",
      "0xcAf6Eb14c3A20B157439904a88F00a8bE929c887"
    ];

    const [slowLoadAnchorSets, quickLoadAnchorSet] = partition(
      passedAsyncPools,
      anchorSet =>
        longToLoadConverters.some(converter =>
          compareString(converter, anchorSet.converterAddress)
        )
    );

    const quickChunks = chunk(quickLoadAnchorSet, 30);

    const allASyncChunks = [...quickChunks, slowLoadAnchorSets];

    (async () => {
      try {
        const tokenAddresses = await Promise.all(
          allASyncChunks.map(this.addPoolsBulk)
        );
        const uniqueTokenAddreses = uniqWith(
          tokenAddresses
            .filter(Boolean)
            .filter(x => Array.isArray(x) && x.length > 0)
            .flat(1) as string[],
          compareString
        );
        if (this.isAuthenticated) {
          this.fetchBulkTokenBalances(uniqueTokenAddreses);
        }
        this.setLoadingPools(false);
      } catch (e) {
        console.log("Failed loading pools");
        this.setLoadingPools(false);
      }
    })();

    const tokenAddresses = await this.addPoolsBulk(passedSyncPools);
    if (this.isAuthenticated) {
      this.fetchBulkTokenBalances(uniqWith(tokenAddresses, compareString));
    }
  }

  @action async getPoolsViaSubgraph(): Promise<V2Response> {
    interface ConverterRes {
      activated: boolean;
      anchor: string;
      balances: Balance[];
      conversionFee: string;
      factory: string;
      id: string;
      type: string;
      version: string;
    }

    interface Balance {
      balance: string;
      poolToken: null | PoolToken;
      stakedAmount: string;
      token: Token;
      weight: string;
    }

    interface Token {
      id: string;
      symbol: string;
      decimals: string;
    }

    interface PoolToken {
      id: string;
      supply: string;
      symbol: string;
    }

    const res = (await bancorSubgraph(`
    {
      converters(where: {activated: true}, orderBy: createdAtBlockNumber, orderDirection: desc) {
        id
        activated
        anchor
        factory
        conversionFee
        type
        version
        balances {
          poolToken {
            id
            symbol
            supply
          }
          token {
            id
            symbol
            decimals
          }
          stakedAmount
          balance
          weight
        }
      }
    }
    `)) as { converters: ConverterRes[] };

    const v1Relays = res.converters.filter(converter => converter.type == "1");

    const tokenMeta = this.tokenMeta;
    const anchorAddresses = v1Relays.map(relay => relay.anchor);
    const localKnownAnchors = anchorAddresses.filter(address => {
      const meta = tokenMeta.find(meta =>
        compareString(meta.contract, address)
      );
      return (
        meta &&
        (typeof meta.precision == "number" || typeof meta.precision == "string")
      );
    });
    const remainingTokens = differenceWith(
      anchorAddresses,
      localKnownAnchors,
      compareString
    );

    const shapes = remainingTokens.map(tokenShape);
    const [tokens] = (await this.multi([shapes])) as [
      [{ symbol: string; decimals: string; contract: string }]
    ];

    const localTokens = localKnownAnchors.map(anchor =>
      findOrThrow(tokenMeta, meta => compareString(meta.contract, anchor))
    );
    const allTokens = [
      ...localTokens.map(meta => ({ ...meta, decimals: meta.precision! })),
      ...tokens
    ];

    const v1RelaysWithBalances = v1Relays.map(
      (relay): RelayWithReserveBalances => {
        const foundAnchor = findOrThrow(allTokens, token =>
          compareString(token.contract, relay.anchor)
        );

        const anchor = {
          ...foundAnchor,
          decimals: Number(foundAnchor.decimals),
          network: "ETH"
        } as SmartToken;
        return {
          anchor,
          contract: relay.id,
          fee: Number(relay.conversionFee),
          converterType: PoolType.Traditional,
          id: relay.anchor,
          isMultiContract: false,
          network: "ETH",
          owner: ethReserveAddress,
          reserveBalances: relay.balances.map(balance => ({
            id: balance.token.id,
            amount: balance.balance
          })),
          reserves: relay.balances.map(balance => ({
            network: "ETH",
            contract: balance.token.id,
            decimals: Number(balance.token.decimals),
            reserveWeight: Number(balance.weight),
            symbol: balance.token.symbol
          })),
          version: relay.version
        };
      }
    );

    const bntTokenAddress = getNetworkVariables(this.currentNetwork).bntToken;

    const reserveFeeds = buildPossibleReserveFeedsTraditional(
      v1RelaysWithBalances,
      [
        { id: bntTokenAddress, usdPrice: String(this.bntUsdPrice) },
        ...trustedStables(this.currentNetwork)
      ]
    );

    return {
      pools: v1RelaysWithBalances,
      reserveFeeds
    };
  }

  @action async addPoolsBulk(convertersAndAnchors: ConverterAndAnchor[]) {
    if (!convertersAndAnchors || convertersAndAnchors.length == 0) return;

    this.setLoadingPools(true);

    const { pools, reserveFeeds } = await this.addPoolsV2(convertersAndAnchors);

    const allPools = [...pools];
    const allReserveFeeds = [...reserveFeeds];

    const poolsFailed = differenceWith(convertersAndAnchors, allPools, (a, b) =>
      compareString(a.anchorAddress, b.id)
    );
    this.updateFailedPools(
      poolsFailed.map(failedPool => failedPool.anchorAddress)
    );

    this.updateRelays(allPools);
    this.updateRelayFeeds(
      await this.addPossiblePropsFromBancorApi(allReserveFeeds)
    );

    const tokenAddresses = pools
      .flatMap(tokensInRelay)
      .map(token => token.contract);

    return tokenAddresses;
  }

  @action async fetchBulkTokenBalances(tokenContractAddresses: string[]) {
    const governanceToken =
      web3.utils.isAddress(this.liquidityProtectionSettings.govToken) &&
      this.liquidityProtectionSettings.govToken;
    if (governanceToken) {
      tokenContractAddresses.push(this.liquidityProtectionSettings.govToken);
    }
    const uniqueAddresses = uniqWith(
      tokenContractAddresses.filter(web3.utils.isAddress),
      compareString
    );
    uniqueAddresses.forEach(tokenContractAddress =>
      this.getUserBalance({ tokenContractAddress })
    );
  }

  @action async fetchConverterAddressesByAnchorAddresses(
    anchorAddresses: string[]
  ) {
    return getConvertersByAnchors({
      anchorAddresses,
      converterRegistryAddress: this.contracts.BancorConverterRegistry
    });
  }

  @action async fetchAnchorAddresses(converterRegistryAddress: string) {
    return getAnchors(converterRegistryAddress);
  }

  @mutation updateRelays(relays: Relay[]) {
    const allReserves = this.relaysList
      .concat(relays)
      .flatMap(relay => relay.reserves);
    const uniqueTokens = uniqWith(allReserves, (a, b) =>
      compareString(a.contract, b.contract)
    );

    const decimalUniformityBetweenTokens = uniqueTokens.every(token => {
      const allReservesTokenFoundIn = allReserves.filter(reserve =>
        compareString(token.contract, reserve.contract)
      );
      return allReservesTokenFoundIn.every(
        (reserve, _, arr) => reserve.decimals == arr[0].decimals
      );
    });
    if (!decimalUniformityBetweenTokens) {
      console.error(
        `There is a mismatch of decimals between relays of the same token, will not store ${relays.length} new relays`
      );
      return;
    }

    const meshedRelays = uniqWith(
      [...relays, ...this.relaysList],
      compareRelayById
    ).map(relay => ({
      ...relay,
      reserves: sortByNetworkTokens(
        updateArray(
          relay.reserves,
          reserve => !reserve.meta,
          reserve => {
            const meta = this.tokenMeta.find(meta =>
              compareString(reserve.contract, meta.contract)
            );
            return {
              ...reserve,
              meta: {
                logo: (meta && meta.image) || defaultImage,
                ...(meta && meta!.name && { name: meta.name })
              }
            };
          }
        ),
        reserve => reserve.symbol
      )
    }));
    console.log(
      "vuex given",
      relays.length,
      "relays and setting",
      meshedRelays.length
    );
    this.relaysList = Object.freeze(meshedRelays);
  }

  @mutation wipeTokenBalances() {
    this.tokenBalances = [];
  }

  @action async onAuthChange(userAddress: string) {
    this.wipeTokenBalances();
    if (userAddress) {
      const govAddress = web3.utils.isAddress(
        this.liquidityProtectionSettings.govToken
      );
      if (govAddress) {
        this.fetchBulkTokenBalances([
          this.liquidityProtectionSettings.govToken
        ]);
      }
      console.log(userAddress, "fetching protected positions for");
      this.fetchProtectionPositions();
      this.fetchLockedBalances();
      const allTokens = this.relaysList.flatMap(tokensInRelay);
      const uniqueTokenAddresses = uniqWith(
        allTokens.map(token => token.contract),
        compareString
      );
      uniqueTokenAddresses.forEach(tokenContractAddress =>
        this.getUserBalance({
          tokenContractAddress,
          userAddress
        })
      );
    }
  }

  @action async focusPool(id: string): Promise<FocusPoolRes> {
    const pool = await this.relayById(id);
    const converterAddress = pool.contract;
    const yesterday = await this.blockNumberHoursAgo(24);

    const res = await this.pullConverterEvents({
      converterAddress,
      network: this.currentNetwork,
      fromBlock: yesterday.blockHoursAgo
    });
    console.log(res, "was returned from focus pool");

    return res;
  }

  @action async focusSymbol(id: string) {
    if (!this.isAuthenticated) return;
    const tokenContractAddress = findOrThrow(
      this.tokens,
      token => compareString(token.contract, id),
      `failed to find this token contract address (${id})`
    ).contract;
    const balance = await vxm.ethWallet.getBalance({
      accountHolder: this.isAuthenticated,
      tokenContractAddress
    });
    this.updateBalance([id!, balance]);

    const tokenTracked = this.tokens.find(token => compareString(token.id, id));
    if (!tokenTracked) {
      this.loadMoreTokens([id]);
    }
  }

  @mutation updateBalance([id, balance]: [string, string]) {
    const newBalances = this.tokenBalances.filter(
      balance => !compareString(balance.id, id)
    );
    if (new BigNumber(balance).gt(0)) {
      newBalances.push({ id, balance });
    }
    this.tokenBalances = newBalances;
  }

  @action async refreshBalances(symbols?: BaseToken[]) {
    if (symbols) {
      symbols.forEach(symbol => this.focusSymbol(symbol.symbol));
    }
  }

  @action async mintEthErcIfRequired(decString: string) {
    const contract = buildTokenContract(ethErc20WrapperContract);
    const currentBalance = await contract.methods
      .balanceOf(this.isAuthenticated)
      .call();

    const currentBalanceDec = shrinkToken(currentBalance, 18);

    const mintingRequired = new BigNumber(decString).gt(currentBalanceDec);
    if (mintingRequired) {
      return this.mintEthErc(decString);
    }
  }

  @action async tokenById(id: string) {
    return findOrThrow(
      this.tokens,
      token => compareString(token.id, id),
      `tokenById failed to find token with ID ${id} `
    );
  }

  @action async tokensById(ids: string[]) {
    return Promise.all(ids.map(id => this.tokenById(id)));
  }

  @action async findPath({
    fromId,
    toId,
    relays
  }: {
    fromId: string;
    toId: string;
    relays: readonly Relay[];
  }) {
    const lowerCased = relays.map(relay => ({
      ...relay,
      reserves: relay.reserves.map(reserve => ({
        ...reserve,
        contract: reserve.contract.toLowerCase()
      }))
    }));
    const path = await findNewPath(
      fromId.toLowerCase(),
      toId.toLowerCase(),
      lowerCased,
      relay => [relay.reserves[0].contract, relay.reserves[1].contract]
    );

    const flattened = path.hops.flatMap(hop => hop[0]);
    return flattened.map(flat =>
      findOrThrow(
        relays,
        relay => compareString(relay.contract, flat.contract),
        "failed to find relays used in pathing"
      )
    );
  }

  @action async convert({
    from,
    to,
    onUpdate
  }: ProposedConvertTransaction): Promise<TxResponse> {
    if (compareString(from.id, to.id))
      throw new Error("Cannot convert a token to itself.");
    const [fromToken, toToken] = await this.tokensById([from.id, to.id]);
    const fromIsEth = compareString(fromToken.symbol, "eth");

    const steps: Section[] = [
      {
        name: "Pathing",
        description: "Finding path..."
      },
      {
        name: "SetApprovalAmount",
        description: "Setting approval amount..."
      },
      {
        name: "ConvertProcessing",
        description: "Processing conversion..."
      },
      {
        name: "WaitingTxConf",
        description: "Awaiting block confirmation..."
      },
      {
        name: "Done",
        description: "Done!"
      }
    ];

    onUpdate!(0, steps);

    const fromTokenDecimals = await this.getDecimalsByTokenAddress(
      fromToken.id
    );
    const toTokenDecimals = await this.getDecimalsByTokenAddress(toToken.id);

    const relaysByLiqDepth = this.relays.sort(sortByLiqDepth);
    const relaysList = sortAlongSide(
      this.relaysList,
      relay => relay.id,
      relaysByLiqDepth.map(relay => relay.id)
    );
    const winningRelays = uniqWith(relaysList, compareRelayByReserves);

    const relays = await this.findPath({
      relays: winningRelays,
      fromId: from.id,
      toId: to.id
    });

    const fromAmount = from.amount;
    const fromSymbol = fromToken.symbol;
    const fromTokenContract = fromToken.id;
    const toTokenContract = toToken.id;

    const ethPath = generateEthPath(fromSymbol, relays.map(relayToMinimal));

    const fromWei = expandToken(fromAmount, fromTokenDecimals);

    if (!fromIsEth) {
      onUpdate!(1, steps);
      await this.triggerApprovalIfRequired({
        owner: this.isAuthenticated,
        amount: fromWei,
        spender: this.contracts.BancorNetwork,
        tokenAddress: fromTokenContract
      });
    }

    onUpdate!(2, steps);

    const networkContract = buildNetworkContract(this.contracts.BancorNetwork);

    const expectedReturn = to.amount;
    const expectedReturnWei = expandToken(expectedReturn, toTokenDecimals);

    const confirmedHash = await this.resolveTxOnConfirmation({
      tx: networkContract.methods.convertByPath(
        ethPath,
        fromWei,
        await this.weiMinusSlippageTolerance(expectedReturnWei),
        zeroAddress,
        zeroAddress,
        0
      ),
      ...(fromIsEth && { value: fromWei }),
      onHash: () => onUpdate!(3, steps)
    });
    onUpdate!(4, steps);

    this.spamBalances([fromTokenContract, toTokenContract]);

    return {
      txId: confirmedHash,
      blockExplorerLink: await this.createExplorerLink(confirmedHash)
    };
  }

  @action async triggerApprovalIfRequired({
    owner,
    spender,
    amount,
    tokenAddress
  }: {
    owner: string;
    spender: string;
    tokenAddress: string;
    amount: string;
  }) {
    const currentApprovedBalance = await getApprovedBalanceWei({
      owner,
      spender,
      tokenAddress
    });

    const noNullingTokenContracts = [this.liquidityProtectionSettings.govToken];

    const sufficientBalanceAlreadyApproved = new BigNumber(
      currentApprovedBalance
    ).isGreaterThanOrEqualTo(amount);

    if (sufficientBalanceAlreadyApproved) return;

    const isNoNullingTokenContract = noNullingTokenContracts.some(contract =>
      compareString(tokenAddress, contract)
    );

    const nullingTxRequired =
      fromWei(currentApprovedBalance) !== "0" && !isNoNullingTokenContract;
    if (nullingTxRequired) {
      await this.approveTokenWithdrawals([
        { approvedAddress: spender, amount: toWei("0"), tokenAddress }
      ]);
    }

    return this.approveTokenWithdrawals([
      { approvedAddress: spender, amount, tokenAddress }
    ]);
  }

  @action async getReturnByPath({
    path,
    amount
  }: {
    path: string[];
    amount: string;
  }): Promise<string> {
    return getReturnByPath({
      networkContract: this.contracts.BancorNetwork,
      path,
      amount
    });
  }

  @action async getDecimalsByTokenAddress(tokenAddress: string) {
    if (compareString(tokenAddress, ethReserveAddress)) return 18;
    const reserve = this.relaysList
      .flatMap(relay => relay.reserves)
      .find(reserve => compareString(reserve.contract, tokenAddress));
    if (!reserve) {
      try {
        const contract = buildTokenContract(tokenAddress);
        const decimals = await contract.methods.decimals().call();
        return Number(decimals);
      } catch (e) {
        throw new Error(
          `Failed to find token address ${tokenAddress} in list of reserves. ${e.message}`
        );
      }
    }
    return reserve.decimals;
  }

  @action async calculateSingleWithdraw({
    id,
    decPercent
  }: {
    id: string;
    decPercent: number;
  }): Promise<{
    outputs: ViewAmountDetail[];
    expectedValue: ViewAmountDetail;
  }> {
    const [pool, posId] = id.split(":");
    const ppm = new BigNumber(decPercent).times(oneMillion).toString();
    const res = await getRemoveLiquidityReturn(
      this.contracts.LiquidityProtection,
      posId,
      ppm,
      moment().unix()
    );

    const position = findOrThrow(
      this.protectedPositionsArr,
      pos => compareString(pos.id, posId),
      "failed finding protected position"
    );
    const { reserveToken, reserveAmount } = position;

    const reserveTokenObj = findOrThrow(
      this.relaysList.flatMap(r => r.reserves),
      reserve => compareString(reserveToken, reserve.contract)
    );

    return {
      outputs: [
        {
          amount: shrinkToken(res.baseAmount, reserveTokenObj.decimals),
          id: reserveToken,
          symbol: reserveTokenObj.symbol
        },
        {
          amount: shrinkToken(res.networkAmount, 18),
          id: this.liquidityProtectionSettings.networkToken,
          symbol: "BNT"
        }
      ].filter(output => new BigNumber(output.amount).isGreaterThan(0)),
      expectedValue: {
        amount: shrinkToken(res.targetAmount, reserveTokenObj.decimals),
        id: reserveToken,
        symbol: reserveTokenObj.symbol
      }
    };
  }

  @action async getReturn({
    from,
    toId
  }: ProposedFromTransaction): Promise<ConvertReturn> {
    if (compareString(from.id, toId))
      throw new Error("Cannot convert a token to itself.");
    const [fromToken, toToken] = await this.tokensById([from.id, toId]);

    const [fromTokenContract, toTokenContract] = [fromToken.id, toToken.id];
    const amount = from.amount;

    const fromTokenDecimals = await this.getDecimalsByTokenAddress(
      fromTokenContract
    );
    const toTokenDecimals = await this.getDecimalsByTokenAddress(
      toTokenContract
    );

    const relaysByLiqDepth = this.relays.sort(sortByLiqDepth);
    const relaysList = sortAlongSide(
      this.relaysList,
      relay => relay.id,
      relaysByLiqDepth.map(relay => relay.id)
    );
    const winningRelays = uniqWith(relaysList, compareRelayByReserves);

    const relays = await this.findPath({
      fromId: from.id,
      toId,
      relays: winningRelays
    });

    const path = generateEthPath(fromToken.symbol, relays.map(relayToMinimal));

    console.log(path, "is the path");

    const fromWei = expandToken(amount, fromTokenDecimals);
    try {
      const wei = await this.getReturnByPath({
        path,
        amount: fromWei
      });
      const weiNumber = new BigNumber(wei);

      const userReturnRate = buildRate(new BigNumber(fromWei), weiNumber);

      let slippage: number | undefined;
      try {
        const contract = buildConverterContract(relays[0].contract);
        const fromReserveBalanceWei = await contract.methods
          .getConnectorBalance(fromTokenContract)
          .call();

        const smallPortionOfReserveBalance = new BigNumber(
          fromReserveBalanceWei
        ).times(0.00001);

        if (smallPortionOfReserveBalance.isLessThan(fromWei)) {
          const smallPortionOfReserveBalanceWei = smallPortionOfReserveBalance.toFixed(
            0
          );

          const smallPortionReturn = await this.getReturnByPath({
            path,
            amount: smallPortionOfReserveBalanceWei
          });

          const tinyReturnRate = buildRate(
            new BigNumber(smallPortionOfReserveBalanceWei),
            new BigNumber(smallPortionReturn)
          );

          const slippageNumber = calculateSlippage(
            tinyReturnRate,
            userReturnRate
          );
          slippage = slippageNumber.toNumber();
        }
      } catch (e) {
        console.warn("Failed calculating slippage", e.message);
      }

      return {
        amount: shrinkToken(wei, toTokenDecimals),
        slippage
      };
    } catch (e) {
      if (
        e.message.includes(
          `Returned values aren't valid, did it run Out of Gas? You might also see this error if you are not using the correct ABI for the contract you are retrieving data from`
        )
      ) {
        const relayBalances = await Promise.all(
          relays.map(async relay => ({
            relay,
            balances: await this.fetchRelayBalances({ poolId: relay.id })
          }))
        );
        const relaysWithNoBalances = relayBalances.filter(
          relay =>
            !relay.balances.reserves.every(reserve => reserve.weiAmount !== "0")
        );
        if (relaysWithNoBalances.length > 0) {
          const moreThanOne = relayBalances.length > 1;
          throw new Error(
            moreThanOne
              ? "Pool does not have sufficient reserve balances"
              : "Pool does not have a sufficient reserve balance"
          );
        } else {
          throw new Error(e);
        }
      } else {
        throw new Error(e);
      }
    }
  }

  @action async getCost({ fromId, to }: ProposedToTransaction) {
    if (compareString(fromId, to.id))
      throw new Error("Cannot convert a token to itself.");
    const fromToken = await this.tokenById(fromId);
    const toToken = await this.tokenById(to.id);

    const amount = to.amount;

    const [fromTokenContract, toTokenContract] = [fromToken.id, toToken.id];

    const fromTokenDecimals = await this.getDecimalsByTokenAddress(
      fromTokenContract
    );
    const toTokenDecimals = await this.getDecimalsByTokenAddress(
      toTokenContract
    );

    const relays = this.relaysList;

    const poolIds = relays.map(relay => relay.id);
    const allCoveredUnderBancorApi = poolIds.every(poolId =>
      ethBancorApiDictionary.some(dic =>
        compareString(poolId, dic.smartTokenAddress)
      )
    );
    if (!allCoveredUnderBancorApi)
      throw new Error("Fetching the cost of this token is not yet supported.");

    const [fromTokenTicker, toTokenTicker] = await Promise.all([
      ethBancorApi.getToken(fromToken.symbol),
      ethBancorApi.getToken(toToken.symbol)
    ]);
    const fromTokenId = fromTokenTicker._id;
    const toTokenId = toTokenTicker._id;

    const result = await ethBancorApi.calculateCost(
      fromTokenId,
      toTokenId,
      expandToken(amount, toTokenDecimals)
    );

    return {
      amount: shrinkToken(result, fromTokenDecimals)
    };
  }
}
