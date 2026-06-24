/* =========================================================================
   Gestión de Espacios · Facultad de Filosofía y Letras
   Datos en archivo JSON dentro de una carpeta (OneDrive) vía File System
   Access API. Nada se guarda en el navegador salvo un puntero a la carpeta.
   Novedades: reservas periódicas (series) y búsqueda inversa por requisitos.
   ========================================================================= */
(() => {
"use strict";

/* ---------- Configuración ---------- */
const FILE_NAME   = "gestion-espacios.json";
const COPIES_DIR  = "copias";
const MAX_COPIES  = 30;
const DAY_START   = "08:00";
const DAY_END     = "22:00";
const STEP_MIN    = 30;
const DATA_VERSION = 3;
const DOW = ["lunes","martes","miércoles","jueves","viernes","sábado","domingo"]; // 0=lunes
const DOW_SHORT = ["L","M","X","J","V","S","D"];
const PLANTAS = ["baja","entreplanta","primera","segunda"];
const PLANTA_LABEL = {baja:"Planta baja",entreplanta:"Entreplanta",primera:"Primera planta",segunda:"Segunda planta"};

/* ---------- Estado ---------- */
let dirHandle = null;
let DB = null;              // {version, espacios:[], reservas:[], eliminadas:[]}
let fsSupported = "showDirectoryPicker" in window;
let lastSig = null;         // firma (lastModified:size) del archivo ya cargado
let pollTimer = null;
const POLL_MS = 5000;       // cada cuánto se comprueba el archivo en disco

/* =========================================================================
   Utilidades de tiempo
   ========================================================================= */
const t2m = t => { const [h,m]=t.split(":").map(Number); return h*60+m; };
const m2t = m => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
const overlap = (a1,a2,b1,b2) => a1 < b2 && b1 < a2;
function slotStarts(){ const out=[]; for(let m=t2m(DAY_START); m<t2m(DAY_END); m+=STEP_MIN) out.push(m2t(m)); return out; }
function slotEnds(){ const out=[]; for(let m=t2m(DAY_START)+STEP_MIN; m<=t2m(DAY_END); m+=STEP_MIN) out.push(m2t(m)); return out; }
// 0=lunes … 6=domingo
const dowOf = isoDate => { const d=new Date(isoDate+"T00:00:00"); return (d.getDay()+6)%7; };
const fmtDate = iso => { const d=new Date(iso+"T00:00:00"); return d.toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long",year:"numeric"}); };
const fmtDateShort = iso => { const d=new Date(iso+"T00:00:00"); return d.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"numeric"}); };
// Formatea una fecha usando componentes LOCALES (no UTC): evita el desfase de un
// día en zonas con offset positivo como España, que rompía semanas y series.
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayISO = () => isoOf(new Date());
function mondayOf(iso){ const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()-((d.getDay()+6)%7)); return isoOf(d); }
function addDays(iso,n){ const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return isoOf(d); }
const uid = () => Date.now().toString(36)+Math.random().toString(36).slice(2,8);

/* =========================================================================
   Persistencia del handle de carpeta (IndexedDB — solo el puntero, nunca datos)
   ========================================================================= */
