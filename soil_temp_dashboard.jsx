import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ScatterChart, Scatter, BarChart, Bar, Cell, ReferenceLine
} from "recharts";

// ─── Color palette for 12 sensors ───────────────────────────────────────────
const SENSOR_COLORS = [
  "#378ADD","#1D9E75","#D85A30","#7F77DD","#BA7517","#D4537E",
  "#639922","#E24B4A","#185FA5","#0F6E56","#993C1D","#533AB7"
];

// ─── Generate synthetic demo data ───────────────────────────────────────────
function generateDemoData() {
  const sensors = Array.from({length:12},(_,i)=>({id:`S${i+1}`,depth:(i+1)*0.5}));
  const rows = [];
  const now = Date.now();
  for(let m=0;m<2880;m++){// 10 days, every 5 min
    const ts = new Date(now - m*5*60*1000);
    const tsStr = ts.toISOString().slice(0,16).replace("T"," ");
    const hour = ts.getHours();
    const dayCycle = Math.sin((hour-6)*Math.PI/12)*4;
    sensors.forEach(s=>{
      const depthDamp = Math.max(0,1-(s.depth*0.18));
      const base = 22 + s.depth*1.2;
      const noise = (Math.random()-0.5)*1.2;
      const anomaly = Math.random()<0.005 ? (Math.random()-0.5)*8 : 0;
      rows.push({
        Timestamp: tsStr,
        Sensor_ID: s.id,
        Depth_ft: s.depth,
        Temperature: parseFloat((base + dayCycle*depthDamp + noise + anomaly).toFixed(2)),
        ts: ts.getTime()
      });
    });
  }
  return rows;
}

// ─── Parse CSV ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",").map(h=>h.trim());
  return lines.slice(1).map(line=>{
    const vals = line.split(",").map(v=>v.trim());
    const obj = {};
    header.forEach((h,i)=>obj[h]=vals[i]);
    obj.ts = new Date(obj.Timestamp).getTime();
    obj.Depth_ft = parseFloat(obj.Depth_ft);
    obj.Temperature = parseFloat(obj.Temperature);
    return obj;
  }).filter(r=>!isNaN(r.ts)&&!isNaN(r.Temperature));
}

// ─── Aggregate by interval ────────────────────────────────────────────────────
function aggregateData(data, intervalMin) {
  if(!intervalMin||intervalMin<=0) return data;
  const buckets = {};
  data.forEach(row=>{
    const bucketTs = Math.floor(row.ts/(intervalMin*60*1000))*(intervalMin*60*1000);
    const key = `${row.Sensor_ID}__${bucketTs}`;
    if(!buckets[key]) buckets[key]={...row,ts:bucketTs,Timestamp:new Date(bucketTs).toISOString().slice(0,16).replace("T"," "),_temps:[]};
    buckets[key]._temps.push(row.Temperature);
  });
  return Object.values(buckets).map(b=>{
    const temps = b._temps;
    b.Temperature = parseFloat((temps.reduce((a,c)=>a+c,0)/temps.length).toFixed(2));
    delete b._temps;
    return b;
  }).sort((a,b)=>a.ts-b.ts);
}

// ─── Anomaly detection ─────────────────────────────────────────────────────────
function detectAnomalies(data) {
  const bySensor = {};
  data.forEach(r=>{
    if(!bySensor[r.Sensor_ID]) bySensor[r.Sensor_ID]=[];
    bySensor[r.Sensor_ID].push(r.Temperature);
  });
  const stats = {};
  Object.entries(bySensor).forEach(([sid,temps])=>{
    const mean = temps.reduce((a,c)=>a+c,0)/temps.length;
    const std = Math.sqrt(temps.reduce((a,c)=>a+(c-mean)**2,0)/temps.length);
    stats[sid]={mean,std};
  });
  return data.map(r=>{
    const {mean,std} = stats[r.Sensor_ID]||{mean:0,std:1};
    return {...r, anomaly: Math.abs(r.Temperature-mean) > 3*std};
  });
}

// ─── Insights generator ────────────────────────────────────────────────────────
function generateInsights(data, activeSensors) {
  if(!data.length) return [];
  const insights = [];
  const bySensor = {};
  data.forEach(r=>{
    if(!bySensor[r.Sensor_ID]) bySensor[r.Sensor_ID]={temps:[],depth:r.Depth_ft};
    bySensor[r.Sensor_ID].temps.push(r.Temperature);
  });
  let maxMean=-Infinity, maxSensor="";
  let minStd=Infinity, stableSensor="";
  Object.entries(bySensor).forEach(([sid,{temps,depth}])=>{
    const mean = temps.reduce((a,c)=>a+c,0)/temps.length;
    const std = Math.sqrt(temps.reduce((a,c)=>a+(c-mean)**2,0)/temps.length);
    if(mean>maxMean){maxMean=mean;maxSensor=sid;}
    if(std<minStd){minStd=std;stableSensor=sid;}
  });
  insights.push(`${maxSensor} recorded the highest average temperature (${maxMean.toFixed(1)}°C) during the selected period.`);
  insights.push(`${stableSensor} shows the most stable readings with lowest variation (σ=${minStd.toFixed(2)}°C).`);
  const deepSensors = Object.entries(bySensor).filter(([,{depth}])=>depth>=3);
  if(deepSensors.length) {
    const deepMeans = deepSensors.map(([,{temps}])=>temps.reduce((a,c)=>a+c,0)/temps.length);
    const avgDeep = deepMeans.reduce((a,c)=>a+c,0)/deepMeans.length;
    insights.push(`Sensors at 3 ft and below maintain a stable average of ${avgDeep.toFixed(1)}°C, showing thermal mass insulation.`);
  }
  const anomalyCount = data.filter(r=>r.anomaly).length;
  if(anomalyCount>0) insights.push(`${anomalyCount} anomalous readings detected — review highlighted points in the chart.`);
  return insights;
}

