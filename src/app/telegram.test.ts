import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../engine/store.js";
import { Ledger } from "../engine/ledger.js";
import { Engine } from "../engine/engine.js";
import { PaperExecutor } from "../engine/paper.js";
import { defaults } from "../engine/model.js";
import { Controller } from "./control.js";
import { Telegram } from "./telegram.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
it("envía texto y PNG cada hora sin repetir al reiniciar ni recuperar horas antiguas", async () => {
  let now = Date.UTC(2026, 8, 6, 8, 30);
  const store = new Store(":memory:"); stores.push(store);
  const ledger = new Ledger(store, "paper", defaults, () => now);
  const controller = new Controller(new Engine(ledger, new PaperExecutor("paper", async () => undefined)));
  const reports = mkdtempSync(join(tmpdir(), "botpoly-telegram-"));
  const calls: string[] = [];
  const request = vi.fn(async (url, options) => {
    calls.push(String(url).split("/").at(-1)!);
    if (String(url).endsWith("sendPhoto")) expect((options?.body as FormData).get("photo")).toBeInstanceOf(Blob);
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const render = async (dir: string) => { const file = join(dir, "chart.png"); writeFileSync(file, "image"); return file; };
  const create = () => new Telegram(controller, "123456:test", "42", request, () => now, reports, render);
  const bot = create();
  ledger.count("signals");
  await bot.scheduleReports(); await bot.scheduleReports();
  expect(store.all("outbox")).toHaveLength(2);
  await bot.flush(); await bot.flush();
  expect(calls).toEqual(["sendMessage", "sendPhoto"]);
  await create().scheduleReports();
  expect(store.all("outbox")).toHaveLength(0);
  now += 4 * 3600000;
  await create().scheduleReports();
  expect(store.all("outbox")).toHaveLength(2);
  ledger.event("signal", "Señal nueva");
  bot.collectAlerts(); bot.collectAlerts();
  expect(store.all("outbox")).toHaveLength(3);
});

it("atiende comandos mientras el informe está pendiente y rechaza archivos fuera de reports", async()=>{
  const store=new Store(':memory:');stores.push(store);const now=Date.UTC(2026,8,6,12);
  const ledger=new Ledger(store,'paper',defaults,()=>now),controller=new Controller(new Engine(ledger,new PaperExecutor('paper',async()=>undefined)));
  const directory=mkdtempSync(join(tmpdir(),'botpoly-commands-'));const outside=join(tmpdir(),'botpoly-outside.txt');writeFileSync(outside,'not a report');
  let finish:()=>void=()=>{};
  const render=async(dir:string)=>{await new Promise<void>(r=>finish=r);const path=join(dir,'chart.png');writeFileSync(path,'png');return path;};
  const bot=new Telegram(controller,'123456:test','42',fetch,()=>now,directory,render);
  const update=(id:number,text:string)=>({update_id:id,message:{date:now/1000,text,chat:{id:42,type:'private'},from:{id:42}}});
  await bot.process(update(1,'/report'));
  const pending=bot.scheduleReports();await bot.process(update(2,'/status'));
  expect(store.get('outbox','telegram:2')).toBeDefined();
  expect(()=>bot.enqueue('bad','archivo',outside,true)).toThrow();
  store.put('meta','telegram:hour',new Date(now).toISOString().slice(0,13));finish();await pending;
  expect(store.get('outbox','telegram:1:photo')).toBeDefined();
});
