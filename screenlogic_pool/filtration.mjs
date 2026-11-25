const pacific = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit',
  day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
const dayMs = 86400000;
function pacificWall(at) {
  const fields = Object.fromEntries(pacific.formatToParts(at).map(p=>[p.type,Number(p.value)]));
  return Date.UTC(fields.year,fields.month-1,fields.day,fields.hour,fields.minute,fields.second);
}

function minute(value) {
  return typeof value==='string'&&/^(?:[01]\d|2[0-3])[0-5]\d$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(2)):null;
}

export function filtrationForecast(clock,recurring,once,circuit,observedAt) {
  if(!clock||!['year','month','day','hour','minute','second'].every(key=>Number.isInteger(clock[key]))||
    clock.year<2020||clock.year>2100||clock.month<1||clock.month>12||clock.day<1||clock.day>31||
    clock.hour<0||clock.hour>23||clock.minute<0||clock.minute>59||clock.second<0||clock.second>59||
    !Array.isArray(recurring)||!Array.isArray(once))return null;
  const midnight=Date.UTC(clock.year,clock.month-1,clock.day);
  if(new Date(midnight).getUTCDate()!==clock.day)return null;
  // SDK clock components are wall time. Its Date embeds the host's zone.
  const wall=midnight+(clock.hour*3600+clock.minute*60+clock.second)*1000;
  const drift=wall-pacificWall(observedAt);
  const result={observedAt,clockOffsetMinutes:Math.round(drift/60000),startAt:null,endAt:null};
  const entries=recurring.filter(event=>event.circuitId===circuit);
  if(Math.abs(drift)>10*60000||once.some(event=>event.circuitId===circuit)||entries.some(event=>
    event.flags!==0||event.heatCmd!==4||!Number.isInteger(event.dayMask)||event.dayMask<1||event.dayMask>127||
    minute(event.startTime)===null||minute(event.stopTime)===null||minute(event.startTime)>=minute(event.stopTime)))return result;
  const windows=[];
  for(let offset=0;offset<=7;offset++){
    const date=midnight+offset*dayMs,weekday=new Date(date).getUTCDay();
    const dayBit=1<<((weekday+6)%7); // Pentair's first day bit is Monday.
    for(const event of entries.filter(event=>event.dayMask&dayBit)){
      const startWall=date+minute(event.startTime)*60000,endWall=date+minute(event.stopTime)*60000;
      if(endWall<=wall)continue;
      const startAt=observedAt+startWall-wall,endAt=observedAt+endWall-wall;
      if(pacificWall(startAt)+drift!==startWall||pacificWall(endAt)+drift!==endWall)return result;
      windows.push({startAt,endAt});
    }
    if(windows.length)break;
  }
  windows.sort((a,b)=>a.startAt-b.startAt);
  const [first,next]=windows;
  if(!first||next&&next.startAt<=first.endAt)return result;
  return {...result,...first};
}