function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open("ge-handle",1);
  r.onupgradeneeded=()=>r.result.createObjectStore("kv"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(k,v){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction("kv","readwrite"); tx.objectStore("kv").put(v,k); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbGet(k){ const db=await idb(); return new Promise((res,rej)=>{ const tx=db.transaction("kv","readonly"); const rq=tx.objectStore("kv").get(k); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }

/* =========================================================================
   Lectura / escritura del archivo de datos
   ========================================================================= */
async function ensurePermission(handle, mode="readwrite"){
  const opts={mode};
  if((await handle.queryPermission(opts))==="granted") return true;
  return (await handle.requestPermission(opts))==="granted";
}

function defaultData(){
  const espacios=[];
  for(let i=1;i<=33;i++){
    const planta = i<=10?"baja": i<=20?"primera": i<=30?"segunda":"entreplanta";
    espacios.push({id:uid(),nombre:`Aula ${i}`,planta,capacidad:i%4===0?80:i%3===0?60:40,
      dotacion:"Proyector, pantalla, sonido"});
  }
  espacios.push({id:uid(),nombre:"Paraninfo",planta:"baja",capacidad:300,dotacion:"Escenario, megafonía, proyección, atril"});
  espacios.push({id:uid(),nombre:"Salón de Actos",planta:"baja",capacidad:200,dotacion:"Megafonía, proyección, atril, regiduría"});
  espacios.push({id:uid(),nombre:"Sala Polivalente",planta:"primera",capacidad:60,dotacion:"Mobiliario móvil, proyector"});
  espacios.push({id:uid(),nombre:"Vestíbulo",planta:"baja",capacidad:150,dotacion:"Espacio abierto, paneles expositivos"});
  espacios.push({id:uid(),nombre:"Sala de Ordenadores",planta:"primera",capacidad:30,dotacion:"30 PCs, proyector, software docente"});
  return {version:DATA_VERSION,espacios,reservas:[],eliminadas:[],creada:new Date().toISOString()};
}

function normalize(d){
  d=d||{}; d.version=DATA_VERSION;
  d.espacios=Array.isArray(d.espacios)?d.espacios:[];
  d.reservas=Array.isArray(d.reservas)?d.reservas:[];
  d.eliminadas=Array.isArray(d.eliminadas)?d.eliminadas:[];
  return d;
}

async function readMainFile(){
  const fh=await dirHandle.getFileHandle(FILE_NAME,{create:false});
  const txt=await (await fh.getFile()).text();
  return normalize(txt.trim()?JSON.parse(txt):defaultData());
}

async function fileExists(name){
  try{ await dirHandle.getFileHandle(name,{create:false}); return true; }catch{ return false; }
}

async function writeFile(name,obj){
  const fh=await dirHandle.getFileHandle(name,{create:true});
  const w=await fh.createWritable();
  await w.write(JSON.stringify(obj,null,2));
  await w.close();
}

// Mezcla por id para reducir conflictos cuando varios usuarios escriben en OneDrive.
function merge(disk,mem){
  const tomb=new Set([...(disk.eliminadas||[]),...(mem.eliminadas||[])]);
  const resMap=new Map();
  (disk.reservas||[]).forEach(r=>resMap.set(r.id,r));
  (mem.reservas||[]).forEach(r=>resMap.set(r.id,r));        // los cambios locales recientes ganan
  const reservas=[...resMap.values()].filter(r=>!tomb.has(r.id));
  const espMap=new Map();
  (disk.espacios||[]).forEach(e=>espMap.set(e.id,e));
  (mem.espacios||[]).forEach(e=>espMap.set(e.id,e));
  return normalize({version:DATA_VERSION,espacios:[...espMap.values()],reservas,eliminadas:[...tomb]});
}

async function pruneCopies(copiesDir){
  const names=[];
  for await(const [n,h] of copiesDir.entries()) if(h.kind==="file"&&n.endsWith(".json")) names.push(n);
  names.sort(); // por nombre = por fecha (ISO)
  while(names.length>MAX_COPIES){ const old=names.shift(); try{ await copiesDir.removeEntry(old);}catch{} }
}

async function saveData(){
  if(!dirHandle) return;
  // 1) releer disco y combinar
  let disk=null;
  try{ if(await fileExists(FILE_NAME)) disk=await readMainFile(); }catch{}
  const merged = disk ? merge(disk,DB) : normalize(DB);
  DB=merged;
  // 2) escribir archivo principal
  await writeFile(FILE_NAME,DB);
  // 3) copia de seguridad con fecha/hora en copias/ (conserva las últimas 30)
  try{
    const cdir=await dirHandle.getDirectoryHandle(COPIES_DIR,{create:true});
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    await (async()=>{ const fh=await cdir.getFileHandle(`copia-${stamp}.json`,{create:true});
      const w=await fh.createWritable(); await w.write(JSON.stringify(DB,null,2)); await w.close(); })();
    await pruneCopies(cdir);
  }catch(e){ /* la copia es best-effort */ }
  await rememberSignature();   // evita que el sondeo trate nuestro propio guardado como cambio externo
  updateStatus();
}

async function latestCopy(){
  try{
    const cdir=await dirHandle.getDirectoryHandle(COPIES_DIR,{create:false});
    let best=null;
    for await(const [n,h] of cdir.entries()) if(h.kind==="file"&&n.endsWith(".json")&&(!best||n>best)) best=n;
    if(!best) return null;
    const fh=await cdir.getFileHandle(best,{create:false});
    return {name:best,data:normalize(JSON.parse(await (await fh.getFile()).text()))};
  }catch{ return null; }
}

/* =========================================================================
   Conexión a la carpeta
   ========================================================================= */
async function connectFolder(reuse){
  if(!fsSupported){ showGateWarn("Tu navegador no permite el acceso seguro a carpetas. Usa Google Chrome, Microsoft Edge u Opera de escritorio."); return; }
  try{
    if(!reuse){ dirHandle=await window.showDirectoryPicker({mode:"readwrite",id:"ge-data"}); await idbSet("dirHandle",dirHandle); }
    if(!await ensurePermission(dirHandle)){ showGateWarn("Necesito permiso de lectura y escritura sobre la carpeta."); return; }

    if(await fileExists(FILE_NAME)){
      DB=await readMainFile();
    }else{
      // archivo principal ausente: ¿restaurar desde copia?
      const lc=await latestCopy();
      if(lc && confirm(`No encuentro «${FILE_NAME}» en la carpeta, pero hay una copia de seguridad (${lc.name}). ¿Restaurarla?`)){
        DB=lc.data; await writeFile(FILE_NAME,DB); toast("Datos restaurados desde la última copia","ok");
      }else{
        DB=defaultData(); await writeFile(FILE_NAME,DB); toast("Carpeta inicializada con los espacios por defecto","ok");
      }
    }
    enterApp();
  }catch(e){
    if(e && e.name==="AbortError") return;       // el usuario canceló el diálogo
    console.error(e); showGateWarn("No se pudo abrir la carpeta. Inténtalo de nuevo.");
  }
}

async function changeFolder(){ dirHandle=null; await idbSet("dirHandle",null); await connectFolder(false); }
async function reload(){ try{ DB=await readMainFile(); await rememberSignature(); render(); toast("Datos recargados","ok"); }catch{ toast("No se pudo recargar","err"); } }

/* =========================================================================
   Actualización automática: comprueba el archivo en disco cada POLL_MS y, si
   otra persona/equipo lo ha cambiado (vía OneDrive), recarga los datos sin que
   el usuario tenga que refrescar. La rapidez la limita la sincronización de
   OneDrive entre equipos; aquí solo eliminamos el refresco manual.
   ========================================================================= */
async function fileSignature(){
  try{
    const fh=await dirHandle.getFileHandle(FILE_NAME,{create:false});
    const f=await fh.getFile();
    return `${f.lastModified}:${f.size}`;
  }catch{ return null; }
}
async function rememberSignature(){ lastSig=await fileSignature(); }

function startAutoSync(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(checkForUpdates,POLL_MS);
  // comprobación inmediata al volver a la pestaña del navegador
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden) checkForUpdates(); });
}

const LIVE_VIEWS=new Set(["disponibilidad","espacios","datos"]); // se repintan solas sin molestar
async function checkForUpdates(){
  if(!dirHandle || !DB) return;
  const sig=await fileSignature();
  if(sig===null || sig===lastSig) return;            // sin cambios (o archivo no disponible aún)
  let fresh;
  try{ fresh=await readMainFile(); }
  catch{ return; }                                   // OneDrive puede tenerlo bloqueado: se reintenta al siguiente ciclo
  lastSig=sig;
  DB=fresh;
  updateStatus();
  // No interrumpimos un diálogo abierto ni un formulario a medio rellenar.
  if($("#modalBg").classList.contains("show")) return;
  if(LIVE_VIEWS.has(currentView)) render();
  else toast("Datos actualizados desde otro equipo","warn");
}

/* =========================================================================
   Lógica de reservas
   ========================================================================= */
const espacioById = id => DB.espacios.find(e=>e.id===id);
const reservasDe = (espId,fecha) => DB.reservas.filter(r=>r.espacioId===espId && r.fecha===fecha);

function conflicto(espId,fecha,ini,fin,exceptId){
  return reservasDe(espId,fecha).some(r=> r.id!==exceptId && overlap(t2m(ini),t2m(fin),t2m(r.inicio),t2m(r.fin)));
}

function addReserva(o){ DB.reservas.push(o); }
function delReserva(id){
  DB.reservas=DB.reservas.filter(r=>r.id!==id);
  if(!DB.eliminadas.includes(id)) DB.eliminadas.push(id);
}
function delSerie(serieId){
  const ids=DB.reservas.filter(r=>r.serieId===serieId).map(r=>r.id);
  ids.forEach(id=>{ if(!DB.eliminadas.includes(id)) DB.eliminadas.push(id); });
  DB.reservas=DB.reservas.filter(r=>r.serieId!==serieId);
  return ids.length;
}

// Genera las fechas de una serie entre dos fechas según los días de semana marcados.
function fechasSerie(desde,hasta,dias /* set de 0..6 */){
  const out=[]; let cur=desde;
  let guard=0;
  while(cur<=hasta && guard++<800){ if(dias.has(dowOf(cur))) out.push(cur); cur=addDays(cur,1); }
  return out;
}

/* =========================================================================
   UI: navegación y render
   ========================================================================= */
const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
let currentView="reservar";
const main=$("#main");

async function enterApp(){
  $("#gate").style.display="none";
  $("#app").classList.add("ready");
  updateStatus();
  render();
  await rememberSignature();
  startAutoSync();
}
function updateStatus(){
  const dot=$("#statusDot"), txt=$("#statusTxt");
  if(dirHandle && DB){ dot.classList.remove("off"); txt.textContent=`${DB.espacios.length} espacios · ${DB.reservas.length} reservas`; }
  else { dot.classList.add("off"); txt.textContent="Sin conectar"; }
}
function showGateWarn(m){ const w=$("#gateWarn"); w.textContent=m; w.style.display="block"; }

$("#nav").addEventListener("click",e=>{
  const b=e.target.closest("button[data-view]"); if(!b) return;
  currentView=b.dataset.view;
  $$("#nav button").forEach(x=>x.classList.toggle("active",x===b));
  render();
});

function render(){
  if(!DB) return;
  ({reservar:viewReservar,disponibilidad:viewDisponibilidad,buscar:viewBuscar,
    consultas:viewConsultas,espacios:viewEspacios,datos:viewDatos}[currentView]||viewReservar)();
}

/* ---------- helpers de formulario ---------- */
function espacioOptions(sel){ return DB.espacios.slice().sort(byNombre)
  .map(e=>`<option value="${e.id}"${e.id===sel?" selected":""}>${esc(e.nombre)} · ${PLANTA_LABEL[e.planta]} · ${e.capacidad} pax</option>`).join(""); }
function timeOptions(list,sel){ return list.map(t=>`<option value="${t}"${t===sel?" selected":""}>${t}</option>`).join(""); }
const byNombre=(a,b)=>a.nombre.localeCompare(b.nombre,"es",{numeric:true});
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* =========================================================================
   VISTA · Reservar  (con reserva periódica)
   ========================================================================= */
let prefill=null; // {espacioId,fecha,inicio,fin}
function viewReservar(){
  const p=prefill||{}; prefill=null;
  const starts=slotStarts(), ends=slotEnds();
  main.innerHTML=`
  <div class="head"><div><h1>Nueva reserva</h1><p>Reserva puntual o periódica de cualquier espacio, de 8:00 a 22:00.</p></div></div>
  <div class="panel">
    <div class="grid2">
      <div><label class="fld">Espacio</label><select id="rEsp">${espacioOptions(p.espacioId)}</select></div>
      <div><label class="fld">Fecha</label><input type="date" id="rFecha" value="${p.fecha||todayISO()}" min="${todayISO()}"></div>
    </div>
    <div class="row" style="margin-top:14px">
      <div><label class="fld">Desde</label><select id="rIni">${timeOptions(starts,p.inicio||"09:00")}</select></div>
      <div><label class="fld">Hasta</label><select id="rFin">${timeOptions(ends,p.fin||"10:00")}</select></div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <div><label class="fld">Persona que reserva</label><input type="text" id="rPersona" placeholder="Nombre y apellidos"></div>
      <div><label class="fld">Motivo</label><input type="text" id="rMotivo" placeholder="Ej. Seminario de Historia Medieval"></div>
    </div>
    <div style="margin-top:14px"><label class="fld">Necesidades especiales <span style="color:var(--muted);font-weight:500">(opcional)</span></label>
      <textarea id="rNec" placeholder="Material tecnológico, mobiliario, disposición de sala…"></textarea></div>

    <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line)">
      <label class="switch"><input type="checkbox" id="rPeriod"> Reserva periódica (serie)</label>
      <div id="periodBox" style="display:none;margin-top:14px">
        <label class="fld">Repetir estos días</label>
        <div class="chips" id="rDias">${DOW_SHORT.map((d,i)=>`<div class="chip" data-d="${i}" title="${DOW[i]}">${d}</div>`).join("")}</div>
        <div class="row" style="margin-top:14px">
          <div><label class="fld">Hasta la fecha (incluida)</label><input type="date" id="rHasta" min="${todayISO()}"></div>
        </div>
        <p class="hint">Se crearán todas las sesiones del intervalo en los días marcados con el mismo horario. Las que choquen con otra reserva se omiten y te las indico. Cada sesión se puede cancelar de forma individual sin borrar la serie.</p>
      </div>
    </div>

    <div class="btn-row" style="margin-top:20px">
      <button class="btn btn-primary" id="rGuardar">Crear reserva</button>
    </div>
    <div id="rResult"></div>
  </div>`;

  $("#rPeriod").addEventListener("change",e=>{
    $("#periodBox").style.display=e.target.checked?"block":"none";
    $("#rGuardar").textContent=e.target.checked?"Crear serie de reservas":"Crear reserva";
    if(e.target.checked && !$("#rDias .chip.on")){ // marca por defecto el día de la fecha elegida
      const d=$(`#rDias .chip[data-d="${dowOf($("#rFecha").value)}"]`); if(d) d.classList.add("on");
    }
  });
  $("#rDias").addEventListener("click",e=>{ const c=e.target.closest(".chip"); if(c) c.classList.toggle("on"); });
  $("#rGuardar").addEventListener("click",submitReserva);
}

async function submitReserva(){
  const espId=$("#rEsp").value, fecha=$("#rFecha").value, ini=$("#rIni").value, fin=$("#rFin").value;
  const persona=$("#rPersona").value.trim(), motivo=$("#rMotivo").value.trim(), nec=$("#rNec").value.trim();
  const res=$("#rResult");
  if(t2m(fin)<=t2m(ini)) return toast("La hora de fin debe ser posterior a la de inicio","err");
  if(!persona) return toast("Indica la persona que reserva","err");
  if(!motivo)  return toast("Indica el motivo de la reserva","err");

  if(!$("#rPeriod").checked){
    if(conflicto(espId,fecha,ini,fin)) return toast("Ese espacio ya está reservado en ese tramo","err");
    addReserva({id:uid(),espacioId:espId,fecha,inicio:ini,fin,persona,motivo,necesidades:nec,serieId:null,creada:new Date().toISOString()});
    await saveData();
    toast("Reserva creada","ok");
    res.innerHTML=`<div class="summary"><b>Reserva creada.</b> ${esc(espacioById(espId).nombre)} · ${fmtDateShort(fecha)} · ${ini}–${fin}.</div>`;
    $("#rPersona").value=$("#rMotivo").value=$("#rNec").value="";
    return;
  }

  // ----- Serie -----
  const dias=new Set($$("#rDias .chip.on").map(c=>+c.dataset.d));
  const hasta=$("#rHasta").value;
  if(!dias.size) return toast("Marca al menos un día de la semana","err");
  if(!hasta)     return toast("Indica la fecha de fin de la serie","err");
  if(hasta<fecha) return toast("La fecha de fin debe ser igual o posterior a la de inicio","err");

  const fechas=fechasSerie(fecha,hasta,dias);
  if(!fechas.length) return toast("No hay ninguna fecha en ese intervalo con los días marcados","err");

  const serieId=uid(), creadas=[], choques=[];
  for(const f of fechas){
    if(conflicto(espId,f,ini,fin)) choques.push(f);
    else { addReserva({id:uid(),espacioId:espId,fecha:f,inicio:ini,fin,persona,motivo,necesidades:nec,serieId,creada:new Date().toISOString()}); creadas.push(f); }
  }
  if(!creadas.length){ res.innerHTML=`<div class="summary" style="background:var(--danger-bg);border-color:#f3c2c2"><b>No se creó ninguna sesión.</b> Todas las fechas chocaban con reservas existentes.</div>`; return toast("Serie no creada: todo en conflicto","err"); }
  await saveData();
  toast(`Serie creada: ${creadas.length} sesiones`,"ok");
  res.innerHTML=`<div class="summary">
    <b>Serie creada · ${creadas.length} sesiones</b> en ${esc(espacioById(espId).nombre)}, ${ini}–${fin}.
    <div style="font-size:13px;margin-top:6px;color:var(--muted)">Del ${fmtDateShort(creadas[0])} al ${fmtDateShort(creadas[creadas.length-1])} · días: ${[...dias].sort().map(d=>DOW_SHORT[d]).join(" ")}.</div>
    ${choques.length?`<div style="margin-top:8px"><b style="color:var(--warn)">${choques.length} sesión(es) omitida(s) por conflicto:</b><ul>${choques.map(f=>`<li>${fmtDateShort(f)} (${DOW[dowOf(f)]})</li>`).join("")}</ul></div>`:""}
  </div>`;
  $("#rPersona").value=$("#rMotivo").value=$("#rNec").value="";
}

/* =========================================================================
   VISTA · Disponibilidad  (rejilla semanal, solo motivo)
   ========================================================================= */
let dispEsp=null, dispWeek=null;
function viewDisponibilidad(){
  if(!dispEsp) dispEsp=DB.espacios.slice().sort(byNombre)[0]?.id;
  if(!dispWeek) dispWeek=mondayOf(todayISO());
  main.innerHTML=`
  <div class="head"><div><h1>Disponibilidad</h1><p>Rejilla semanal del espacio. Verde = libre (clic para reservar) · azul = ocupado (clic para ver el detalle).</p></div></div>
  <div class="panel">
    <div class="row" style="margin-bottom:6px">
      <div style="flex:2"><label class="fld">Espacio</label><select id="dEsp">${espacioOptions(dispEsp)}</select></div>
      <div><label class="fld">Semana</label><input type="date" id="dWeek" value="${dispWeek}"></div>
      <div style="flex:0"><button class="btn btn-ghost" id="dPrev">◀</button></div>
      <div style="flex:0"><button class="btn btn-ghost" id="dNext">▶</button></div>
    </div>
    <div id="calMount"></div>
    <div class="legend"><span><i style="background:var(--free-bg);border:1px solid var(--free-line)"></i>Libre</span><span><i style="background:var(--occ)"></i>Ocupado</span></div>
  </div>`;
  $("#dEsp").addEventListener("change",e=>{ dispEsp=e.target.value; render(); });
  $("#dWeek").addEventListener("change",e=>{ dispWeek=mondayOf(e.target.value); render(); });
  $("#dPrev").addEventListener("click",()=>{ dispWeek=addDays(dispWeek,-7); render(); });
  $("#dNext").addEventListener("click",()=>{ dispWeek=addDays(dispWeek,7); render(); });
  drawCalendar();
}

function drawCalendar(){
  const starts=slotStarts();
  const days=[...Array(7)].map((_,i)=>addDays(dispWeek,i));
  // reservas por día indexadas por hora de inicio
  const byDay=days.map(f=>{ const m={}; reservasDe(dispEsp,f).forEach(r=>m[r.inicio]=r); return m; });
  const skip=Array(7).fill(0);
  let body="";
  starts.forEach(s=>{
    let row=`<td class="time">${s}</td>`;
    for(let d=0;d<7;d++){
      if(skip[d]>0){ skip[d]--; continue; }
      const r=byDay[d][s];
      if(r){
        const span=Math.max(1,(t2m(r.fin)-t2m(r.inicio))/STEP_MIN);
        skip[d]=span-1;
        row+=`<td class="occ" rowspan="${span}" data-id="${r.id}"><div>${esc(r.motivo)}</div><div class="t">${r.inicio}–${r.fin}</div></td>`;
      }else{
        row+=`<td class="free" data-day="${days[d]}" data-ini="${s}"></td>`;
      }
    }
    body+=`<tr>${row}</tr>`;
  });
  const headCols=days.map(f=>{ const d=new Date(f+"T00:00:00");
    return `<th>${DOW[dowOf(f)].slice(0,3)}<small>${d.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit"})}</small></th>`; }).join("");
  $("#calMount").innerHTML=`<div class="gridwrap"><table class="cal"><thead><tr><th style="width:62px"></th>${headCols}</tr></thead><tbody>${body}</tbody></table></div>`;
  $("#calMount").addEventListener("click",e=>{
    const occ=e.target.closest("td.occ"); if(occ){ openReservaDetail(occ.dataset.id); return; }
    const free=e.target.closest("td.free");
    if(free){
      const ini=free.dataset.ini, fin=m2t(t2m(ini)+STEP_MIN);
      prefill={espacioId:dispEsp,fecha:free.dataset.day,inicio:ini,fin};
      currentView="reservar"; $$("#nav button").forEach(x=>x.classList.toggle("active",x.dataset.view==="reservar")); render();
    }
  });
}

/* =========================================================================
   VISTA · Buscar espacio  (búsqueda inversa por requisitos)
   ========================================================================= */
let lastSearch=null;
function viewBuscar(){
  const s=lastSearch||{fecha:todayISO(),inicio:"09:00",fin:"11:00",cap:"",planta:"",dot:""};
  main.innerHTML=`
  <div class="head"><div><h1>Buscar espacio libre</h1><p>Dime cuándo y qué necesitas; te listo los espacios disponibles que cumplen, del más ajustado al más grande.</p></div></div>
  <div class="panel">
    <div class="row">
      <div><label class="fld">Fecha</label><input type="date" id="bFecha" value="${s.fecha}" min="${todayISO()}"></div>
      <div><label class="fld">Desde</label><select id="bIni">${timeOptions(slotStarts(),s.inicio)}</select></div>
      <div><label class="fld">Hasta</label><select id="bFin">${timeOptions(slotEnds(),s.fin)}</select></div>
    </div>
    <div class="row" style="margin-top:14px">
      <div><label class="fld">Capacidad mínima</label><input type="number" id="bCap" min="1" placeholder="Nº de personas" value="${s.cap}"></div>
      <div><label class="fld">Planta</label><select id="bPlanta"><option value="">Cualquiera</option>${PLANTAS.map(p=>`<option value="${p}"${p===s.planta?" selected":""}>${PLANTA_LABEL[p]}</option>`).join("")}</select></div>
      <div><label class="fld">Dotación que contenga</label><input type="text" id="bDot" placeholder="Ej. proyector" value="${esc(s.dot)}"></div>
    </div>
    <div class="btn-row" style="margin-top:18px"><button class="btn btn-primary" id="bGo">Buscar disponibles</button></div>
  </div>
  <div id="bResult"></div>`;
  $("#bGo").addEventListener("click",runBuscar);
}

function runBuscar(){
  const fecha=$("#bFecha").value, ini=$("#bIni").value, fin=$("#bFin").value;
  if(t2m(fin)<=t2m(ini)) return toast("La hora de fin debe ser posterior a la de inicio","err");
  const cap=parseInt($("#bCap").value,10)||0;
  const planta=$("#bPlanta").value, dot=$("#bDot").value.trim().toLowerCase();
  lastSearch={fecha,inicio:ini,fin,cap:$("#bCap").value,planta,dot};

  const libres=DB.espacios.filter(e=>{
    if(planta && e.planta!==planta) return false;
    if(cap && (e.capacidad||0)<cap) return false;
    if(dot && !String(e.dotacion||"").toLowerCase().includes(dot)) return false;
    return !conflicto(e.id,fecha,ini,fin);            // libre en ese tramo
  }).sort((a,b)=>(a.capacidad-b.capacidad)||byNombre(a,b)); // mejor ajuste primero

  const out=$("#bResult");
  if(!libres.length){
    out.innerHTML=`<div class="panel"><div class="empty"><b>Ningún espacio disponible</b>No hay espacios libres que cumplan los requisitos para ${fmtDateShort(fecha)}, ${ini}–${fin}. Prueba a relajar la capacidad o la dotación.</div></div>`;
    return;
  }
  out.innerHTML=`<div class="panel">
    <h3 style="font-size:17px;margin-bottom:4px">${libres.length} espacio(s) disponible(s)</h3>
    <p class="hint" style="margin-bottom:12px">${fmtDate(fecha)} · ${ini}–${fin}</p>
    <table><thead><tr><th>Espacio</th><th>Planta</th><th>Capacidad</th><th>Dotación</th><th></th></tr></thead><tbody>
    ${libres.map(e=>`<tr>
      <td><b>${esc(e.nombre)}</b></td><td>${PLANTA_LABEL[e.planta]}</td><td>${e.capacidad} pax</td>
      <td style="color:var(--muted);font-size:13px">${esc(e.dotacion||"—")}</td>
      <td><button class="btn btn-soft btn-sm" data-esp="${e.id}">Reservar</button></td></tr>`).join("")}
    </tbody></table></div>`;
  out.querySelectorAll("button[data-esp]").forEach(b=>b.addEventListener("click",()=>{
    prefill={espacioId:b.dataset.esp,fecha,inicio:ini,fin};
    currentView="reservar"; $$("#nav button").forEach(x=>x.classList.toggle("active",x.dataset.view==="reservar")); render();
  }));
}

/* =========================================================================
   VISTA · Consultas + informes PDF
   ========================================================================= */
let qMode="aula";
function viewConsultas(){
  main.innerHTML=`
  <div class="head"><div><h1>Consultas</h1><p>Filtra las reservas y genera un informe imprimible en PDF.</p></div></div>
  <div class="panel">
    <label class="fld">Tipo de consulta</label>
    <div class="chips" id="qModes">
      ${[["aula","Por espacio"],["planta","Por planta"],["periodo","Por periodo de fechas"],["persona","Por persona"]]
        .map(([k,l])=>`<div class="chip${k===qMode?" on":""}" data-m="${k}">${l}</div>`).join("")}
    </div>
    <div id="qFilters" style="margin-top:16px"></div>
    <div class="btn-row" style="margin-top:16px"><button class="btn btn-primary" id="qRun">Consultar</button></div>
  </div>
  <div id="qResult"></div>`;
  $("#qModes").addEventListener("click",e=>{ const c=e.target.closest(".chip"); if(!c)return;
    qMode=c.dataset.m; $$("#qModes .chip").forEach(x=>x.classList.toggle("on",x===c)); drawQFilters(); });
  $("#qRun").addEventListener("click",runConsulta);
  drawQFilters();
}
function drawQFilters(){
  const f=$("#qFilters");
  if(qMode==="aula") f.innerHTML=`<div class="row">
    <div style="flex:2"><label class="fld">Espacio</label><select id="qEsp">${espacioOptions()}</select></div>
    <div><label class="fld">Desde</label><input type="date" id="qD1" value="${todayISO()}"></div>
    <div><label class="fld">Hasta</label><input type="date" id="qD2" value="${addDays(todayISO(),30)}"></div></div>`;
  else if(qMode==="planta") f.innerHTML=`<div class="row">
    <div><label class="fld">Planta</label><select id="qPlanta">${PLANTAS.map(p=>`<option value="${p}">${PLANTA_LABEL[p]}</option>`).join("")}</select></div>
    <div><label class="fld">Desde</label><input type="date" id="qD1" value="${todayISO()}"></div>
    <div><label class="fld">Hasta</label><input type="date" id="qD2" value="${addDays(todayISO(),30)}"></div></div>`;
  else if(qMode==="periodo") f.innerHTML=`<div class="row">
    <div><label class="fld">Desde</label><input type="date" id="qD1" value="${todayISO()}"></div>
    <div><label class="fld">Hasta</label><input type="date" id="qD2" value="${addDays(todayISO(),7)}"></div></div>`;
  else f.innerHTML=`<div class="row"><div style="flex:2"><label class="fld">Persona</label><input type="text" id="qPersona" placeholder="Nombre (búsqueda parcial)"></div></div>`;
}

function runConsulta(){
  let list=[], title="", subt="";
  const all=DB.reservas.slice();
  if(qMode==="aula"){
    const id=$("#qEsp").value,d1=$("#qD1").value,d2=$("#qD2").value;
    list=all.filter(r=>r.espacioId===id&&r.fecha>=d1&&r.fecha<=d2);
    title=`Reservas · ${espacioById(id).nombre}`; subt=`Del ${fmtDateShort(d1)} al ${fmtDateShort(d2)}`;
  }else if(qMode==="planta"){
    const pl=$("#qPlanta").value,d1=$("#qD1").value,d2=$("#qD2").value;
    const ids=new Set(DB.espacios.filter(e=>e.planta===pl).map(e=>e.id));
    list=all.filter(r=>ids.has(r.espacioId)&&r.fecha>=d1&&r.fecha<=d2);
    title=`Reservas · ${PLANTA_LABEL[pl]}`; subt=`Del ${fmtDateShort(d1)} al ${fmtDateShort(d2)}`;
  }else if(qMode==="periodo"){
    const d1=$("#qD1").value,d2=$("#qD2").value;
    list=all.filter(r=>r.fecha>=d1&&r.fecha<=d2);
    title="Reservas por periodo"; subt=`Del ${fmtDateShort(d1)} al ${fmtDateShort(d2)}`;
  }else{
    const q=$("#qPersona").value.trim().toLowerCase();
    list=all.filter(r=>r.persona.toLowerCase().includes(q)); 
    title="Reservas por persona"; subt=q?`Coincidencia: «${$("#qPersona").value.trim()}»`:"Todas las personas";
  }
  list.sort((a,b)=>(a.fecha+a.inicio).localeCompare(b.fecha+b.inicio));
  renderConsulta(list,title,subt);
}

function reservaRow(r,showPerson=true){
  const e=espacioById(r.espacioId);
  return `<tr>
    <td>${fmtDateShort(r.fecha)}<div style="font-size:11.5px;color:var(--muted)">${DOW[dowOf(r.fecha)]}</div></td>
    <td>${r.inicio}–${r.fin}</td>
    <td><b>${esc(e?e.nombre:"—")}</b></td>
    ${showPerson?`<td>${esc(r.persona)}</td>`:""}
    <td>${esc(r.motivo)}${r.serieId?' <span class="tag serie">serie</span>':""}${r.necesidades?`<div style="font-size:12px;color:var(--muted)">▸ ${esc(r.necesidades)}</div>`:""}</td>
    <td><button class="btn btn-ghost btn-sm" data-detail="${r.id}">Ver</button></td></tr>`;
}

function renderConsulta(list,title,subt){
  const out=$("#qResult");
  if(!list.length){ out.innerHTML=`<div class="panel"><div class="empty"><b>Sin resultados</b>No hay reservas que cumplan ese filtro.</div></div>`; return; }
  out.innerHTML=`<div class="panel">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div><h3 style="font-size:18px">${esc(title)}</h3><p class="hint">${esc(subt)} · ${list.length} reserva(s)</p></div>
      <button class="btn btn-soft" id="qPdf">⤓ Informe PDF</button>
    </div>
    <table><thead><tr><th>Fecha</th><th>Horario</th><th>Espacio</th><th>Persona</th><th>Motivo / necesidades</th><th></th></tr></thead>
    <tbody>${list.map(r=>reservaRow(r)).join("")}</tbody></table></div>`;
  out.querySelectorAll("button[data-detail]").forEach(b=>b.addEventListener("click",()=>openReservaDetail(b.dataset.detail)));
  $("#qPdf").addEventListener("click",()=>printReport(title,subt,list));
}

function printReport(title,subt,list){
  const rep=$("#report");
  rep.innerHTML=`
    <div class="rep-head">
      <img src="logo.png" alt="" onerror="this.style.display='none'">
      <div><h2>${esc(title)}</h2><div class="sub">Facultad de Filosofía y Letras · Gestión de Espacios</div></div>
    </div>
    <div class="rep-meta">${esc(subt)} · ${list.length} reserva(s) · Generado el ${new Date().toLocaleString("es-ES")}</div>
    <table><thead><tr><th>Fecha</th><th>Día</th><th>Horario</th><th>Espacio</th><th>Persona</th><th>Motivo</th><th>Necesidades</th></tr></thead>
    <tbody>${list.map(r=>{const e=espacioById(r.espacioId);return `<tr>
      <td>${fmtDateShort(r.fecha)}</td><td>${DOW[dowOf(r.fecha)]}</td><td>${r.inicio}–${r.fin}</td>
      <td>${esc(e?e.nombre:"—")}</td><td>${esc(r.persona)}</td><td>${esc(r.motivo)}</td><td>${esc(r.necesidades||"")}</td></tr>`;}).join("")}
    </tbody></table>`;
  window.print();
}

/* =========================================================================
   VISTA · Espacios (CRUD)
   ========================================================================= */
function viewEspacios(){
  const list=DB.espacios.slice().sort(byNombre);
  main.innerHTML=`
  <div class="head"><div><h1>Espacios</h1><p>${list.length} espacios. Crea, edita o elimina; los cambios se guardan en la carpeta.</p></div>
    <button class="btn btn-primary" id="eNew">+ Nuevo espacio</button></div>
  <div class="panel" style="padding:0">
    <table><thead><tr><th>Espacio</th><th>Planta</th><th>Capacidad</th><th>Dotación</th><th></th></tr></thead>
    <tbody>${list.map(e=>`<tr>
      <td><b>${esc(e.nombre)}</b></td><td>${PLANTA_LABEL[e.planta]}</td><td>${e.capacidad} pax</td>
      <td style="color:var(--muted);font-size:13px">${esc(e.dotacion||"—")}</td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="${e.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-del="${e.id}">Eliminar</button></td></tr>`).join("")}
    </tbody></table></div>`;
  $("#eNew").addEventListener("click",()=>openEspacioForm(null));
  $$("button[data-edit]").forEach(b=>b.addEventListener("click",()=>openEspacioForm(b.dataset.edit)));
  $$("button[data-del]").forEach(b=>b.addEventListener("click",()=>delEspacio(b.dataset.del)));
}

function openEspacioForm(id){
  const e=id?espacioById(id):{nombre:"",planta:"baja",capacidad:40,dotacion:""};
  openModal(`<h3>${id?"Editar espacio":"Nuevo espacio"}</h3>
    <div style="margin-top:14px"><label class="fld">Nombre</label><input type="text" id="eN" value="${esc(e.nombre)}"></div>
    <div class="grid2" style="margin-top:12px">
      <div><label class="fld">Planta</label><select id="eP">${PLANTAS.map(p=>`<option value="${p}"${p===e.planta?" selected":""}>${PLANTA_LABEL[p]}</option>`).join("")}</select></div>
      <div><label class="fld">Capacidad</label><input type="number" id="eC" min="1" value="${e.capacidad}"></div></div>
    <div style="margin-top:12px"><label class="fld">Dotación tecnológica</label><textarea id="eD">${esc(e.dotacion)}</textarea></div>
    <div class="btn-row"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" id="eSave">Guardar</button></div>`);
  $("#eSave").addEventListener("click",async()=>{
    const nombre=$("#eN").value.trim(); if(!nombre) return toast("El nombre es obligatorio","err");
    const obj={nombre,planta:$("#eP").value,capacidad:parseInt($("#eC").value,10)||1,dotacion:$("#eD").value.trim()};
    if(id) Object.assign(espacioById(id),obj); else DB.espacios.push({id:uid(),...obj});
    await saveData(); closeModal(); toast(id?"Espacio actualizado":"Espacio creado","ok"); render();
  });
}

async function delEspacio(id){
  const n=DB.reservas.filter(r=>r.espacioId===id).length;
  if(!confirm(`¿Eliminar «${espacioById(id).nombre}»?`+(n?`\nTiene ${n} reserva(s) asociada(s) que también se eliminarán.`:""))) return;
  DB.reservas.filter(r=>r.espacioId===id).forEach(r=>{ if(!DB.eliminadas.includes(r.id)) DB.eliminadas.push(r.id); });
  DB.reservas=DB.reservas.filter(r=>r.espacioId!==id);
  DB.espacios=DB.espacios.filter(e=>e.id!==id);
  await saveData(); toast("Espacio eliminado","ok"); render();
}

/* =========================================================================
   VISTA · Datos (carpeta, copias, sincronización)
   ========================================================================= */
function viewDatos(){
  main.innerHTML=`
  <div class="head"><div><h1>Datos y sincronización</h1><p>La app lee y escribe el archivo de tu carpeta. Nada se almacena en el navegador.</p></div></div>
  <div class="panel">
    <div class="grid3">
      <div><label class="fld">Archivo</label><div class="tag">${FILE_NAME}</div></div>
      <div><label class="fld">Espacios</label><div>${DB.espacios.length}</div></div>
      <div><label class="fld">Reservas</label><div>${DB.reservas.length}</div></div>
    </div>
    <div class="btn-row" style="margin-top:18px">
      <button class="btn btn-ghost" id="dReload">Recargar datos</button>
      <button class="btn btn-ghost" id="dChange">Cambiar carpeta</button>
      <button class="btn btn-soft" id="dBackup">Descargar copia de seguridad</button>
      <label class="btn btn-ghost" style="cursor:pointer">Importar copia…<input type="file" id="dImport" accept="application/json" hidden></label>
    </div>
  </div>
  <div class="panel">
    <h3 style="font-size:17px;margin-bottom:8px">Cómo funciona la sincronización</h3>
    <p class="hint" style="font-size:13.5px">La app lee y escribe el archivo directamente en tu carpeta. Si está dentro de OneDrive, los cambios llegan al resto de personas cuando OneDrive sincroniza. Antes de cada guardado, la app vuelve a leer el archivo del disco y combina por reserva, de modo que se reduce el riesgo de pisar cambios de otra persona. Además, cada guardado deja una copia con fecha y hora en la subcarpeta <b>${COPIES_DIR}/</b> (se conservan las últimas ${MAX_COPIES}); si algún día falta el archivo principal, al conectar te ofrece restaurarlo desde la copia más reciente.</p>
    <p class="hint" style="font-size:13.5px;margin-top:8px"><b>Actualización automática:</b> la app revisa el archivo cada ${POLL_MS/1000} segundos y, si otra persona ha hecho un cambio, recarga los datos sola, sin refrescar. La rapidez depende de lo que tarde OneDrive en propagar el archivo entre equipos. Para que vaya lo más fino posible, en el Explorador haz clic derecho sobre la carpeta de datos y elige <b>«Conservar siempre en este dispositivo»</b>.</p>
    <p class="hint" style="font-size:13.5px;margin-top:8px">Requisito: navegador de escritorio basado en Chromium (Chrome, Edge u Opera). Conviene desplegar en GitHub Pages (HTTPS).</p>
  </div>`;
  $("#dReload").addEventListener("click",reload);
  $("#dChange").addEventListener("click",changeFolder);
  $("#dBackup").addEventListener("click",()=>{
    const blob=new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download=`copia-gestion-espacios-${todayISO()}.json`; a.click(); URL.revokeObjectURL(a.href);
  });
  $("#dImport").addEventListener("change",async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ const d=normalize(JSON.parse(await f.text()));
      if(!confirm(`La copia tiene ${d.espacios.length} espacios y ${d.reservas.length} reservas. ¿Reemplazar los datos actuales?`)) return;
      DB=d; await saveData(); toast("Copia importada","ok"); render();
    }catch{ toast("El archivo no es una copia válida","err"); }
  });
}

