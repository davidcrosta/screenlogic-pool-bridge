import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {fork} from 'node:child_process';
import mqtt from 'mqtt';
import { lightCircuits, nextLightingTimes } from './lighting.mjs';
const options=JSON.parse(readFileSync('/data/options.json','utf8'));
const pauses=existsSync('/data/pauses.json')?JSON.parse(readFileSync('/data/pauses.json','utf8')):{};
const savePauses=()=>{writeFileSync('/data/pauses.json.tmp',JSON.stringify(pauses),{mode:0o600});renameSync('/data/pauses.json.tmp','/data/pauses.json');};
if(!Array.isArray(options.pools)||options.pools.length!==2||new Set(options.pools.map(p=>p.id)).size!==2||
  options.pools.some(p=>!/^\d{4}$/.test(p.id)||!/^Pentair: [A-F0-9]{2}-[A-F0-9]{2}-[A-F0-9]{2}$/.test(p.system_name)))throw Error('Invalid pool configuration');
const r=await fetch('http://supervisor/services/mqtt',{headers:{Authorization:`Bearer ${process.env.SUPERVISOR_TOKEN}`},signal:AbortSignal.timeout(10000)});
const service=await r.json();if(!r.ok||service.result!=='ok')throw Error('MQTT service unavailable');
const b=service.data;
const client=mqtt.connect(`mqtt://${b.host}:${b.port}`,{username:b.username,password:b.password,clientId:'screenlogic-pool-bridge',
  clean:true,queueQoSZero:false,reconnectPeriod:5000,will:{topic:'screenlogic_pool/availability',payload:'offline',qos:0,retain:true}});
const busy=new Set(),pending=new Map(),pendingLighting=new Map();
const publish=(topic,data,retain=false)=>{if(client.connected)client.publish(topic,typeof data==='string'?data:JSON.stringify(data),{qos:0,retain});};
const lightingEnabled=Number.isFinite(options.lighting_latitude)&&Number.isFinite(options.lighting_longitude)&&
  typeof options.lighting_time_zone==='string';
