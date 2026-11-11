import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';import {EventEmitter} from 'node:events';

// Execute the actual bridge body in a private context. Only imports and
// import.meta's module URL are supplied by this harness; no device or broker.
const source=readFileSync(new URL('./bridge.mjs',import.meta.url),'utf8');
const imports=source.match(/^import .*;$/gm);assert.equal(imports.length,3);
const body=source.replace(/^import .*;\n/gm,'').replaceAll('import.meta.url','moduleUrl');
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function fixture(saved={},allow=true){
 let now=1000000,nextTimer=0,fetches=0;const timers=new Map(),intervals=[],children=[],published=[],disk=new Map(),writes=[];
 const pools=[{id:'2033',system_name:'Pentair: AA-BB-CC'},{id:'2070',system_name:'Pentair: DD-EE-FF'}];
 disk.set('/data/options.json',JSON.stringify({pools,allow_control:allow}));disk.set('/data/pauses.json',JSON.stringify(saved));
 const client=Object.assign(new EventEmitter(),{connected:true,publish:(topic,payload,options)=>published.push({topic,payload,options}),subscribe:()=>{},end:(_force,cb)=>cb()});
 const process=Object.assign(new EventEmitter(),{env:{SUPERVISOR_TOKEN:'synthetic'},exit:()=>{}});
 const context={moduleUrl:new URL('./bridge.mjs',import.meta.url).href,URL,Buffer,console:{log:()=>{}},process,
  Date:class extends Date{static now(){return now;}},
  readFileSync:p=>{assert.ok(disk.has(p),'unexpected file read');return disk.get(p);},existsSync:p=>disk.has(p),
  writeFileSync:(p,v,options)=>{assert.equal(options.mode,0o600);writes.push(p);disk.set(p,v);},
  renameSync:(a,b)=>{disk.set(b,disk.get(a));disk.delete(a);},
  setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
  setInterval:(fn,ms)=>{assert.equal(ms,60000);intervals.push(fn);},
  mqtt:{connect:(url,opts)=>{assert.equal(url,'mqtt://synthetic:1883');assert.equal(opts.queueQoSZero,false);return client;}},
  fetch:async(url,opts)=>{fetches++;assert.equal(url,'http://supervisor/services/mqtt');assert.equal(opts.headers.Authorization,'Bearer synthetic');return {ok:true,json:async()=>({result:'ok',data:{host:'synthetic',port:1883}})};},
  AbortSignal:{timeout:ms=>{assert.equal(ms,10000);return 'synthetic-deadline';}},
  fork:()=>{const child=Object.assign(new EventEmitter(),{kills:0,send:payload=>{child.payload=structuredClone(payload);},kill:()=>{child.kills++;}});children.push(child);return child;}
 };
 await vm.runInNewContext('(async()=>{'+body+'\n})()',context,{timeout:1000});assert.equal(fetches,1);
 const snapshot={temperature:80,target:83,heatMode:0};
 const finish=async child=>{child.emit('message',{ok:true,snapshot});await flush();};
 const command=async(id,action,value,retain=false)=>{client.emit('message',`screenlogic_pool/${id}/set/${action}`,Buffer.from(value),{retain});await flush();};
 const advance=async ms=>{now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}await flush();};
 return {client,children,published,disk,writes,finish,command,advance,intervals,
  connect:async()=>{client.emit('connect');await flush();}};
}
test('startup and reconnect only read, retained/oversized/disallowed commands never fork',async()=>{
 const x=await fixture();assert.equal(x.children.length,0);await x.connect();
 assert.deepEqual(x.children.map(c=>c.payload.action),['read','read']);
 await x.command('2033','mode','gas',true);await x.command('2033','mode','x'.repeat(17));await x.command('2033','unrelated','on');
 await Promise.all(x.children.map(x.finish));assert.equal(x.children.length,2);
 await x.connect();assert.deepEqual(x.children.slice(2).map(c=>c.payload.action),['read','read']);
 const disabled=await fixture({},false);await disabled.command('2033','mode','gas');assert.equal(disabled.children.length,0);
});
test('per-home busy queue keeps first pending command and drops later ones',async()=>{
 const x=await fixture();await x.connect();await x.command('2033','temperature','83');await x.command('2033','mode','gas');await x.command('2033','mode','off');
 await x.finish(x.children[1]);await x.command('2070','mode','off');
 assert.equal(x.children[2].payload.options.id,'2070');assert.equal(x.children[2].payload.action,'mode');
 await x.finish(x.children[0]);assert.equal(x.children[3].payload.action,'temperature');assert.equal(x.children[3].payload.value,'83');
 await x.finish(x.children[3]);assert.equal(x.children.length,4);
});
for(const ms of [29999,30000])test('pending command expiry boundary '+ms,async()=>{
 const x=await fixture();await x.connect();await x.command('2033','mode','gas');
 // Delaying the loop can make the queued request 30s old when completion runs.
 // Advance wall clock without executing the competing timeout until afterwards.
 const timer=x.children[0];
 await x.advance(ms); // child hard deadline also settles; expiry is checked then
 assert.equal(x.children.length,ms<30000?3:2);assert.equal(timer.kills,1);
});
test('pause before admission blocks commands and persists across restart',async()=>{
 const x=await fixture();await x.command('2033','automation','off');
 assert.equal(x.children[0].payload.action,'read');assert.equal(x.children[0].payload.options.allow_control,false);
 await x.command('2033','mode','gas');assert.equal(x.children.length,1);
 assert.deepEqual(JSON.parse(x.disk.get('/data/pauses.json')),{'2033':true});assert.equal(x.writes.length,1);
 const restarted=await fixture(JSON.parse(x.disk.get('/data/pauses.json')));await restarted.connect();
 assert.equal(restarted.children[0].payload.options.allow_control,false);assert.equal(restarted.children[1].payload.options.allow_control,true);
});
test('pause after child admission clears pending but does not revoke the admitted child',async()=>{
 const x=await fixture();await x.command('2033','mode','gas');const admitted=x.children[0];
 assert.equal(admitted.payload.options.allow_control,true);await x.command('2033','mode','off');
 await x.command('2033','automation','off');assert.equal(admitted.kills,0);
 await x.finish(admitted);assert.equal(x.children.length,1);assert.equal(admitted.kills,1);
 const state=x.published.filter(p=>p.topic==='screenlogic_pool/2033/state').at(-1);assert.equal(JSON.parse(state.payload).paused,true);
});
for(const end of ['success','exit','timeout'])test('child '+end+' settles once without command replay',async()=>{
 const x=await fixture();await x.command('2033','mode','off');const child=x.children[0];
 if(end==='success')await x.finish(child);else if(end==='exit'){child.emit('exit');await flush();}else await x.advance(28000);
 child.emit('exit');child.emit('message',{ok:true,snapshot:{}});await x.advance(30000);
 assert.equal(child.kills,1);assert.equal(x.children.length,1);
 const available=x.published.filter(p=>p.topic.endsWith('/available'));assert.equal(available.length,1);
 assert.equal(available[0].payload,end==='success'?'online':'offline');
});