/* =========================================================================
   Modal de detalle de reserva (con cancelar sesión / serie)
   ========================================================================= */
function openReservaDetail(id){
  const r=DB.reservas.find(x=>x.id===id); if(!r) return;
  const e=espacioById(r.espacioId);
  const enSerie=!!r.serieId;
  const nSerie=enSerie?DB.reservas.filter(x=>x.serieId===r.serieId).length:0;
  openModal(`<h3>${esc(e?e.nombre:"Espacio")}</h3>
    <div style="margin-top:10px">
      <div class="mrow"><b>Fecha</b><span>${fmtDate(r.fecha)}</span></div>
      <div class="mrow"><b>Horario</b><span>${r.inicio}–${r.fin}</span></div>
      <div class="mrow"><b>Persona</b><span>${esc(r.persona)}</span></div>
      <div class="mrow"><b>Motivo</b><span>${esc(r.motivo)}</span></div>
      ${r.necesidades?`<div class="mrow"><b>Necesidades</b><span>${esc(r.necesidades)}</span></div>`:""}
      ${enSerie?`<div class="mrow"><b>Serie</b><span><span class="tag serie">periódica</span> ${nSerie} sesiones</span></div>`:""}
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" data-close>Cerrar</button>
      ${enSerie?`<button class="btn btn-danger" id="delSerie">Cancelar serie (${nSerie})</button>`:""}
      <button class="btn btn-danger" id="delOne">Cancelar ${enSerie?"esta sesión":"reserva"}</button>
    </div>`);
  $("#delOne").addEventListener("click",async()=>{ delReserva(id); await saveData(); closeModal(); toast("Reserva cancelada","ok"); render(); });
  if(enSerie) $("#delSerie").addEventListener("click",async()=>{
    if(!confirm(`¿Cancelar las ${nSerie} sesiones de la serie?`)) return;
    const n=delSerie(r.serieId); await saveData(); closeModal(); toast(`${n} sesiones canceladas`,"ok"); render();
  });
}