const lightActions=['lights',...Object.keys(lightCircuits)];
const publishedTimes={};
function publishLightingTimes(discover=false) {
  if(!lightingEnabled)return;
  try {
    const times=nextLightingTimes(new Date(Date.now()),options.lighting_latitude,options.lighting_longitude,
      options.lighting_time_zone);
    for(const [key,stamp] of Object.entries(times)){
      const id='screenlogic_lighting_'+key,topic='screenlogic_pool/lighting/'+key;
      if(discover)publish('homeassistant/sensor/'+id+'/config',{
        name:key==='dusk'?'ScreenLogic lighting dusk':'ScreenLogic lighting cutoff',
        unique_id:id,default_entity_id:'sensor.'+id,device_class:'timestamp',state_topic:topic,
        availability_topic:'screenlogic_pool/availability'
      },true);
      if(discover||publishedTimes[key]!==stamp){
        publish(topic,stamp??'None',true);publishedTimes[key]=stamp;
      }
    }
  }catch{console.log('Invalid lighting location or time zone');}
}
function publishLights(p,lights={}) {
  for(const [key,{option}] of Object.entries(lightCircuits)){
    if(!p[option])continue;
    const topic='screenlogic_pool/'+p.id+'/'+key;
    if(lights[key])publish(topic,lights[key]);
    publish(topic+'/available',lights[key]?'online':'offline');
  }
}
function discovery(p) {
  const base=`screenlogic_pool/${p.id}`,device={identifiers:[`screenlogic_pool_${p.id}`],name:`Pool ${p.id}`,manufacturer:'Pentair',model:'ScreenLogic'};
  const common={device,availability:[{topic:'screenlogic_pool/availability'},{topic:`${base}/available`}],availability_mode:'all'};
  for(const [domain,key,specific] of [
    ['sensor','status',{state_topic:`${base}/state`,value_template:'{{ value_json.observedAt }}',json_attributes_topic:`${base}/state`,expire_after:180}],
    ['water_heater','heater',{temperature_unit:'F',min_temp:83,max_temp:83,precision:1,modes:['off','gas'],optimistic:false,retain:false,qos:0,
      mode_state_topic:`${base}/mode`,mode_command_topic:`${base}/set/mode`,temperature_state_topic:`${base}/target`,
      temperature_command_topic:`${base}/set/temperature`,current_temperature_topic:`${base}/temperature`}],
    ['button','circulation',{command_topic:`${base}/set/pump`,payload_press:'on',retain:false,qos:0}]
    ,['switch','automation',{state_topic:`${base}/automation`,command_topic:`${base}/set/automation`,retain:false,qos:0,
      payload_on:'on',payload_off:'off',icon:'mdi:pool'}]
  ])publish(`homeassistant/${domain}/pool_${p.id}_${key}/config`,{...common,name:key,unique_id:`pool_${p.id}_${key}`,
    object_id:`pool_${p.id}_${key}`,...specific},true);
  for(const [key,{option,name}] of Object.entries(lightCircuits)){
    const id=`pool_${p.id}_${key}`,configTopic=`homeassistant/switch/${id}/config`;
    if(!p[option]){publish(configTopic,'',true);continue;}
    publish(configTopic,{device,name,unique_id:id,default_entity_id:`switch.${id}`,
      availability:[{topic:'screenlogic_pool/availability'},{topic:`${base}/${key}/available`}],
      availability_mode:'all',state_topic:`${base}/${key}`,command_topic:`${base}/set/${key}`,
      payload_on:'on',payload_off:'off',optimistic:false,retain:false,qos:0,icon:'mdi:lightbulb'},true);
  }
}
async function run(p,action='read',value) {
  const lighting=lightActions.includes(action);
  if(busy.has(p.id)){
    const queue=lighting?pendingLighting:pending;
    if(action!=='read'&&!queue.has(p.id))queue.set(p.id,{action,value,at:Date.now()});
    return;
  }
  busy.add(p.id);
  try {
    const result=await new Promise(resolve=>{
      const child=fork(new URL('./session.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});let done=false;
      const finish=r=>{if(done)return;done=true;clearTimeout(timer);child.kill();resolve(r);};
      const timer=setTimeout(()=>finish({ok:false,code:'session_timeout'}),28000);
      child.once('message',finish);child.once('exit',()=>finish({ok:false,code:'session_failed'}));
      child.send({options:{...p,allow_control:options.allow_control===true&&pauses[p.id]!==true,
        allow_lighting:lighting&&options.allow_control===true},action,value});
    });
    const base=`screenlogic_pool/${p.id}`;
    if(action==='read'||lighting)publishLights(p,result.lights);
    if(lighting){
      if(!result.ok||result.incomplete)console.log(JSON.stringify({pool:p.id,action,code:result.code??'lighting_unconfirmed'}));
    }else if(result.ok){const s={...result.snapshot,paused:pauses[p.id]===true};publish(`${base}/state`,s);publish(`${base}/temperature`,String(s.temperature));
      publish(`${base}/automation`,s.paused?'off':'on');
      publish(`${base}/target`,String(s.target));publish(`${base}/mode`,s.heatMode===0?'off':'gas');publish(`${base}/available`,'online');}
    else {publish(`${base}/available`,'offline');console.log(JSON.stringify({pool:p.id,action,code:result.code}));}
  }finally{
    busy.delete(p.id);
    for(const queue of [pending,pendingLighting]){
      const next=queue.get(p.id);queue.delete(p.id);
      if(next&&Date.now()-next.at<30000){void run(p,next.action,next.value);break;}
    }
  }
}
client.on('connect',()=>{for(const p of options.pools){discovery(p);publish(`screenlogic_pool/${p.id}/available`,'offline');}
  publishLightingTimes(true);
  publish('screenlogic_pool/availability','online',true);client.subscribe('screenlogic_pool/+/set/+',{qos:0});
  options.pools.forEach(p=>void run(p));});
client.on('message',(topic,payload,packet)=>{
  if(packet.retain||payload.length>16)return;
  const [,id,,action]=topic.split('/'),p=options.pools.find(p=>p.id===id),value=payload.toString();
  if(p&&action==='automation'&&['on','off'].includes(value)){
    pauses[p.id]=value==='off';savePauses();pending.delete(p.id);publish(`screenlogic_pool/${id}/automation`,value);void run(p);return;
  }
  if(options.allow_control&&p&&pauses[p.id]!==true&&(['mode','temperature','pump'].includes(action)))void run(p,action,value);
  if(options.allow_control===true&&p&&lightActions.includes(action)&&['on','off'].includes(value)&&
    (p.pool_light_circuit||p.spa_light_circuit))void run(p,action,value);
});
client.on('error',()=>console.log('MQTT connection unavailable'));
setInterval(()=>{if(client.connected){publishLightingTimes();options.pools.forEach(p=>void run(p));}},60000);
process.on('SIGTERM',()=>{publish('screenlogic_pool/availability','offline',true);client.end(false,()=>process.exit(0));});
