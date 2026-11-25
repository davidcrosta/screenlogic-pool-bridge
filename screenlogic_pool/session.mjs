// Isolated bounded session: no library reconnect, command retry or startup writes.
import ScreenLogic from 'node-screenlogic';
import { lightCircuits, lightStates } from './lighting.mjs';
import { filtrationForecast } from './filtration.mjs';

export async function switchLights(client, config, before, options, action, value) {
  const keys = action === 'lights' ? Object.keys(lightCircuits) : [action];
  const current = lightStates(config, before, options);
  if (!options.allow_lighting || before.panelMode !== 1 ||
      !['on', 'off'].includes(value) || keys.every(key => !current[key])) {
    throw Error('lighting_rejected');
  }
  for (const key of keys) {
    if (!current[key] || current[key] === value) continue;
    try {
      await client.circuits.setCircuitStateAsync(options[lightCircuits[key].option], value === 'on');
    } catch {
      // Continue with the other mapped circuit. Only fresh controller state counts.
    }
  }
  const lights = lightStates(config, await client.equipment.getEquipmentStateAsync(), options);
  return { lights, incomplete: keys.some(key => lights[key] !== value) };
}
export function poolSnapshot(config,state,pump,options,at=Date.now()) {
  const pool=state.bodies?.filter(b=>b.id===1),circuit=config.circuitArray?.filter(c=>c.circuitId===options.pool_circuit&&c.function===2);
  const enabled=state.circuitArray?.find(c=>c.id===options.pool_circuit);
  const spaCircuits=config.circuitArray?.filter(c=>c.function===1)??[];
  const spaStates=spaCircuits.flatMap(c=>state.circuitArray?.filter(s=>s.id===c.circuitId)??[]);
  const spaKnown=spaCircuits.length===1&&spaStates.length===1&&[0,1].includes(spaStates[0].state);
  const spaBody=state.bodies?.filter(b=>b.id===2);
  const spa=spaBody?.length===1?spaBody[0]:null;
  const validWater=value=>Number.isFinite(value)&&value>=32&&value<=110;
  const metric=(value,max)=>Number.isFinite(value)&&value>=0&&value<max?value:null;
  const pumpWatts=metric(pump?.pumpWatts,5000),pumpRpm=metric(pump?.pumpRPMs,5000),pumpGpm=metric(pump?.pumpGPMs,300);
  const pumpRunning=pump?.isRunning===false&&!(pumpWatts>0||pumpRpm>0||pumpGpm>0)?false:
    pump?.isRunning===true&&pumpWatts>0&&(pumpRpm>0||pumpGpm>0)?true:null;
  const motorFeedback=pumpRunning!==null?'available':options.id==='2070'&&pump?.isRunning===true&&
    pumpWatts===0&&pumpRpm===0&&pumpGpm===null?'unsupported':'unavailable';
  if(config.degC!==false||pool?.length!==1||circuit?.length!==1||![0,1].includes(enabled?.state)||
    !Number.isFinite(pool[0].currentTemp)||pool[0].currentTemp<32||pool[0].currentTemp>110||
    !Number.isFinite(pool[0].setPoint)||![0,1,2,3].includes(pool[0].heatMode)||
    !Number.isInteger(pool[0].heatStatus)||!Number.isInteger(state.panelMode))throw Error('invalid_pool_evidence');
  return {observedAt:at,temperature:pool[0].currentTemp,target:pool[0].setPoint,heatMode:pool[0].heatMode,
    heating:pool[0].heatStatus!==0,poolOn:enabled.state===1,
    pumpRunning,motorFeedback,pumpWatts,pumpRpm,pumpGpm,pumpType:pump?.pumpType??null,
    spaOn:!spaKnown||spaStates[0].state===1,spaKnown,panelMode:state.panelMode,freezeMode:state.freezeMode,unit:'F',
    ...(spaKnown&&spaStates[0].state===1&&spa&&validWater(spa.currentTemp)&&validWater(spa.setPoint)&&Number.isInteger(spa.heatStatus)?
      {spa:{temperature:spa.currentTemp,target:spa.setPoint,heating:spa.heatStatus!==0}}:{})};
}
export function permitted(action,value,s) {
  if(action==='mode'&&value==='off')return true;
  return s.panelMode===1&&s.spaKnown===true&&!s.spaOn&&s.motorFeedback!=='unavailable'&&(
    action==='temperature'&&/^(83|88)(\.0+)?$/.test(value)||action==='pump'&&value==='on'||
    action==='mode'&&value==='gas'&&s.poolOn&&s.pumpRunning!==false&&[83,88].includes(s.target));
}
if(process.send)process.once('message',async({options,action='read',value})=>{
  const fail=code=>{process.send?.({ok:false,code});process.exit(1);};
  setTimeout(()=>fail('connection_timeout'),action==='filtration'?12000:25000);
  try {
    const gateway=await new ScreenLogic.RemoteLogin(options.system_name).connectAsync();
    if(!gateway.gatewayFound||!gateway.ipAddr||!Number.isInteger(gateway.port))return fail('gateway_unavailable');
    const c=new ScreenLogic.UnitConnection();c.netTimeout=7000;c.reconnectAsync=async()=>fail('connection_interrupted');
    c.init(options.system_name,gateway.ipAddr,gateway.port,options.password);await c.connectAsync();
    if(action==='filtration'){
      const clock=await c.equipment.getSystemTimeAsync(),observedAt=Date.now();
      const recurring=await c.schedule.getScheduleDataAsync(0),once=await c.schedule.getScheduleDataAsync(1);
      const filtration=filtrationForecast(clock,recurring.data,once.data,options.pool_circuit,observedAt);
      process.send?.({ok:true,filtration});process.exit(0);
    }
    if(action==='lights'||Object.hasOwn(lightCircuits,action)){
      const config=await c.equipment.getControllerConfigAsync();
      const result=await switchLights(c,config,await c.equipment.getEquipmentStateAsync(),options,action,value);
      process.send?.({ok:true,...result});process.exit(0);
    }
    const config=await c.equipment.getControllerConfigAsync();
    const pumpStatus=()=>c.pump.getPumpStatusAsync(options.pump_id).catch(()=>null);
    const read=async(command=false)=>{
      // A write uses the last equipment read to guard against a guest switching to Spa.
      const pumpBefore=command&&!(action==='mode'&&value==='off')?await pumpStatus():null;
      const state=await c.equipment.getEquipmentStateAsync(),observedAt=Date.now();
      const pump=command?pumpBefore:await pumpStatus();
      return {snapshot:poolSnapshot(config,state,pump,options,observedAt),
        lights:lightStates(config,state,options)};
    };
    const before=await read(action!=='read');
    if(action!=='read') {
      if(!options.allow_control||!permitted(action,value,before.snapshot))return fail('command_rejected');
      if(action==='temperature')await c.bodies.setSetPointAsync(0,Number(value));
      else if(action==='mode')await c.bodies.setHeatModeAsync(0,value==='off'?0:3);
      else if(action==='pump')await c.circuits.setCircuitStateAsync(options.pool_circuit,true);
    }
    process.send?.({ok:true,...(action==='read'?before:await read())});process.exit(0);
  }catch{fail(action==='read'?'read_failed':'command_uncertain');}
});