/* =========================================================================
   Modal / toast genéricos
   ========================================================================= */
function openModal(html){ $("#modal").innerHTML=html; $("#modalBg").classList.add("show");
  $$("#modal [data-close]").forEach(b=>b.addEventListener("click",closeModal)); }
function closeModal(){ $("#modalBg").classList.remove("show"); }
$("#modalBg").addEventListener("click",e=>{ if(e.target.id==="modalBg") closeModal(); });

function toast(msg,kind=""){ const t=document.createElement("div"); t.className="toast "+kind; t.textContent=msg;
  $("#toast").appendChild(t); setTimeout(()=>{ t.style.opacity="0"; t.style.transition=".3s"; setTimeout(()=>t.remove(),300); },2600); }

/* =========================================================================
   Arranque
   ========================================================================= */
$("#btnConnect").addEventListener("click",()=>connectFolder(false));
(async()=>{
  if(!fsSupported){ showGateWarn("Tu navegador no permite el acceso seguro a carpetas. Usa Google Chrome, Microsoft Edge u Opera de escritorio."); return; }
  try{
    const saved=await idbGet("dirHandle");
    if(saved){ dirHandle=saved;
      if((await dirHandle.queryPermission({mode:"readwrite"}))==="granted"){ await connectFolder(true); }
      // si no hay permiso aún, el usuario pulsará "Conectar" y se reusa el handle
      else { $("#btnConnect").addEventListener("click",()=>connectFolder(true),{once:true}); }
    }
  }catch(e){ /* primera vez */ }
})();

})();
