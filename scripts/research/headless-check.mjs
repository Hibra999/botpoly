import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {Server} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const originalDirectory=process.cwd();
const root=mkdtempSync(join(tmpdir(),'botpoly-headless-'));
try {
  process.chdir(root);
  // Guard both import boundaries and actual listener creation, with no network or signing.
  registerHooks({resolve(specifier,context,next){
    assert(!/engine\/live\.[jt]s$|^ethers$|@polymarket\/client\/(ethers-v5|viem|privy)$/.test(specifier),`Firmante importado: ${specifier}`);
    return next(specifier,context);
  }});
  Server.prototype.listen=function(){throw new Error('El bot intentó escuchar un puerto');};
  globalThis.fetch=async()=>{throw new Error('Red desactivada en comprobación');};
  process.env.BOT_MODE='paper';process.env.BOT_DATABASE=join(root,'paper.sqlite');
  process.env.TELEGRAM_BOT_TOKEN='123456:test';process.env.TELEGRAM_CHAT_ID='42';
  process.env.POLL_INTERVAL_MS='500';delete process.env.BOT_CONFIG;delete process.env.DRY_RUN;
  const {main}=await import('../../dist/src/app/main.js');
  await import('../../dist/src/research/backtest.js');
  const stop=setTimeout(()=>process.emit('SIGTERM'),100);
  await main();clearTimeout(stop);
  // Same launcher and lock used by pnpm/systemd, with an inert engine in an isolated directory.
  mkdirSync(join(root,'deploy'));mkdirSync(join(root,'dist/src/app'),{recursive:true});
  copyFileSync(join(originalDirectory,'deploy/start.sh'),join(root,'deploy/start.sh'));
  writeFileSync(join(root,'dist/src/app/run.js'),"console.log('engine-start'); setInterval(()=>{},1000);\n");
  const first=spawn('bash',[join(root,'deploy/start.sh')],{stdio:['ignore','pipe','pipe']});
  try {
    await once(first.stdout,'data');
    const second=spawn('bash',[join(root,'deploy/start.sh')],{stdio:['ignore','pipe','pipe']});
    let output='';second.stdout.on('data',x=>output+=x);
    const [code]=await once(second,'exit');assert.equal(code,75);assert.equal(output,'');
  }finally{first.kill('SIGTERM');await once(first,'exit');}
  console.log('Correcto: paper/backtest sin firmantes, motor sin listeners, segunda instancia excluida.');
}finally{process.chdir(originalDirectory);rmSync(root,{recursive:true,force:true});}