// ─── STAT HELPERS ─────────────────────────────────────────────────────────────
const avg = arr => arr.length ? arr.reduce((a,c)=>a+c,0)/arr.length : 0;
const std = arr => { const m=avg(arr); return Math.sqrt(arr.reduce((a,c)=>a+(c-m)**2,0)/arr.length); };

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

function StatCard({label,value,unit,icon,accent}) {
  return (
    <div style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"1rem",minWidth:0}}>
      <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
        <i className={`ti ${icon}`} style={{fontSize:14}} aria-hidden="true"></i>{label}
      </div>
      <div style={{fontSize:22,fontWeight:500,color:accent||"var(--color-text-primary)"}}>
        {value}<span style={{fontSize:13,fontWeight:400,marginLeft:3,color:"var(--color-text-secondary)"}}>{unit}</span>
      </div>
    </div>
  );
}

function SectionHeader({title,subtitle}) {
  return (
    <div style={{marginBottom:16}}>
      <h2 style={{margin:0,fontSize:15,fontWeight:500}}>{title}</h2>
      {subtitle && <p style={{margin:"4px 0 0",fontSize:13,color:"var(--color-text-secondary)"}}>{subtitle}</p>}
    </div>
  );
}

const INTERVALS = [
  {label:"Raw",value:0},{label:"5 min",value:5},{label:"10 min",value:10},
  {label:"15 min",value:15},{label:"30 min",value:30},{label:"1 hr",value:60},
  {label:"3 hr",value:180},{label:"6 hr",value:360},{label:"12 hr",value:720},{label:"24 hr",value:1440}
];

