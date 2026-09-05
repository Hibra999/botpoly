/**
 * TradingService
 *
 * Trading service using official @polymarket/clob-client.
 *
 * Provides:
 * - Order creation (limit, market)
 * - Order management (cancel, query)
 * - Rewards tracking
 * - Balance management
 *
 * Note: Market data methods have been moved to MarketService.
 */

import { ClobClient, type TickSize } from '../clients/public-clob.js';
import { Wallet } from 'ethers';
import { RateLimiter } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import type { Side, OrderType } from '../core/types.js';

// Chain IDs
export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Polymarket Order Minimums
// ============================================================================
// These are enforced by Polymarket's CLOB API. Orders below these limits will
// be rejected with errors like:
// - "invalid amount for a marketable BUY order ($X), min size: $1"
// - "Size (X) lower than the minimum: 5"
//
// Strategies should ensure orders meet these requirements BEFORE sending.
// ============================================================================

/** Minimum order value in USDC (price * size >= MIN_ORDER_VALUE) */
export const MIN_ORDER_VALUE_USDC = 1;

/** Minimum order size in shares */
export const MIN_ORDER_SIZE_SHARES = 5;

// ============================================================================
// Types
// ============================================================================

// Side and OrderType are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, OrderType } from '../core/types.js';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  /** Private key for signing */
  privateKey: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
  /** Pre-generated API credentials (optional) */
  credentials?: ApiCredentials;
}

// Order types
export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
}

export interface Order {
  id: string;
  status: string;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

// Rewards types
export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

// ============================================================================
// TradingService Implementation
// ============================================================================

/** @deprecated Trading through the old services bypasses global reservations.
 * Only read helpers remain; all mutations are deliberately unavailable. */
export class TradingService {
  private client = new ClobClient();
  private wallet: Wallet;
  private initialized = false;
  constructor(_rateLimiter: RateLimiter, _cache: UnifiedCache, config: TradingServiceConfig) { this.wallet = new Wallet(config.privateKey); }
  async initialize(): Promise<void> { this.initialized = true; }
  async getTickSize(tokenId: string): Promise<TickSize> { return this.client.getTickSize(tokenId); }
  async isNegRisk(tokenId: string): Promise<boolean> { return this.client.getNegRisk(tokenId); }
  private unavailable(): never { throw new Error('Servicio experimental desactivado. Usa el motor central de Botpoly; live requiere validación y activación explícita.'); }
  async createLimitOrder(_params: LimitOrderParams): Promise<OrderResult> { return this.unavailable(); }
  async createMarketOrder(_params: MarketOrderParams): Promise<OrderResult> { return this.unavailable(); }
  async cancelOrder(_id: string): Promise<OrderResult> { return this.unavailable(); }
  async cancelOrders(_ids: string[]): Promise<OrderResult> { return this.unavailable(); }
  async cancelAllOrders(): Promise<OrderResult> { return this.unavailable(); }
  async getOpenOrders(_market?: string): Promise<Order[]> { return this.unavailable(); }
  async getTrades(_market?: string): Promise<TradeInfo[]> { return this.unavailable(); }
  async isOrderScoring(_id: string): Promise<boolean> { return this.unavailable(); }
  async areOrdersScoring(_ids: string[]): Promise<Record<string, boolean>> { return this.unavailable(); }
  async getEarningsForDay(_date: string): Promise<UserEarning[]> { return this.unavailable(); }
  async getCurrentRewards(): Promise<MarketReward[]> { return this.unavailable(); }
  async getBalanceAllowance(_asset: 'COLLATERAL' | 'CONDITIONAL', _token?: string): Promise<{ balance: string; allowance: string }> { return this.unavailable(); }
  async updateBalanceAllowance(_asset: 'COLLATERAL' | 'CONDITIONAL', _token?: string): Promise<void> { return this.unavailable(); }
  getAddress(): string { return this.wallet.address; }
  getWallet(): Wallet { return this.wallet; }
  getCredentials(): ApiCredentials | null { return null; }
  isInitialized(): boolean { return this.initialized; }
  getClobClient(): ClobClient { return this.client; }
}
