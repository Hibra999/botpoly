"""Reproduce the narrowly scoped runtime patch against @polymarket/client 0.9.0.
Run after pnpm patch; the package ships minified JS, hence large generated diff lines.
Source: Polymarket/ts-sdk 8898914b31f9c06301a365f436aa558d3d725241.
"""
from pathlib import Path
import sys
root=Path(sys.argv[1])
p=root/'dist/index.js';body=p.read_text()
start=body.index('var S=class{#e;#s;#r;#n=new Od(')
end=body.index(';var g=class',start)
part=body[start:end]
changes={
 'var S=class{':'var S=class{#transport={connected:false,generation:0};#listeners=new Set;#notify(connected){this.#transport.connected=connected;if(connected)this.#transport.generation++;for(const fn of this.#listeners)fn({...this.#transport});}',
 'm(s.subscriber.queue,()=>this.#a(s))':'Object.assign(m(s.subscriber.queue,()=>this.#a(s)),{connection:this.#transport,onConnectionChange:fn=>{this.#listeners.add(fn);fn({...this.#transport});return()=>this.#listeners.delete(fn)}})',
 'async#d(){':'async#d(){this.#notify(false);this.#listeners.clear();',
 '#c(){':'#c(){this.#notify(true);',
 'this.#t.dispatch(i.data)':'this.#t.dispatch({...i.data,connectionGeneration:this.#transport.generation})',
 '#l(){':'#l(){this.#notify(false);',
 '#h(){}':'#h(){this.#notify(false);}',
}
for old,new in changes.items():
 assert part.count(old)==1,old
 part=part.replace(old,new)
p.write_text(body[:start]+part+body[end:])
p=root/'dist/chunk-VY7OIGFI.js';body=p.read_text();old='function nS(e){let r;';assert body.count(old)==1
p.write_text(body.replace(old,'function nS(e){if(e.length===1)return e[0];let r;'))
p=root/'dist/types-MSQcyDVD.d.ts';body=p.read_text();old='type SubscriptionHandle<TEvent> = {';assert body.count(old)==1
p.write_text(body.replace(old,old+'\n    /** Botpoly patch v1: single CLOB market handles only. */\n    readonly connection?: {readonly connected:boolean; readonly generation:number};\n    onConnectionChange?(listener:(state:{connected:boolean;generation:number})=>void):()=>void;'))