const DATE_PRESETS = [
  {label:"Last 24h",value:1},{label:"Last 7d",value:7},{label:"Last 30d",value:30},{label:"All",value:0}
];

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState([]);
  const [rawData, setRawData] = useState([]);
  const [sensorList, setSensorList] = useState([]);
  const [activeSensors, setActiveSensors] = useState(new Set());
  const [interval, setInterval] = useState(60);
  const [datePreset, setDatePreset] = useState(7);
  const [depthRange, setDepthRange] = useState([0,10]);
  const [activeTab, setActiveTab] = useState("overview");
  const [uploadState, setUploadState] = useState("idle"); // idle|loading|done|error
  const [uploadMsg, setUploadMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [compA, setCompA] = useState("S1");
  const [compB, setCompB] = useState("S4");
  const [tableSearch, setTableSearch] = useState("");
  const [tablePage, setTablePage] = useState(0);
  const fileInputRef = useRef();

  // Load demo data on mount
  useEffect(()=>{
    const demo = generateDemoData();
    loadData(demo);
  },[]);

  function loadData(rows) {
    const withAnomalies = detectAnomalies(rows);
    setRawData(withAnomalies);
    const sensors = [...new Set(rows.map(r=>r.Sensor_ID))].sort((a,b)=>{
      const na=parseInt(a.replace(/\D/g,"")), nb=parseInt(b.replace(/\D/g,""));
      return na-nb;
    });
    setSensorList(sensors);
    setActiveSensors(new Set(sensors));
    setUploadState("done");
  }

  // Filter + aggregate pipeline
  const filteredData = useMemo(()=>{
    let d = rawData;
    if(datePreset>0){
      const cutoff = Date.now() - datePreset*24*60*60*1000;
      d = d.filter(r=>r.ts>=cutoff);
    }
    d = d.filter(r=>activeSensors.has(r.Sensor_ID));
    d = d.filter(r=>r.Depth_ft>=depthRange[0]&&r.Depth_ft<=depthRange[1]);
    return aggregateData(d, interval);
  },[rawData,datePreset,activeSensors,depthRange,interval]);

  const temps = filteredData.map(r=>r.Temperature);
  const statsAll = {
    total: rawData.length,
    sensors: activeSensors.size,
    high: temps.length ? Math.max(...temps).toFixed(1) : "—",
    low: temps.length ? Math.min(...temps).toFixed(1) : "—",
    mean: temps.length ? avg(temps).toFixed(1) : "—",
    range: temps.length ? (Math.max(...temps)-Math.min(...temps)).toFixed(1) : "—",
    readings: filteredData.length,
    latest: filteredData.length ? filteredData.sort((a,b)=>b.ts-a.ts)[0].Timestamp : "—"
  };

  // Chart data: pivot by timestamp
  const chartData = useMemo(()=>{
    const tsMap = {};
    filteredData.forEach(r=>{
      if(!tsMap[r.Timestamp]) tsMap[r.Timestamp]={ts:r.Timestamp};
      tsMap[r.Timestamp][r.Sensor_ID]=r.Temperature;
    });
    return Object.values(tsMap).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  },[filteredData]);

  // Depth profile data (latest reading per sensor)
  const depthProfileData = useMemo(()=>{
    const latest = {};
    filteredData.forEach(r=>{
      if(!latest[r.Sensor_ID]||r.ts>latest[r.Sensor_ID].ts) latest[r.Sensor_ID]=r;
    });
    return Object.values(latest).sort((a,b)=>a.Depth_ft-b.Depth_ft);
  },[filteredData]);

  // Per-sensor stats
  const sensorStats = useMemo(()=>{
    const bySensor = {};
    filteredData.forEach(r=>{
      if(!bySensor[r.Sensor_ID]) bySensor[r.Sensor_ID]={temps:[],depth:r.Depth_ft,id:r.Sensor_ID};
      bySensor[r.Sensor_ID].temps.push(r.Temperature);
    });
    return Object.values(bySensor).map(s=>{
      const t=s.temps;
      const sorted=[...t].sort((a,b)=>a-b);
      return {...s,
        avg:parseFloat(avg(t).toFixed(2)),
        max:parseFloat(Math.max(...t).toFixed(2)),
        min:parseFloat(Math.min(...t).toFixed(2)),
        std:parseFloat(std(t).toFixed(2)),
        median:parseFloat(sorted[Math.floor(sorted.length/2)].toFixed(2))
      };
    }).sort((a,b)=>parseInt(a.id.replace(/\D/g,""))-parseInt(b.id.replace(/\D/g,"")));
  },[filteredData]);

  // Comparison data
  const compData = useMemo(()=>{
    const tsMap = {};
    filteredData.filter(r=>r.Sensor_ID===compA||r.Sensor_ID===compB).forEach(r=>{
      if(!tsMap[r.Timestamp]) tsMap[r.Timestamp]={ts:r.Timestamp};
      tsMap[r.Timestamp][r.Sensor_ID]=r.Temperature;
    });
    return Object.values(tsMap).sort((a,b)=>new Date(a.ts)-new Date(b.ts))
      .filter(r=>r[compA]!==undefined&&r[compB]!==undefined)
      .map(r=>({...r,diff:parseFloat((r[compA]-r[compB]).toFixed(2))}));
  },[filteredData,compA,compB]);

  // Correlation
  const correlation = useMemo(()=>{
    const pairs = compData.filter(r=>r[compA]!==undefined&&r[compB]!==undefined);
    if(pairs.length<2) return null;
    const xs=pairs.map(r=>r[compA]), ys=pairs.map(r=>r[compB]);
    const mx=avg(xs),my=avg(ys);
    const num=xs.reduce((a,x,i)=>a+(x-mx)*(ys[i]-my),0);
    const den=Math.sqrt(xs.reduce((a,x)=>a+(x-mx)**2,0)*ys.reduce((a,y)=>a+(y-my)**2,0));
    return den===0?0:parseFloat((num/den).toFixed(3));
  },[compData,compA,compB]);

  const insights = useMemo(()=>generateInsights(filteredData,activeSensors),[filteredData,activeSensors]);

  // CSV upload
  function handleFiles(files) {
    const file = files[0];
    if(!file) return;
    setUploadState("loading");
    setUploadMsg(`Reading ${file.name}…`);
    const reader = new FileReader();
    reader.onload = e=>{
      try {
        const rows = parseCSV(e.target.result);
        if(!rows.length) throw new Error("No valid rows found");
        loadData(rows);
        setUploadMsg(`Loaded ${rows.length.toLocaleString()} readings from ${file.name}`);
      } catch(err) {
        setUploadState("error");
        setUploadMsg(`Error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  // Table data
  const tableData = useMemo(()=>{
    let d = filteredData;
    if(tableSearch) {
      const q = tableSearch.toLowerCase();
      d = d.filter(r=>r.Sensor_ID.toLowerCase().includes(q)||String(r.Temperature).includes(q)||String(r.Depth_ft).includes(q)||r.Timestamp.includes(q));
    }
    return d.sort((a,b)=>b.ts-a.ts);
  },[filteredData,tableSearch]);

  const PAGE_SIZE = 20;
  const totalPages = Math.ceil(tableData.length/PAGE_SIZE);
  const pageData = tableData.slice(tablePage*PAGE_SIZE,(tablePage+1)*PAGE_SIZE);

  const toggleSensor = s => {
    setActiveSensors(prev=>{
      const next = new Set(prev);
      next.has(s)?next.delete(s):next.add(s);
      return next;
    });
  };

  const TABS = ["overview","trends","depth","heatmap","stats","compare","anomalies","data"];

  // Heatmap data
  const heatmapData = useMemo(()=>{
    const depths = [...new Set(filteredData.map(r=>r.Depth_ft))].sort((a,b)=>a-b);
    const timeSlots = [...new Set(filteredData.map(r=>r.Timestamp))].sort().slice(-48);
    return {depths, timeSlots,
      cells: filteredData.filter(r=>timeSlots.includes(r.Timestamp)).map(r=>({
        x:timeSlots.indexOf(r.Timestamp), y:depths.indexOf(r.Depth_ft), t:r.Temperature
      }))
    };
  },[filteredData]);

  const allTemps = filteredData.map(r=>r.Temperature);
  const tMin = allTemps.length ? Math.min(...allTemps) : 20;
  const tMax = allTemps.length ? Math.max(...allTemps) : 35;

  function tempToColor(t) {
    const pct = tMax>tMin ? (t-tMin)/(tMax-tMin) : 0.5;
    const r = Math.round(34+pct*200);
    const g = Math.round(180-pct*130);
    const b = Math.round(221-pct*190);
    return `rgb(${r},${g},${b})`;
  }

  return (
    <div style={{fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",minHeight:"100vh",background:"var(--color-background-tertiary)"}}>
      <h2 className="sr-only">Soil Temperature Monitoring Dashboard</h2>

      {/* Header */}
      <div style={{background:"var(--color-background-primary)",borderBottom:"0.5px solid var(--color-border-tertiary)",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:8,background:"#378ADD",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <i className="ti ti-layers-intersect" style={{color:"#fff",fontSize:17}} aria-hidden="true"></i>
          </div>
          <div>
            <div style={{fontWeight:500,fontSize:15}}>SoilSense</div>
            <div style={{fontSize:11,color:"var(--color-text-secondary)"}}>Underground temperature analytics</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {DATE_PRESETS.map(p=>(
            <button key={p.value} onClick={()=>setDatePreset(p.value)}
              style={{fontSize:12,padding:"4px 10px",borderRadius:6,border:`0.5px solid ${datePreset===p.value?"#378ADD":"var(--color-border-secondary)"}`,
                background:datePreset===p.value?"#378ADD":undefined,color:datePreset===p.value?"#fff":"var(--color-text-primary)",cursor:"pointer"}}>
              {p.label}
            </button>
          ))}
          <select value={interval} onChange={e=>setInterval(Number(e.target.value))}
            style={{fontSize:12,padding:"4px 8px",borderRadius:6,border:"0.5px solid var(--color-border-secondary)"}}>
            {INTERVALS.map(i=><option key={i.value} value={i.value}>{i.label==="Raw"?"Raw data":i.label+" avg"}</option>)}
          </select>
        </div>
      </div>

      <div style={{display:"flex",gap:0,minHeight:"calc(100vh - 57px)"}}>
        {/* Sidebar */}
        <div style={{width:200,minWidth:200,background:"var(--color-background-primary)",borderRight:"0.5px solid var(--color-border-tertiary)",padding:"16px 12px",flexShrink:0,overflowY:"auto"}}>
          <div style={{fontSize:11,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Navigation</div>
          {TABS.map(tab=>(
            <button key={tab} onClick={()=>setActiveTab(tab)}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 8px",borderRadius:6,border:"none",
                background:activeTab===tab?"var(--color-background-info)":"transparent",
                color:activeTab===tab?"var(--color-text-info)":"var(--color-text-secondary)",
                cursor:"pointer",fontSize:13,textAlign:"left",marginBottom:2}}>
              <i className={`ti ${({overview:"ti-dashboard",trends:"ti-chart-line",depth:"ti-wave-sine",heatmap:"ti-layout-grid",stats:"ti-chart-bar",compare:"ti-arrows-diff",anomalies:"ti-alert-triangle",data:"ti-table"})[tab]}`} style={{fontSize:15}} aria-hidden="true"></i>
              {tab.charAt(0).toUpperCase()+tab.slice(1)}
            </button>
          ))}

          <div style={{marginTop:20,fontSize:11,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Sensors</div>
          <div style={{display:"flex",gap:4,marginBottom:8}}>
            <button onClick={()=>setActiveSensors(new Set(sensorList))} style={{fontSize:11,padding:"2px 6px",borderRadius:4,border:"0.5px solid var(--color-border-secondary)",background:"transparent",cursor:"pointer",color:"var(--color-text-secondary)"}}>All</button>
            <button onClick={()=>setActiveSensors(new Set())} style={{fontSize:11,padding:"2px 6px",borderRadius:4,border:"0.5px solid var(--color-border-secondary)",background:"transparent",cursor:"pointer",color:"var(--color-text-secondary)"}}>None</button>
          </div>
          {sensorList.map((s,i)=>(
            <label key={s} style={{display:"flex",alignItems:"center",gap:6,padding:"3px 0",cursor:"pointer",fontSize:12}}>
              <input type="checkbox" checked={activeSensors.has(s)} onChange={()=>toggleSensor(s)} style={{accentColor:SENSOR_COLORS[i%SENSOR_COLORS.length]}}/>
              <span style={{width:8,height:8,borderRadius:2,background:SENSOR_COLORS[i%SENSOR_COLORS.length],flexShrink:0}}></span>
              {s} <span style={{color:"var(--color-text-secondary)",fontSize:11}}>({sensorStats.find(x=>x.id===s)?.depth||"-"}ft)</span>
            </label>
          ))}

          <div style={{marginTop:16,fontSize:11,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Depth range</div>
          <div style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:4}}>{depthRange[0]} – {depthRange[1]} ft</div>
          <input type="range" min={0} max={6} step={0.5} value={depthRange[0]}
            onChange={e=>setDepthRange([parseFloat(e.target.value),depthRange[1]])} style={{width:"100%",marginBottom:4}}/>
          <input type="range" min={0} max={6} step={0.5} value={depthRange[1]}
            onChange={e=>setDepthRange([depthRange[0],parseFloat(e.target.value)])} style={{width:"100%"}}/>

          <div style={{marginTop:16}}>
            <button onClick={()=>fileInputRef.current.click()} style={{width:"100%",fontSize:12,padding:"6px 8px",borderRadius:6,border:"0.5px solid var(--color-border-secondary)",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",gap:6,justifyContent:"center",color:"var(--color-text-secondary)"}}>
              <i className="ti ti-upload" style={{fontSize:14}} aria-hidden="true"></i>Upload CSV
            </button>
            <input ref={fileInputRef} type="file" accept=".csv" style={{display:"none"}} onChange={e=>handleFiles(e.target.files)}/>
            {uploadMsg && <div style={{fontSize:11,color:uploadState==="error"?"var(--color-text-danger)":"var(--color-text-success)",marginTop:6,lineHeight:1.4}}>{uploadMsg}</div>}
          </div>
        </div>

        {/* Main content */}
        <div style={{flex:1,padding:20,overflowY:"auto",minWidth:0}}>

          {/* OVERVIEW TAB */}
          {activeTab==="overview" && (
            <div>
              <SectionHeader title="Dashboard overview" subtitle="Summary statistics for the selected period and sensors"/>

              {/* Stat cards */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:24}}>
                <StatCard label="Active sensors" value={statsAll.sensors} icon="ti-cpu" accent="#378ADD"/>
                <StatCard label="Total readings" value={statsAll.readings.toLocaleString()} icon="ti-database"/>
                <StatCard label="Highest temp" value={statsAll.high} unit="°C" icon="ti-temperature-plus" accent="#D85A30"/>
                <StatCard label="Lowest temp" value={statsAll.low} unit="°C" icon="ti-temperature-minus" accent="#185FA5"/>
                <StatCard label="Average temp" value={statsAll.mean} unit="°C" icon="ti-chart-line"/>
                <StatCard label="Temp range" value={statsAll.range} unit="°C" icon="ti-arrows-vertical"/>
              </div>

              {/* Quick line chart */}
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>Temperature over time — all sensors</div>
                <div style={{height:280}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{top:4,right:8,bottom:4,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.5}/>
                      <XAxis dataKey="ts" tickFormatter={v=>new Date(v||0).toLocaleDateString("en",{month:"short",day:"numeric"})} tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false}/>
                      <YAxis tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} unit="°C" width={42}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:12}} labelFormatter={v=>new Date(v||0).toLocaleString()}/>
                      <Legend wrapperStyle={{fontSize:11}} iconSize={8}/>
                      {sensorList.filter(s=>activeSensors.has(s)).map((s,i)=>(
                        <Line key={s} type="monotone" dataKey={s} stroke={SENSOR_COLORS[i%SENSOR_COLORS.length]} dot={false} strokeWidth={1.5} name={s} connectNulls/>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* AI Insights */}
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
                  <i className="ti ti-bulb" style={{fontSize:15,color:"#BA7517"}} aria-hidden="true"></i>
                  AI insights
                </div>
                {insights.length ? insights.map((ins,i)=>(
                  <div key={i} style={{display:"flex",gap:8,marginBottom:8,fontSize:13,lineHeight:1.5}}>
                    <span style={{color:"#378ADD",fontWeight:500,flexShrink:0}}>{i+1}.</span>
                    <span style={{color:"var(--color-text-secondary)"}}>{ins}</span>
                  </div>
                )) : <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>No data available. Upload a CSV to generate insights.</div>}
              </div>

              {/* Upload drop zone */}
              <div
                onDragOver={e=>{e.preventDefault();setDragOver(true)}}
                onDragLeave={()=>setDragOver(false)}
                onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files)}}
                onClick={()=>fileInputRef.current.click()}
                style={{border:`2px dashed ${dragOver?"#378ADD":"var(--color-border-secondary)"}`,borderRadius:"var(--border-radius-lg)",padding:"32px",textAlign:"center",cursor:"pointer",transition:"border-color 0.15s",background:dragOver?"var(--color-background-info)":undefined}}>
                <i className="ti ti-file-upload" style={{fontSize:28,color:"var(--color-text-secondary)",display:"block",marginBottom:8}} aria-hidden="true"></i>
                <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>Drop a CSV file or click to browse</div>
                <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>Expected columns: Timestamp, Sensor_ID, Depth_ft, Temperature</div>
              </div>
            </div>
          )}

          {/* TRENDS TAB */}
          {activeTab==="trends" && (
            <div>
              <SectionHeader title="Temperature trends" subtitle="Interactive multi-sensor line chart with zoom and tooltip"/>
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                <div style={{height:380}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{top:4,right:8,bottom:4,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.4}/>
                      <XAxis dataKey="ts" tickFormatter={v=>new Date(v||0).toLocaleString("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})} tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} minTickGap={60}/>
                      <YAxis tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} unit="°C" width={42} domain={["auto","auto"]}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:11}} labelFormatter={v=>new Date(v||0).toLocaleString()} formatter={(v,n)=>[`${v}°C`,n]}/>
                      <Legend wrapperStyle={{fontSize:11}} iconSize={8}/>
                      {sensorList.filter(s=>activeSensors.has(s)).map((s,i)=>(
                        <Line key={s} type="monotone" dataKey={s} stroke={SENSOR_COLORS[i%SENSOR_COLORS.length]} dot={false} strokeWidth={1.5} name={s} connectNulls/>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Sensor stats bars */}
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px"}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>Average temperature by sensor</div>
                <div style={{height:Math.max(220,sensorStats.length*34+60)}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={sensorStats} layout="vertical" margin={{top:0,right:20,bottom:0,left:20}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.4} horizontal={false}/>
                      <XAxis type="number" tick={{fontSize:10,fill:"var(--color-text-secondary)"}} unit="°C" tickLine={false} axisLine={false}/>
                      <YAxis dataKey="id" type="category" tick={{fontSize:11,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} width={28}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:11}} formatter={v=>[`${v}°C`]}/>
                      <Bar dataKey="avg" name="Avg temp" radius={[0,3,3,0]}>
                        {sensorStats.map((_,i)=><Cell key={i} fill={SENSOR_COLORS[i%SENSOR_COLORS.length]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* DEPTH PROFILE TAB */}
          {activeTab==="depth" && (
            <div>
              <SectionHeader title="Depth profile" subtitle="Current temperature distribution across soil layers"/>
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                <div style={{height:380}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{top:8,right:20,bottom:20,left:20}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.4}/>
                      <XAxis dataKey="Temperature" name="Temperature" unit="°C" type="number" tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} label={{value:"Temperature (°C)",position:"insideBottom",offset:-10,fontSize:11,fill:"var(--color-text-secondary)"}}/>
                      <YAxis dataKey="Depth_ft" name="Depth" unit=" ft" reversed type="number" tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} label={{value:"Depth (ft)",angle:-90,position:"insideLeft",fontSize:11,fill:"var(--color-text-secondary)"}}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:11}} formatter={(v,n)=>[n==="Depth"?`${v} ft`:`${v}°C`,n]}/>
                      <Scatter data={depthProfileData} name="Sensors">
                        {depthProfileData.map((d,i)=>{
                          const sIdx = sensorList.indexOf(d.Sensor_ID);
                          return <Cell key={i} fill={SENSOR_COLORS[sIdx>=0?sIdx:i]}/>;
                        })}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>
              {/* Depth table */}
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px"}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>Readings by depth</div>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                        {["Depth","Sensor","Last temp","Avg","Max","Min"].map(h=>(
                          <th key={h} style={{textAlign:"left",padding:"6px 10px",fontWeight:500,color:"var(--color-text-secondary)",whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sensorStats.map((s,i)=>(
                        <tr key={s.id} style={{borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                          <td style={{padding:"6px 10px",whiteSpace:"nowrap"}}>{s.depth} ft</td>
                          <td style={{padding:"6px 10px"}}>
                            <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                              <span style={{width:8,height:8,borderRadius:2,background:SENSOR_COLORS[i%SENSOR_COLORS.length],flexShrink:0}}></span>
                              {s.id}
                            </span>
                          </td>
                          <td style={{padding:"6px 10px"}}>{depthProfileData.find(d=>d.Sensor_ID===s.id)?.Temperature??"-"}°C</td>
                          <td style={{padding:"6px 10px"}}>{s.avg}°C</td>
                          <td style={{padding:"6px 10px",color:"var(--color-text-danger)"}}>{s.max}°C</td>
                          <td style={{padding:"6px 10px",color:"var(--color-text-info)"}}>{s.min}°C</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* HEATMAP TAB */}
          {activeTab==="heatmap" && (
            <div>
              <SectionHeader title="Temperature heatmap" subtitle="How temperature changes across depths over time (last 48 readings)"/>
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                {heatmapData.timeSlots.length===0 ? (
                  <div style={{padding:"40px",textAlign:"center",color:"var(--color-text-secondary)",fontSize:13}}>No data for heatmap. Upload a CSV or adjust filters.</div>
                ) : (
                  <div style={{overflowX:"auto"}}>
                    {/* Y axis label */}
                    <div style={{fontSize:11,color:"var(--color-text-secondary)",marginBottom:6}}>Depth (ft) ↓ &nbsp;|&nbsp; Time →</div>
                    {heatmapData.depths.map((depth,di)=>(
                      <div key={depth} style={{display:"flex",alignItems:"center",gap:2,marginBottom:2}}>
                        <div style={{width:32,fontSize:10,color:"var(--color-text-secondary)",textAlign:"right",paddingRight:6,flexShrink:0}}>{depth}ft</div>
                        <div style={{display:"flex",gap:1,flexWrap:"nowrap"}}>
                          {heatmapData.timeSlots.map((_,ti)=>{
                            const cell = heatmapData.cells.find(c=>c.x===ti&&c.y===di);
                            const t = cell?.t;
                            return (
                              <div key={ti} title={t!==undefined?`${t}°C @ ${heatmapData.timeSlots[ti]}`:"No data"}
                                style={{width:10,height:18,background:t!==undefined?tempToColor(t):"var(--color-background-tertiary)",borderRadius:1,flexShrink:0,cursor:"default"}}>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {/* Color legend */}
                    <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8,fontSize:11,color:"var(--color-text-secondary)"}}>
                      <span>{tMin.toFixed(1)}°C</span>
                      <div style={{width:120,height:10,borderRadius:3,background:"linear-gradient(to right,rgb(34,180,221),rgb(234,50,31))"}}></div>
                      <span>{tMax.toFixed(1)}°C</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STATS TAB */}
          {activeTab==="stats" && (
            <div>
              <SectionHeader title="Statistical analysis" subtitle="Per-sensor averages, extremes, standard deviation, and median"/>
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                        {["Sensor","Depth","Avg","Max","Min","Median","Std Dev"].map(h=>(
                          <th key={h} style={{textAlign:"right",padding:"6px 10px",fontWeight:500,color:"var(--color-text-secondary)"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sensorStats.map((s,i)=>(
                        <tr key={s.id} style={{borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                          <td style={{padding:"6px 10px",textAlign:"right"}}>
                            <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                              <span style={{width:8,height:8,borderRadius:2,background:SENSOR_COLORS[i%SENSOR_COLORS.length],flexShrink:0}}></span>
                              {s.id}
                            </span>
                          </td>
                          <td style={{padding:"6px 10px",textAlign:"right",color:"var(--color-text-secondary)"}}>{s.depth} ft</td>
                          <td style={{padding:"6px 10px",textAlign:"right",fontWeight:500}}>{s.avg}°C</td>
                          <td style={{padding:"6px 10px",textAlign:"right",color:"var(--color-text-danger)"}}>{s.max}°C</td>
                          <td style={{padding:"6px 10px",textAlign:"right",color:"var(--color-text-info)"}}>{s.min}°C</td>
                          <td style={{padding:"6px 10px",textAlign:"right"}}>{s.median}°C</td>
                          <td style={{padding:"6px 10px",textAlign:"right",color:"var(--color-text-secondary)"}}>{s.std}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px"}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>Min / Avg / Max by sensor</div>
                <div style={{height:Math.max(220,sensorStats.length*34+60)}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={sensorStats} layout="vertical" margin={{top:0,right:20,bottom:0,left:20}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.4} horizontal={false}/>
                      <XAxis type="number" tick={{fontSize:10,fill:"var(--color-text-secondary)"}} unit="°C" tickLine={false} axisLine={false}/>
                      <YAxis dataKey="id" type="category" tick={{fontSize:11,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} width={28}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:11}} formatter={v=>[`${v}°C`]}/>
                      <Legend wrapperStyle={{fontSize:11}} iconSize={8}/>
                      <Bar dataKey="min" name="Min" fill="#378ADD" radius={[0,0,0,0]}/>
                      <Bar dataKey="avg" name="Avg" fill="#1D9E75" radius={[0,0,0,0]}/>
                      <Bar dataKey="max" name="Max" fill="#D85A30" radius={[0,3,3,0]}/>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* COMPARE TAB */}
          {activeTab==="compare" && (
            <div>
              <SectionHeader title="Sensor comparison" subtitle="Compare two sensors side by side"/>
              <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>Sensor A</span>
                  <select value={compA} onChange={e=>setCompA(e.target.value)} style={{fontSize:12,padding:"4px 8px",borderRadius:6}}>
                    {sensorList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <span style={{color:"var(--color-text-secondary)",fontSize:13}}>vs</span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,color:"var(--color-text-secondary)"}}>Sensor B</span>
                  <select value={compB} onChange={e=>setCompB(e.target.value)} style={{fontSize:12,padding:"4px 8px",borderRadius:6}}>
                    {sensorList.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              {/* Correlation card */}
              {correlation!==null && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:20}}>
                  <StatCard label="Correlation" value={correlation} icon="ti-math" accent={Math.abs(correlation)>0.8?"#1D9E75":Math.abs(correlation)>0.5?"#BA7517":"#D85A30"}/>
                  <StatCard label="Similarity" value={`${Math.round(Math.abs(correlation)*100)}%`} icon="ti-percentage"/>
                  <StatCard label="Avg gap" value={compData.length?avg(compData.map(r=>Math.abs(r.diff))).toFixed(2):"—"} unit="°C" icon="ti-arrows-diff"/>
                  <StatCard label="Data points" value={compData.length.toLocaleString()} icon="ti-point"/>
                </div>
              )}

              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>{compA} vs {compB} — temperature over time</div>
                <div style={{height:280}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={compData} margin={{top:4,right:8,bottom:4,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.4}/>
                      <XAxis dataKey="ts" tickFormatter={v=>new Date(v||0).toLocaleDateString("en",{month:"short",day:"numeric"})} tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false}/>
                      <YAxis tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} unit="°C" width={42}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:11}} labelFormatter={v=>new Date(v||0).toLocaleString()} formatter={(v,n)=>[`${v}°C`,n]}/>
                      <Legend wrapperStyle={{fontSize:11}} iconSize={8}/>
                      <Line type="monotone" dataKey={compA} stroke={SENSOR_COLORS[sensorList.indexOf(compA)%SENSOR_COLORS.length]} dot={false} strokeWidth={2} connectNulls/>
                      <Line type="monotone" dataKey={compB} stroke={SENSOR_COLORS[sensorList.indexOf(compB)%SENSOR_COLORS.length]} dot={false} strokeWidth={2} connectNulls/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px"}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:12}}>Temperature difference ({compA} − {compB})</div>
                <div style={{height:200}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={compData.slice(0,120)} margin={{top:4,right:8,bottom:4,left:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" strokeOpacity={0.4}/>
                      <XAxis dataKey="ts" tickFormatter={v=>new Date(v||0).toLocaleDateString("en",{month:"short",day:"numeric"})} tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false}/>
                      <YAxis tick={{fontSize:10,fill:"var(--color-text-secondary)"}} tickLine={false} axisLine={false} unit="°C" width={42}/>
                      <Tooltip contentStyle={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:6,fontSize:11}} labelFormatter={v=>new Date(v||0).toLocaleString()} formatter={v=>[`${v}°C`,"Δ"]}/>
                      <ReferenceLine y={0} stroke="var(--color-border-secondary)"/>
                      <Bar dataKey="diff" name="Δ temp">
                        {compData.slice(0,120).map((d,i)=><Cell key={i} fill={d.diff>=0?"#D85A30":"#378ADD"}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* ANOMALIES TAB */}
          {activeTab==="anomalies" && (
            <div>
              <SectionHeader title="Anomaly detection" subtitle="Readings more than 3 standard deviations from the sensor mean"/>
              {(() => {
                const anomalies = filteredData.filter(r=>r.anomaly).sort((a,b)=>b.ts-a.ts);
                return (
                  <>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:20}}>
                      <StatCard label="Anomalies found" value={anomalies.length} icon="ti-alert-triangle" accent={anomalies.length>0?"#D85A30":undefined}/>
                      <StatCard label="Affected sensors" value={new Set(anomalies.map(r=>r.Sensor_ID)).size} icon="ti-cpu"/>
                      <StatCard label="Anomaly rate" value={filteredData.length?((anomalies.length/filteredData.length)*100).toFixed(2):"0"} unit="%" icon="ti-percentage"/>
                    </div>
                    {anomalies.length===0 ? (
                      <div style={{background:"var(--color-background-success)",border:"0.5px solid var(--color-border-success)",borderRadius:"var(--border-radius-lg)",padding:"24px",textAlign:"center"}}>
                        <i className="ti ti-circle-check" style={{fontSize:28,color:"var(--color-text-success)",display:"block",marginBottom:8}} aria-hidden="true"></i>
                        <div style={{fontSize:14,color:"var(--color-text-success)",fontWeight:500}}>No anomalies detected</div>
                        <div style={{fontSize:12,color:"var(--color-text-success)",marginTop:4}}>All sensor readings are within normal range.</div>
                      </div>
                    ) : (
                      <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"16px"}}>
                        <div style={{overflowX:"auto"}}>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                            <thead>
                              <tr style={{borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                                {["Timestamp","Sensor","Depth","Temperature","Deviation"].map(h=>(
                                  <th key={h} style={{textAlign:"left",padding:"6px 10px",fontWeight:500,color:"var(--color-text-secondary)"}}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {anomalies.slice(0,50).map((r,i)=>{
                                const sStats = sensorStats.find(s=>s.id===r.Sensor_ID);
                                const dev = sStats ? Math.abs(r.Temperature-sStats.avg).toFixed(2) : "—";
                                const sIdx = sensorList.indexOf(r.Sensor_ID);
                                return (
                                  <tr key={i} style={{borderBottom:"0.5px solid var(--color-border-tertiary)",background:"var(--color-background-danger)"}}>
                                    <td style={{padding:"6px 10px",fontSize:11}}>{r.Timestamp}</td>
                                    <td style={{padding:"6px 10px"}}>
                                      <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                                        <span style={{width:8,height:8,borderRadius:2,background:SENSOR_COLORS[sIdx>=0?sIdx:0],flexShrink:0}}></span>
                                        {r.Sensor_ID}
                                      </span>
                                    </td>
                                    <td style={{padding:"6px 10px"}}>{r.Depth_ft} ft</td>
                                    <td style={{padding:"6px 10px",color:"var(--color-text-danger)",fontWeight:500}}>{r.Temperature}°C</td>
                                    <td style={{padding:"6px 10px",color:"var(--color-text-danger)"}}>+{dev}°C</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {anomalies.length>50 && <div style={{padding:"8px 10px",fontSize:11,color:"var(--color-text-secondary)"}}>{anomalies.length-50} more anomalies not shown.</div>}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* DATA TABLE TAB */}
          {activeTab==="data" && (
            <div>
              <SectionHeader title="Data table" subtitle={`${filteredData.length.toLocaleString()} readings — search, sort, and export`}/>
              <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
                <input type="text" placeholder="Search readings…" value={tableSearch} onChange={e=>{setTableSearch(e.target.value);setTablePage(0)}}
                  style={{flex:1,minWidth:180,fontSize:12,padding:"5px 10px",borderRadius:6}}/>
                <button onClick={()=>{
                  const csv=["Timestamp,Sensor_ID,Depth_ft,Temperature",...tableData.map(r=>`${r.Timestamp},${r.Sensor_ID},${r.Depth_ft},${r.Temperature}`)].join("\n");
                  const a=document.createElement("a");a.href="data:text/csv,"+encodeURIComponent(csv);a.download="soil_data.csv";a.click();
                }} style={{fontSize:12,padding:"5px 12px",borderRadius:6,border:"0.5px solid var(--color-border-secondary)",background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",gap:6,color:"var(--color-text-secondary)"}}>
                  <i className="ti ti-download" style={{fontSize:14}} aria-hidden="true"></i>Export CSV
                </button>
              </div>
              <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",overflow:"hidden"}}>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{background:"var(--color-background-secondary)",borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
                        {["Timestamp","Sensor ID","Depth (ft)","Temperature","Anomaly"].map(h=>(
                          <th key={h} style={{textAlign:"left",padding:"8px 12px",fontWeight:500,color:"var(--color-text-secondary)",whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pageData.map((r,i)=>{
                        const sIdx = sensorList.indexOf(r.Sensor_ID);
                        return (
                          <tr key={i} style={{borderBottom:"0.5px solid var(--color-border-tertiary)",background:r.anomaly?"var(--color-background-danger)":undefined}}>
                            <td style={{padding:"6px 12px",fontFamily:"var(--font-mono)",fontSize:11,whiteSpace:"nowrap"}}>{r.Timestamp}</td>
                            <td style={{padding:"6px 12px"}}>
                              <span style={{display:"inline-flex",alignItems:"center",gap:5}}>
                                <span style={{width:8,height:8,borderRadius:2,background:SENSOR_COLORS[sIdx>=0?sIdx:0],flexShrink:0}}></span>
                                {r.Sensor_ID}
                              </span>
                            </td>
                            <td style={{padding:"6px 12px"}}>{r.Depth_ft} ft</td>
                            <td style={{padding:"6px 12px",fontWeight:500,color:r.anomaly?"var(--color-text-danger)":undefined}}>{r.Temperature}°C</td>
                            <td style={{padding:"6px 12px"}}>{r.anomaly?<span style={{fontSize:11,color:"var(--color-text-danger)",display:"flex",alignItems:"center",gap:3}}><i className="ti ti-alert-triangle" style={{fontSize:12}} aria-hidden="true"></i>Yes</span>:<span style={{fontSize:11,color:"var(--color-text-secondary)"}}>—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",borderTop:"0.5px solid var(--color-border-tertiary)",fontSize:12,color:"var(--color-text-secondary)"}}>
                  <span>{tableData.length.toLocaleString()} total rows</span>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    <button onClick={()=>setTablePage(p=>Math.max(0,p-1))} disabled={tablePage===0} style={{padding:"3px 8px",borderRadius:4,border:"0.5px solid var(--color-border-secondary)",background:"transparent",cursor:tablePage===0?"default":"pointer",opacity:tablePage===0?0.4:1}}>‹</button>
                    <span style={{padding:"0 6px"}}>Page {tablePage+1} of {Math.max(1,totalPages)}</span>
                    <button onClick={()=>setTablePage(p=>Math.min(totalPages-1,p+1))} disabled={tablePage>=totalPages-1} style={{padding:"3px 8px",borderRadius:4,border:"0.5px solid var(--color-border-secondary)",background:"transparent",cursor:tablePage>=totalPages-1?"default":"pointer",opacity:tablePage>=totalPages-1?0.4:1}}>›</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
