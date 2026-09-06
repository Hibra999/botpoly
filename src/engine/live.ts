// Imported dynamically ONLY after explicit live authorization and evidence checks.
import { Wallet, providers, utils } from "ethers";
import {
  createSecureClient,
  buildHmacSignature,
  OrderSide,
  OrderType,
  AssetType,
  type Signer,
  type SignedOrder,
  type TransactionHandle,
  type Market,
} from "@polymarket/client";
import {
  fetchBalanceAllowance,
  prepareMergePositions,
  mergePositions,
  redeemPositions,
  prepareRedeemPositions,
} from "@polymarket/client/actions";
import { Ledger } from "./ledger.js";
import {
  type Execution,
  type Executor,
  type Frame,
  type Order,
  type Settlement,
  fee,
  money,
  strategyBinding,
  validateResolution,
} from "./model.js";
import type { GasQuote } from "../research/market-data.js";

type Secure = Awaited<ReturnType<typeof createSecureClient>>;
const uncertain = (): Execution => ({ status: "uncertain", fills: [] });
export class LiveExecutor implements Executor {
  readonly mode = "live";
  private client!: Secure;
  private provider: providers.JsonRpcProvider;
  private wallet: Wallet;
  private heartbeatId = "";
  private heartbeatAt = 0;
  private mergePermit: string | null = null;
  private signer: Signer;
  private constructor(
    private ledger: Ledger,
    key: string,
    rpc: string,
  ) {
    this.provider = new providers.JsonRpcProvider(rpc, 137);
    this.wallet = new Wallet(key, this.provider);
    this.signer = {
      getAddress: async () =>
        this.wallet.address as Awaited<ReturnType<Signer["getAddress"]>>,
      signMessage: async (value) =>
        (await this.wallet.signMessage(utils.arrayify(value))) as Awaited<
          ReturnType<Signer["signMessage"]>
        >,
      signTypedData: async (payload) => {
        const types = Object.fromEntries(
          Object.entries(payload.types)
            .filter(([key]) => key !== "EIP712Domain")
            .map(([key, fields]) => [key, [...fields]]),
        );
        return (await this.wallet._signTypedData(
          payload.domain,
          types,
          payload.message,
        )) as Awaited<ReturnType<Signer["signTypedData"]>>;
      },
      sendTransaction: async (request) => {
        if (!this.mergePermit || request.chainId !== 137)
          throw new Error("Transacción fuera del motor de riesgo");
        const id = this.mergePermit;
        if (this.ledger.store.get("meta", `live:tx:${id}`))
          throw new Error("Transacción ya preparada: conciliar");
        const populated = await this.wallet.populateTransaction({
          to: request.to,
          data: request.data,
          value: request.value?.toString() ?? "0",
        });
        const raw = await this.wallet.signTransaction(populated),
          hash = utils.keccak256(raw);
        this.ledger.store.put("meta", `live:tx:${id}`, { hash, raw });
        const tx = await this.provider.sendTransaction(raw);
        const handle: TransactionHandle = {
          transactionHash: hash as NonNullable<
            TransactionHandle["transactionHash"]
          >,
          transactionId: null,
          wait: async () => {
            const receipt = await tx.wait(2);
            if (receipt.status !== 1) throw new Error("Transacción fallida");
            return {
              transactionHash: hash as NonNullable<
                TransactionHandle["transactionHash"]
              >,
              transactionId: null,
            };
          },
        };
        return handle;
      },
    };
  }
  static async create(
    ledger: Ledger,
    key: string,
    rpc: string,
  ): Promise<LiveExecutor> {
    const executor = new LiveExecutor(ledger, key, rpc);
    if ((await executor.provider.getNetwork()).chainId !== 137)
      throw new Error("RPC de otra red");
    // Explicit EOA prevents the SDK from deploying a wallet during authentication.
    executor.client = await createSecureClient({
      signer: executor.signer,
      wallet: executor.wallet.address,
    });
    return executor;
  }
  async checkBalances(): Promise<void> {
    const collateral = await fetchBalanceAllowance(this.client, {
      assetType: AssetType.COLLATERAL,
    });
    const actual = Number(collateral.balance) / 1e6;
    if (
      !Number.isFinite(actual) ||
      Math.abs(actual - this.ledger.account.cash - this.ledger.account.gas) >
        0.01
    )
      throw new Error(
        "Saldo CLOB no coincide con el libro contable; registrar depósito o retirada y conciliar",
      );
    const held = new Map<string, number>();
    for await (const page of this.client.listPositions())
      for (const p of page.items) {
        if (!p.assetId) throw new Error("Posición sin activo");
        held.set(p.assetId, Number(p.size));
      }
    for (const p of this.ledger.positions) {
      if (Math.abs((held.get(p.tokenId) ?? 0) - p.quantity) > 0.000001)
        throw new Error("Posición remota inconsistente");
      held.delete(p.tokenId);
    }
    if ([...held.values()].some((q) => q > 0.000001))
      throw new Error("Posiciones externas no contabilizadas");
    for await (const page of this.client.listOpenOrders())
      for (const o of page.items)
        if (
          !this.ledger.store
            .all<Order>("orders")
            .some((local) => local.externalId === o.id)
        )
          throw new Error("Orden externa no contabilizada");
  }
  async heartbeat(): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000),
      path = "/heartbeats",
      body = JSON.stringify({ heartbeat_id: this.heartbeatId });
    const credentials = this.client.credentials;
    try {
      const response = await fetch("https://clob.polymarket.com" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          POLY_ADDRESS: this.wallet.address,
          POLY_TIMESTAMP: String(timestamp),
          POLY_API_KEY: credentials.key,
          POLY_PASSPHRASE: credentials.passphrase,
          POLY_SIGNATURE: await buildHmacSignature(
            credentials.secret,
            timestamp,
            "POST",
            path,
            body,
          ),
        },
        body,
        signal: AbortSignal.timeout(4000),
      });
      const result = (await response.json()) as { heartbeat_id?: string };
      if (typeof result.heartbeat_id === "string")
        this.heartbeatId = result.heartbeat_id;
      if (!response.ok || !result.heartbeat_id) throw new Error();
      this.heartbeatAt = Date.now();
    } catch {
      this.ledger.stop("Heartbeat del mercado perdido");
      throw new Error("Heartbeat no disponible");
    }
  }
  async execute(order: Order): Promise<Execution> {
    const approved=this.ledger.store.get<ReturnType<typeof strategyBinding>[]>("meta","live:strategies");
    if (!approved?.some(binding=>JSON.stringify(binding) === JSON.stringify(strategyBinding(order.strategy ?? "yes-no",this.ledger.config)))) throw new Error("Estrategia live sin evidencia vinculada a esta configuración");
    if (Date.now() - this.heartbeatAt > 5000) return uncertain();
    if (this.ledger.store.get("meta", `live:signed:${order.id}`))
      return this.reconcile(order);
    // The order's signature fixes price and number of shares. Time-in-force is
    // posting metadata; force FOK instead of the limit builder's GTC default.
    const signed: SignedOrder = {
      ...(await this.client.createLimitOrder({
        assetId: order.tokenId,
        price: order.limit,
        size: order.quantity,
        side: order.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
      })),
      orderType: OrderType.FOK,
    };
    this.ledger.store.put("meta", `live:signed:${order.id}`, signed);
    const result = await this.client.postOrder(signed);
    if (!result.ok) return { status: "rejected", fills: [] };
    order.externalId = result.orderId;
    this.ledger.store.put("orders", order.id, {
      ...order,
      status: "submitted",
    });
    this.ledger.store.put("meta", `live:response:${order.id}`, result);
    if (result.status !== "matched" || !result.tradeIds.length)
      return uncertain();
    await this.client.waitForOrderFillSettlement(result, { timeoutMs: 30000 });
    return this.reconcile(order);
  }
  async reconcile(order: Order): Promise<Execution> {
    const id =
      order.externalId ??
      this.ledger.store.get<Order>("orders", order.id)?.externalId;
    if (!id) return uncertain(); // No provable external identity: never infer rejection.
    const remote = await this.client.fetchOrder({ orderId: id });
    const fills: Execution["fills"] = [];
    let pending = false;
    for await (const page of this.client.listAccountTrades({
      assetId: order.tokenId,
      after: String(Math.floor(order.timestamp / 1000) - 60),
    })) {
      for (const t of page.items.filter((t) => t.takerOrderId === id)) {
        if (t.status !== "CONFIRMED" || !t.transactionHash) {
          if (t.status !== "FAILED") pending = true;
          continue;
        }
        const receipt = await this.provider.getTransactionReceipt(
          t.transactionHash,
        );
        if (!receipt || receipt.status !== 1 || receipt.confirmations < 2) {
          pending = true;
          continue;
        }
        const quantity = Number(t.size),
          price = Number(t.price),
          rate = Number(t.feeRateBps) / 10000;
        fills.push({
          id: t.id,
          orderId: order.id,
          quantity,
          gross: money(quantity * price),
          fees: fee(quantity, price, rate),
          timestamp: Date.parse(t.matchedAt),
        });
      }
    }
    if (
      pending ||
      Math.abs(
        fills.reduce((n, f) => n + f.quantity, 0) - Number(remote.sizeMatched),
      ) > 1e-6
    )
      return { status: "uncertain", fills, externalId: id };
    if (
      fills.length &&
      ["MATCHED", "FILLED", "CANCELED", "CANCELLED"].includes(
        remote.status.toUpperCase(),
      )
    )
      return { status: "confirmed", fills, externalId: id };
    if (
      !fills.length &&
      ["CANCELED", "CANCELLED", "EXPIRED"].includes(remote.status.toUpperCase())
    )
      return { status: "rejected", fills: [], externalId: id };
    return { status: "uncertain", fills, externalId: id };
  }
  async cancel(order: Order): Promise<Execution> {
    if (!order.externalId) return this.reconcile(order);
    await this.client.cancelOrder({ orderId: order.externalId });
    return this.reconcile(order);
  }
  private async nativeUsd(): Promise<number> {
    const response = await fetch(
      "https://api.coinbase.com/v2/prices/POL-USD/spot",
      { signal: AbortSignal.timeout(5000) },
    );
    const data = (await response.json()) as {
      data?: { amount?: string; currency?: string };
    };
    const price = Number(data.data?.amount);
    if (
      !response.ok ||
      data.data?.currency !== "USD" ||
      !Number.isFinite(price) ||
      price <= 0
    )
      throw new Error("Precio de gas no verificable");
    return price;
  }
  async estimateGas(market: Market): Promise<GasQuote | undefined> {
    if (!market.conditionId) return undefined;
    try {
      // This only advances to the unsigned request; it never signs or submits.
      const directional = this.ledger.positions.some(p=>p.marketId === market.conditionId && p.strategy === "football-value");
      const workflow = directional ? await prepareRedeemPositions(this.client,{conditionId:market.conditionId}) : await prepareMergePositions(this.client, {
        conditionId: market.conditionId,
        amount: BigInt(
          Math.ceil(Number(market.trading.minimumOrderSize ?? 5) * 1e6),
        ),
      });
      let step = await workflow.next();
      if (!step.done && step.value.kind === "requestAddress")
        step = await workflow.next(await this.signer.getAddress());
      if (step.done || !["sendMergePositionsTransaction", "sendRedeemPositionsTransaction"].includes(step.value.kind))
        return undefined;
      if (step.done || (step.value.kind !== "sendMergePositionsTransaction" && step.value.kind !== "sendRedeemPositionsTransaction")) return undefined;
      const req = step.value.request;
      const [gas, gasPrice, native] = await Promise.all([
        this.provider.estimateGas({
          from: this.wallet.address,
          to: req.to,
          data: req.data,
          value: req.value?.toString(),
        }),
        this.provider.getGasPrice(),
        this.nativeUsd(),
      ]);
      const usd = money(
        Number(utils.formatEther(gas.mul(gasPrice))) * native * 1.25,
      );
      return {
        mergeGasUsd: usd,
        recoveryGasUsd: 0,
        timestamp: Date.now(),
        verified: true,
        source:
          "eth_estimateGas del calldata de fusión + eth_gasPrice + POL/USD, margen 25%; recuperación CLOB sin gas pagado por esta EOA",
      };
    } catch {
      return undefined;
    } // No fixed gas fallback, e.g. estimate reverts without holdings.
  }
  async merge(id: string, frame: Frame, quantity: number): Promise<Settlement> {
    const existing = this.ledger.store.get<{ hash: string }>(
      "meta",
      `live:tx:${id}`,
    );
    if (!existing?.hash) {
      this.mergePermit = id;
      try {
        const handle = await mergePositions(this.client, {
          conditionId: frame.marketId,
          amount: BigInt(Math.round(quantity * 1e6)),
        });
        await handle.wait();
      } finally {
        this.mergePermit = null;
      }
    }
    return this.reconcileMerge(id, frame, quantity);
  }
  async redeem(id: string, frame: Frame, quantity: number): Promise<Settlement> {
    if (!frame.resolution) throw new Error("Canje sin resolución oficial");
    validateResolution(frame.resolution,Date.now());
    const approved=this.ledger.store.get<ReturnType<typeof strategyBinding>[]>("meta","live:strategies");
    if (!approved?.some(b=>JSON.stringify(b) === JSON.stringify(strategyBinding("football-value",this.ledger.config)))) throw new Error("Canje live sin evidencia de fútbol");
    if (!this.ledger.store.get("meta",`live:tx:${id}`)) {
      this.mergePermit=id;
      try { const handle=await redeemPositions(this.client,{conditionId:frame.marketId}); await handle.wait(); }
      finally { this.mergePermit=null; }
    }
    return this.reconcileRedeem(id,frame,quantity);
  }
  async reconcileRedeem(id: string, frame: Frame, quantity: number): Promise<Settlement> {
    return this.reconcileMerge(id,frame,quantity);
  }
  async reconcileMerge(
    id: string,
    _frame: Frame,
    _quantity: number,
  ): Promise<Settlement> {
    const tx = this.ledger.store.get<{ hash: string }>("meta", `live:tx:${id}`);
    if (!tx) return { id, status: "uncertain", gas: 0, timestamp: Date.now() };
    const receipt = await this.provider.getTransactionReceipt(tx.hash);
    if (!receipt || receipt.confirmations < 2)
      return { id, status: "uncertain", gas: 0, timestamp: Date.now() };
    return {
      id,
      status: receipt.status === 1 ? "confirmed" : "rejected",
      gas: money(
        Number(
          utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice)),
        ) * (await this.nativeUsd()),
      ),
      timestamp: Date.now(),
    };
  }
  async close(): Promise<void> {
    await this.client.closeSubscriptions();
  }
}
