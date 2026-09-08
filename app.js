const bag="https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=500&q=80";

// Safety net: surface any otherwise-silent JS error on screen (once per
// page load) instead of a button/action just appearing to do nothing.
let __shownErrorAlert = false;
window.addEventListener("error", (e) => {
  if (__shownErrorAlert) return;
  __shownErrorAlert = true;
  alert("Odottamaton virhe: " + (e.message || e) + "\n\nOta kuvakaappaus ja lähetä eteenpäin.");
});
window.addEventListener("unhandledrejection", (e) => {
  if (__shownErrorAlert) return;
  __shownErrorAlert = true;
  alert("Odottamaton virhe: " + (e.reason?.message || e.reason) + "\n\nOta kuvakaappaus ja lähetä eteenpäin.");
});

// Kept as a passthrough (no HEIC->JPEG conversion) — that added an external
// library dependency that caused more problems than it solved. If a photo
// is HEIC (iPhone default), it won't preview in-app; the reliable fix is
// changing the iPhone's camera format to JPEG (Settings > Camera > Formats
// > Most Compatible), not client-side conversion.
async function toDisplayableImage(file) {
  return file;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Uploads a photo to Supabase Storage and returns its public URL, instead of
// embedding the photo as base64 directly in the jobs table. Real phone
// photos run 3-8MB each; with base64 several jobs already made a plain
// "select * from jobs" time out (Postgres error 57014, statement timeout),
// which silently broke syncing across devices. Storage keeps each jobs row
// tiny (just a URL string) so listing/syncing jobs stays fast regardless of
// how many photos have been taken.
async function uploadJobImage(file, jobId, tag) {
  if (!supabaseClient) throw new Error("Ei yhteyttä tietokantaan");
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${jobId.replace(/[^a-zA-Z0-9-]/g, "")}-${tag}-${Date.now()}.${ext}`;
  const { error } = await supabaseClient.storage.from("job-photos").upload(path, file, {
    upsert: true,
    contentType: file.type || "image/jpeg"
  });
  if (error) throw error;
  const { data } = supabaseClient.storage.from("job-photos").getPublicUrl(path);
  return data.publicUrl;
}

let jobs=[];
let jobIdSeq=1053;
let todos=[];

let supabaseClient = null;

function checkSyncParam() {
  // Uses the URL fragment (#), not a query string, so this never gets sent to
  // the server/CDN access logs — only readable client-side.
  const hash = window.location.hash;
  if (hash && hash.startsWith("#sync=")) {
    try {
      const encoded = hash.slice("#sync=".length);
      const decoded = decodeURIComponent(encoded);
      const data = JSON.parse(atob(decoded));
      if (data.url && data.key) {
        localStorage.setItem("suutari_db_url", data.url);
        localStorage.setItem("suutari_db_key", data.key);
        if (data.geminiKey) {
          localStorage.setItem("suutari_gemini_key", data.geminiKey);
        }
        if (data.aiInstructions) {
          localStorage.setItem("suutari_ai_instructions", data.aiInstructions);
        }
        sessionStorage.setItem("suutari_sync_success", "true");
      }
    } catch (e) {
      console.error("Sync parsing failed:", e);
    }
    window.location.replace(window.location.origin + window.location.pathname);
  }
}
checkSyncParam();

if (sessionStorage.getItem("suutari_sync_success") === "true") {
  sessionStorage.removeItem("suutari_sync_success");
  alert("Asetukset (Supabase-tietokanta ja AI-avain) tuotu onnistuneesti tälle laitteelle!");
}

function initSupabase() {
  const defaultUrl = "https://yjcpygwcbhmxtuqwvzkj.supabase.co";
  const defaultKey = "sb_publishable_tBL_fxc91edlgH7WphAxbw_5ZVA1pje";
  
  const url = localStorage.getItem("suutari_db_url") || defaultUrl;
  const key = localStorage.getItem("suutari_db_key") || defaultKey;
  
  if (!localStorage.getItem("suutari_db_url")) localStorage.setItem("suutari_db_url", defaultUrl);
  if (!localStorage.getItem("suutari_db_key")) localStorage.setItem("suutari_db_key", defaultKey);
  
  if(url && key && typeof supabase !== 'undefined') {
    supabaseClient = supabase.createClient(url, key);
    return true;
  }
  return false;
}

function saveState(){
  // Real photos are several MB as base64 — caching them in localStorage
  // (on top of what's already saved to Supabase) fills the browser's quota
  // after just a few jobs and throws, which used to abort the whole save.
  // The local cache only needs to survive until the next Supabase sync, so
  // strip the heavy image fields from what gets cached; the DB keeps them.
  try {
    const lightJobs = jobs.map(({img, img_after, ...rest}) => rest);
    localStorage.setItem("suutari_jobs", JSON.stringify(lightJobs));
    localStorage.setItem("suutari_seqs", JSON.stringify({jobIdSeq}));
    localStorage.setItem("suutari_todos", JSON.stringify(todos));
  } catch (err) {
    console.error("Local cache save failed (data is still saved to the database):", err);
  }
  updateBadges();
}

function todayDateStr(){
  const d=new Date();
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

// After the shop's closing time, "today's deliveries" is a done deal —
// staff planning who's due in is really asking about tomorrow. Everywhere
// that logic applies (home stats, the delivery list, the reports tile)
// reads referenceDateStr() instead of todayDateStr() so they all flip
// together; actual-outcome figures (revenue earned, jobs delivered today,
// the calendar's "today" cell) stay on the real date.
const CLOSING_HOUR = 18;
function isAfterClosing(){
  return new Date().getHours() >= CLOSING_HOUR;
}
function referenceDateStr(){
  const d = new Date();
  if(isAfterClosing()) d.setDate(d.getDate()+1);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

function toFinDateStr(d){
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

// The next calendar day after `from`, pushed to Monday if it would
// otherwise land on a Saturday or Sunday.
function nextBusinessDay(from){
  const next = new Date(from);
  next.setHours(0,0,0,0);
  next.setDate(next.getDate() + 1);
  const day = next.getDay(); // 0 = Sunday, 6 = Saturday
  if(day === 6) next.setDate(next.getDate() + 2);
  else if(day === 0) next.setDate(next.getDate() + 1);
  return next;
}

// Every day after closing time, any job that's still unclaimed (not
// "done") and whose delivery date has arrived or already passed gets
// pushed to the next business day, so "Toimitus tänään" always reflects
// a realistic expected pickup day instead of accumulating stale dates.
// Self-limiting: once a job's date is rolled forward it's no longer due
// today, so this won't touch it again until it becomes due once more.
function rolloverOverdueDates(){
  if(!isAfterClosing()) return;
  const todayStart = new Date();
  todayStart.setHours(0,0,0,0);
  const rolled = [];
  jobs.forEach(j => {
    if(j.status === "done") return;
    const d = parseFinDate(j.date);
    if(!d || d > todayStart) return;
    j.date = toFinDateStr(nextBusinessDay(new Date()));
    j.postponed_count = (j.postponed_count || 0) + 1;
    rolled.push(j);
  });
  if(rolled.length){
    saveState();
    rolled.forEach(j => dbUpdateJob(j.id, { date: j.date, postponed_count: j.postponed_count }));
    renderHome();
    renderJobs();
  }
}

// Jobs that have been pushed forward by rolloverOverdueDates() at least
// once and are still unclaimed (any status except "done") — the job's own
// `date` keeps advancing, so postponed_count is what actually tracks "this
// customer hasn't come to pick this up" rather than a raw date comparison.
function overdueUnclaimedJobs(){
  return jobs.filter(j => j.status !== "done" && (j.postponed_count || 0) > 0);
}

function updateBadges(){
  const lateJobs = jobs.filter(j=>j.status==="late").length;
  const activeJobs = jobs.filter(j=>j.status==="active").length;
  const readyJobs = jobs.filter(j=>j.status==="ready").length;
  const afterClosing = isAfterClosing();
  const refDate = referenceDateStr();
  const dueRefJobs = jobs.filter(j=>j.date===refDate);
  const whatsappWaiting = jobs.filter(j=>j.source==="whatsapp" && j.status==="waiting").length;

  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val;};
  const actionsNeeded = lateJobs + whatsappWaiting;
  set("statActionsNeeded", actionsNeeded);
  set("statDueToday", dueRefJobs.length);
  set("statDueTodayLabel", afterClosing ? "Toimitus huomenna" : "Toimitus tänään");
  set("statDueTodaySpan", afterClosing ? "🌙 Kauppa on kiinni" : "2 tunnin sisällä");
  set("statInProgress", activeJobs);
  set("statReady", readyJobs);
  set("statNewMsg", whatsappWaiting);
  const overdueJobs = overdueUnclaimedJobs();
  const overdueSum = overdueJobs.reduce((sum, j) => sum + (Number(j.price) || 0), 0);
  set("statOverdueCount", overdueJobs.length);
  set("statOverdueSum", "€" + overdueSum);
  set("todayCardTitle", afterClosing ? "📦 Toimitus huomenna" : "📦 Toimitus tänään");
  set("todayCount", `${dueRefJobs.length} työtä`);
  const todayEl = document.getElementById("today");
  if(todayEl) todayEl.innerHTML = dueRefJobs.map(jobLine).join("") || `<p class="empty-row" style="color:var(--text-muted);font-size:13px;padding:10px 0;">Ei ${afterClosing?"huomiselle":"tälle päivälle"} merkittyjä toimituksia.</p>`;

  // Daily business snapshot (Päivän tilanne): today's intake, ready backlog,
  // today's deliveries and the revenue those deliveries brought in.
  const todayISO = new Date().toISOString().slice(0,10);
  const incomingToday = jobs.filter(j => jobCreatedDateStr(j) === todayISO).length;
  const deliveredTodayJobs = jobs.filter(j => j.delivered_at && String(j.delivered_at).slice(0,10) === todayISO);
  const revenueToday = deliveredTodayJobs.reduce((sum, j) => sum + (Number(j.price) || 0), 0);
  set("statIncomingToday", incomingToday);
  set("statReadyToday", readyJobs);
  set("statDeliveredToday", deliveredTodayJobs.length);
  set("statRevenueToday", "€" + revenueToday);

  const badge = document.getElementById("notifBadge");
  if (badge) {
    badge.textContent = actionsNeeded > 99 ? "99+" : actionsNeeded;
    badge.style.display = actionsNeeded > 0 ? "flex" : "none";
  }
  renderMorningBrief();
}

// Surfaces database sync failures on screen instead of only in the console.
// dbInsertJob/dbUpdateJob* calls are fire-and-forget (not awaited by their
// callers), so without this, a failed save — e.g. a photo too large for one
// request, a dropped connection — looked identical to a successful one: the
// job stayed visible locally but silently never reached the other devices.
function notifyDbError(action, error) {
  console.error(action, error);
  if (__shownErrorAlert) return;
  __shownErrorAlert = true;
  alert(`Tallennus ei synkronoitunut palvelimelle (${action}).\n\nTyö näkyy tällä laitteella, mutta ei välttämättä muilla, ennen kuin tämä korjaantuu. Tarkista verkkoyhteys ja yritä uudelleen.\n\nVirhe: ${error?.message || error}`);
}

async function dbInsertJob(j) {
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("jobs").insert([j]);
      if(error) notifyDbError("uuden työn tallennus", error);
    } catch(err) {
      notifyDbError("uuden työn tallennus", err);
    }
  }
}

async function dbDeleteJob(id) {
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("jobs").delete().eq("id", id);
      if(error) console.error("Supabase delete job error:", error);
    } catch(err) {
      console.error(err);
    }
  }
}

async function dbUpdateJobStatus(id, status) {
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("jobs").update({ status }).eq("id", id);
      if(error) notifyDbError("tilan päivitys", error);
    } catch(err) {
      notifyDbError("tilan päivitys", err);
    }
  }
}

async function dbUpdateJobAfterImage(id, img_after) {
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("jobs").update({ img_after }).eq("id", id);
      if(error) notifyDbError("jälkikuvan tallennus", error);
    } catch(err) {
      notifyDbError("jälkikuvan tallennus", err);
    }
  }
}

async function dbUpdateJob(id, fields) {
  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.from("jobs").update(fields).eq("id", id);
      if(error) notifyDbError("työn päivitys", error);
    } catch(err) {
      notifyDbError("työn päivitys", err);
    }
  }
}

async function syncFromDb() {
  if(!supabaseClient) return false;
  try {
    const { data: jobData, error: jobErr } = await supabaseClient.from("jobs").select("*").order("created_at", { ascending: false });
    if(jobErr) throw jobErr;

    jobs = jobData || [];
    saveState();
    return true;
  } catch(err) {
    console.error("Database sync failed:", err.message);
    return false;
  }
}

async function initData(){
  const storedJobs=localStorage.getItem("suutari_jobs");
  const storedSeqs=localStorage.getItem("suutari_seqs");
  if(storedJobs){
    jobs=JSON.parse(storedJobs);
    if(storedSeqs){
      const seqs=JSON.parse(storedSeqs);
      jobIdSeq=seqs.jobIdSeq||1053;
    }
  }else{
    jobs=[];
  }

  const storedTodos = localStorage.getItem("suutari_todos");
  todos = storedTodos ? JSON.parse(storedTodos) : [];

  // Automatically determine next jobIdSeq based on max job ID in the list
  if (jobs && jobs.length > 0) {
    let maxId = 1052;
    jobs.forEach(j => {
      const num = parseInt(j.id.replace("#", ""), 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    });
    jobIdSeq = maxId + 1;
  } else {
    jobIdSeq = 1053;
  }

  // Try to connect to Supabase and pull fresh data
  if (initSupabase()) {
    console.log("Supabase connected! Syncing...");
    await syncFromDb();
  }
}

const statusLabel={active:"Työn alla",waiting:"Odottaa",ready:"Noudettavissa",late:"Myöhässä",arrived:"Tuote saapui",done:"Luovutettu"};
function statusPillClass(s){
  if(s==='late') return 'red';
  if(s==='waiting'||s==='arrived') return 'orange';
  if(s==='done') return 'green';
  return 'teal';
}

// Real, ordered progress steps for a job — used for both the "Työnkulku"
// timeline and the "Päivitä tila" picker, so both always agree with the
// job's actual status instead of a hardcoded/fake set of steps.
function jobStatusSteps(j){
  return j.source === "whatsapp"
    ? [["waiting","Odottaa"],["arrived","Tuote saapui"],["active","Työn alla"],["ready","Valmis noudettavaksi"],["done","Toimitettu"]]
    : [["waiting","Odottaa"],["active","Työn alla"],["ready","Valmis noudettavaksi"],["done","Luovutettu"]];
}

function jobTimelineHtml(j){
  const steps = jobStatusSteps(j);
  const idx = steps.findIndex(s=>s[0]===j.status);
  return steps.map((s,i)=>{
    const reached = idx>=0 && i<=idx;
    return `<div class="step ${reached?"done":""}"><i></i><div><b>${s[1]}</b></div></div>`;
  }).join("");
}

function showPage(id){
  document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll("[data-page]").forEach(x=>x.classList.toggle("active",x.dataset.page===id));
  scrollTo({top:0,behavior:"smooth"});
  if(id==="jobs")renderJobs();
  if(id==="calendar")renderCalendar();
  if(id==="customers")renderCustomers();
  if(id==="reports")initReportsPeriod();
  if(id==="shelves")renderShelves();
  if(id==="social")renderSocial();
  if(id==="settings") {
    document.getElementById("dbUrl").value = localStorage.getItem("suutari_db_url") || "";
    document.getElementById("dbKey").value = localStorage.getItem("suutari_db_key") || "";
    document.getElementById("connStatus").style.display = "none";
    document.getElementById("geminiKey").value = localStorage.getItem("suutari_gemini_key") || "";
    document.getElementById("aiStatus").style.display = "none";
    document.getElementById("aiInstructions").value = localStorage.getItem("suutari_ai_instructions") || "";
    document.getElementById("aiInstructionsStatus").style.display = "none";
    document.getElementById("currentUserEmail").textContent = currentUser?.email || "—";
    document.getElementById("newPassword").value = "";
    document.getElementById("authSettingsStatus").style.display = "none";
  }
}
document.querySelectorAll("[data-page]").forEach(x=>x.onclick=()=>showPage(x.dataset.page));

function jobLine(j){return `<div class="job-line" onclick="openJob('${j.id}')"><img class="thumb" src="${j.img}"><div><b>${j.source==="whatsapp"?"💬 ":""}${j.id} · ${j.name}</b><small>${j.product} · ${j.work}</small></div><div class="job-price">${j.price} €<span class="pill ${statusPillClass(j.status)}" onclick="event.stopPropagation();openStatus('${j.id}')" title="Päivitä tila">${statusLabel[j.status]||j.status}</span></div></div>`}

function renderHome(){
  updateHeaderDate();
  document.getElementById("priority").innerHTML=jobs.slice(0,3).map(j=>`<div class="priority" onclick="openJob('${j.id}')"><div class="priority-top"><span class="pill ${statusPillClass(j.status)}" onclick="event.stopPropagation();openStatus('${j.id}')" title="Päivitä tila">${(statusLabel[j.status]||j.status).toUpperCase()}</span><b>${j.loc}</b></div><h3>${j.id} · ${j.name}</h3><p>${j.product}<br>${j.work} · ${j.price} €<br>Toimitus: ${j.date}</p></div>`).join("");
  renderMorningBrief();
  renderTodos();
  renderIntakeChart();
  updateBadges();
}

let intakeImageBase64 = null;
let intakeImageReading = null; // Promise that resolves once the selected photo has finished converting to base64

function previewIntakeImage(e) {
  const f = e.target.files?.[0];
  if(!f) return;

  const preview = document.getElementById("intakePreview");
  const content = document.getElementById("intakeDropContent");

  // Converting a HEIC photo can take a few seconds on a phone — show a
  // loading state immediately so it's never unclear whether anything
  // happened. The preview itself only appears once it's actually ready.
  preview.style.display = "none";
  content.style.display = "block";
  content.innerHTML = "⏳ Ladataan kuvaa...";

  // Assigned synchronously so a fast click on Save (before this finishes)
  // still finds a promise to await instead of saving with no photo.
  // Wrapped in try/finally so a failure here (bad file, conversion error,
  // read error) can never leave saveJob() waiting on this forever.
  intakeImageReading = (async () => {
    try {
      const displayFile = await toDisplayableImage(f);
      preview.src = URL.createObjectURL(displayFile);
      preview.style.display = "block";
      preview.style.maxWidth = "100%";
      preview.style.maxHeight = "200px";
      preview.style.borderRadius = "8px";
      preview.style.marginTop = "8px";
      preview.style.objectFit = "cover";
      content.style.display = "none";
      intakeImageBase64 = await blobToDataURL(displayFile);
      recognizeProductFromPhoto();
    } catch (err) {
      console.error("Image preview failed:", err);
      content.innerHTML = "⚠️ Kuvan lataus epäonnistui. Yritä valita kuva uudelleen.";
      content.style.display = "block";
      preview.style.display = "none";
    } finally {
      intakeImageReading = null;
    }
  })();
}

// WhatsApp orders are tracked by a "Wxxxx" ticket number, typed into the
// same Asiakas field walk-in customers' name goes in (see get_jobs_by_ticket
// — the customer looks this number up on the tracking page later). Staff
// used to type the next number by hand ("started at W1001, we're at W1012
// now") — this finds the highest existing Wxxxx across all jobs and
// suggests the next one automatically instead.
function nextWhatsappNumber(){
  const nums = jobs
    .map(j => /^W(\d+)$/i.exec(String(j.name || "").trim()))
    .filter(Boolean)
    .map(m => +m[1]);
  const next = nums.length ? Math.max(...nums) + 1 : 1001;
  return "W" + next;
}

function toggleWhatsappTracking(){
  const source = document.getElementById("source")?.value;
  const field = document.getElementById("whatsappTrackingField");
  if(field) field.style.display = source === "whatsapp" ? "block" : "none";
  if(source === "whatsapp"){
    const nameEl = document.getElementById("n");
    if(nameEl && !nameEl.value.trim()) nameEl.value = nextWhatsappNumber();
  }
}

function openIntake(prefill=null){
  intakeImageReading = null;
  let initialImgStyle = "display:none;";
  let initialContentStyle = "display:block;";
  if (prefill && prefill.img) {
    intakeImageBase64 = prefill.img;
    initialImgStyle = "display:block; max-width: 100%; max-height: 200px; border-radius: 8px; margin-top: 5px;";
    initialContentStyle = "display:none;";
  } else {
    intakeImageBase64 = null;
  }

  const suggestion = prefill?.date ? null : suggestDeliveryDate();
  const dateValue = prefill?.date ? finDateToIso(prefill.date) : (suggestion ? suggestion.iso : "");
  const dateHint = suggestion ? `📅 Ehdotettu vapaampi päivä (${suggestion.count} työtä sinä päivänä)` : "";

  document.getElementById("modalBody").innerHTML=`<h2>📦 Uusi vastaanotto</h2><p style="font-size:12px;color:#78858d">Asiakas toi tuotteen. Luo työ alle 10 sekunnissa.</p>
<div class="form">
  <div class="field full">
    <label>Lähde</label>
    <select id="source" onchange="toggleWhatsappTracking()">
      <option value="store" ${prefill?.source!=="whatsapp"?"selected":""}>🏪 Myymälä</option>
      <option value="whatsapp" ${prefill?.source==="whatsapp"?"selected":""}>💬 WhatsApp</option>
    </select>
  </div>
  <div id="whatsappTrackingField" class="field full" style="display:${prefill?.source==="whatsapp"?"block":"none"};">
    <label>Asiakkaan WhatsApp-viesti <small style="font-weight:400;color:var(--text-muted);">(valinnainen jos lisäät kuvan alla)</small></label>
    <textarea id="whatsappMsgPaste" rows="4" placeholder="Liitä tähän asiakkaan WhatsApp-viesti sellaisenaan. Voit jättää tyhjäksi jos arvioit pelkän kuvan perusteella."></textarea>
    <button type="button" class="save" style="margin-top:6px;background:var(--teal);color:white;border:0;" onclick="evaluateWhatsappMessage()">🪄 Arvioi ja täytä lomake (viesti ja/tai kuva)</button>
    <small id="whatsappMsgHint" style="display:none;font-weight:600;"></small>
    <label style="margin-top:14px;">WhatsApp-seuranta</label>
    <select id="whatsappStage">
      <option value="waiting">⏳ Odottaa (tuote ei vielä saapunut)</option>
      <option value="arrived">📦 Tuote saapui</option>
      <option value="done">✔ Toimitettu</option>
    </select>
  </div>
  <div class="field"><label>Asiakas</label><input id="n" value="${prefill?.name||""}" placeholder="Nimi"></div>
  <div class="field"><label>Puhelin</label><input id="p" value="${prefill?.phone||""}" placeholder="040..."></div>
  <div class="field"><label>Tuote</label><input id="prod" list="tuoteOptions" value="${prefill?.product||""}" placeholder="Marimekko käsilaukku" onblur="suggestPriceFromAI()"></div>
  <div class="field"><label>Korjaus</label><input id="work" list="korjausOptions" value="${prefill?.work||""}" placeholder="Vetoketjun vaihto" onblur="suggestPriceFromAI()"></div>
  <div class="field"><label>Hinta (€)</label><input id="price" type="number" value="45"><small id="priceHint" style="display:none;color:var(--teal);font-weight:600;"></small></div>
  <div class="field"><label>Toimitus</label><input id="date" type="date" value="${dateValue}" oninput="document.getElementById('dateHint').style.display='none';"><small id="dateHint" style="color:var(--text-muted);${dateHint?"":"display:none;"}">${dateHint}</small></div>
  <div class="field full"><label>Hylly / sijainti</label><input id="loc" value="A1-01" placeholder="A3-07"></div>
  <div class="field full">
    <label>Kuva</label>
    <label class="dropzone" id="intakeDropzone" style="border: 2px dashed var(--border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; background: var(--bg); min-height: 100px; position: relative;">
      <input type="file" id="jobFile" accept="image/*" style="display:none" onchange="previewIntakeImage(event)">
      <div id="intakeDropContent" style="text-align:center; color: var(--text-muted); font-size: 13px; ${initialContentStyle}">
        📷 Ota kuva / valitse tiedosto<br>
        <small style="font-size:11px;">Ennen-kuva suositeltava</small>
      </div>
      <img id="intakePreview" src="${prefill?.img||""}" style="${initialImgStyle}">
    </label>
    <small id="photoRecognizeHint" style="display:none;color:var(--teal);font-weight:600;"></small>
  </div>
  <div class="field full"><label>Sisäinen huomautus</label><textarea id="note">${prefill?"Siirretty WhatsApp-tiedustelusta.":""}</textarea></div>
  <div class="field full"><label>Muistiinpano asiakkaalle <small style="font-weight:400;color:var(--text-muted);">(näkyy asiakkaan seurantasivulla)</small></label><textarea id="customerNote" placeholder="Esim. huomioita tuotteesta tai korjauksesta, jotka asiakkaan on hyvä tietää"></textarea>
    <button type="button" class="save" style="margin-top:6px;background:var(--primary-light);color:var(--primary);border:0;" onclick="copyCustomerNote()">📋 Kopioi vastaus WhatsAppiin</button>
    <small id="copyCustomerNoteHint" style="display:none;color:var(--teal);font-weight:600;"></small>
  </div>
</div>
<div class="modal-actions" style="display:flex; gap:10px; flex-wrap:wrap;">
  <button class="cancel" onclick="closeModal()">Peruuta</button>
  <button class="save" onclick="saveJob(true)" style="background:var(--teal); color:white; border:0;">TALLENNA & LISÄÄ TOINEN TUOTE</button>
  <button class="save" onclick="saveJob(false)" style="background:var(--primary); color:white; border:0;">TALLENNA & VALMIS</button>
</div>`;
  document.getElementById("modal").classList.remove("hidden");
  toggleWhatsappTracking();
}

async function saveJob(addAnother = false){
  if (intakeImageReading) {
    // A photo was just selected and is still being converted — wait for it
    // so the job isn't saved with a fallback image instead of the real one.
    // Buttons show a loading label so tapping while disabled doesn't look broken.
    // try/finally + a timeout guarantee the buttons always come back, even if
    // the conversion errors out or hangs (bad file, slow device, etc.).
    const saveButtons = document.querySelectorAll(".modal-actions .save");
    const originalLabels = Array.from(saveButtons).map(b => b.textContent);
    saveButtons.forEach(b => { b.disabled = true; b.textContent = "⏳ Ladataan kuvaa..."; });
    try {
      await Promise.race([
        intakeImageReading,
        new Promise(resolve => setTimeout(resolve, 15000))
      ]);
    } catch (err) {
      console.error("Waiting for image failed:", err);
    } finally {
      saveButtons.forEach((b,i) => { b.disabled = false; b.textContent = originalLabels[i]; });
    }
  }

  // Wrapped so any unexpected error shows up on screen instead of silently
  // leaving the button looking like it did nothing.
  try {
    let d=document.getElementById("date").value;
    const nextId = "#" + jobIdSeq;
    jobIdSeq++;

    const source = document.getElementById("source")?.value || "store";
    const status = source === "whatsapp" ? (document.getElementById("whatsappStage")?.value || "waiting") : "active";

    // Upload the actual photo file to Storage (not base64-in-the-row) so the
    // jobs table stays light and syncing across devices stays fast. Falls
    // back to the local base64 preview if the upload fails (e.g. offline).
    let imgUrl = intakeImageBase64 || bag;
    const selectedFile = document.getElementById("jobFile")?.files?.[0];
    if (selectedFile) {
      const saveButtons = document.querySelectorAll(".modal-actions .save");
      const originalLabels = Array.from(saveButtons).map(b => b.textContent);
      saveButtons.forEach(b => { b.disabled = true; b.textContent = "⏳ Tallennetaan kuvaa..."; });
      try {
        imgUrl = await uploadJobImage(selectedFile, nextId, "before");
      } catch (err) {
        notifyDbError("kuvan tallennus pilveen", err);
      } finally {
        saveButtons.forEach((b,i) => { b.disabled = false; b.textContent = originalLabels[i]; });
      }
    }

    let j={
      id: nextId,
      name:document.getElementById("n").value||"Uusi asiakas",
      phone:document.getElementById("p").value||"",
      product:document.getElementById("prod").value||"Tuote",
      work:document.getElementById("work").value||"Korjaus",
      price:+document.getElementById("price").value||0,
      date:d?d.split("-").reverse().join("."):"28.08.2026",
      status,
      source,
      loc:document.getElementById("loc").value||"A1-01",
      img:imgUrl,
      note:document.getElementById("note").value,
      customer_note:document.getElementById("customerNote")?.value||""
    };
    jobs.unshift(j);

    saveState();
    dbInsertJob(j);
    renderHome();

    if (addAnother) {
      // Reset product fields, but keep name and phone
      document.getElementById("prod").value = "";
      document.getElementById("work").value = "";
      document.getElementById("price").value = "45";
      document.getElementById("note").value = "";
      const priceHint = document.getElementById("priceHint");
      if (priceHint) priceHint.style.display = "none";
      const photoHint = document.getElementById("photoRecognizeHint");
      if (photoHint) photoHint.style.display = "none";

      // Reset image
      intakeImageBase64 = null;
      const intakePreview = document.getElementById("intakePreview");
      if (intakePreview) {
        intakePreview.src = "";
        intakePreview.style.display = "none";
      }
      const intakeDropContent = document.getElementById("intakeDropContent");
      if (intakeDropContent) {
        intakeDropContent.innerHTML = '📷 Ota kuva / valitse tiedosto<br><small style="font-size:11px;">Ennen-kuva suositeltava</small>';
        intakeDropContent.style.display = "block";
      }

      // Show feedback alert in modal
      const feedback = document.createElement("div");
      feedback.style.color = "var(--teal)";
      feedback.style.fontSize = "13px";
      feedback.style.fontWeight = "600";
      feedback.style.marginTop = "15px";
      feedback.style.textAlign = "center";
      feedback.id = "intakeFeedback";
      feedback.innerHTML = `✓ Työ tallennettu! Seurantakoodi: ${j.id}. Voit syöttää seuraavan tuotteen.<br>
        <button type="button" class="wide-btn" style="margin-top:8px;max-width:220px;" onclick="printReceipt('${j.id}')">🖨️ Tulosta kuitti</button>`;

      const existingFeedback = document.getElementById("intakeFeedback");
      if (existingFeedback) existingFeedback.remove();

      document.querySelector(".modal-box").appendChild(feedback);
      setTimeout(() => { if(feedback) feedback.remove(); }, 8000);
    } else {
      closeModal();
      openJob(j.id);
      intakeImageBase64 = null;
    }
  } catch (err) {
    console.error("saveJob failed:", err);
    alert("Tallennus epäonnistui: " + err.message + "\n\nOta kuvakaappaus tästä viestistä ja lähetä se eteenpäin.");
  }
}

let currentJobFilter = "all";

// Lets staff select several jobs in the Työt list and change their status
// (e.g. "Valmis" / "Toimitettu") in one tap, instead of opening each job's
// full detail page to update it one at a time.
let bulkMode = false;
let selectedJobIds = new Set();

function toggleBulkMode() {
  bulkMode = !bulkMode;
  if (!bulkMode) selectedJobIds.clear();
  const btn = document.getElementById("bulkModeBtn");
  if (btn) {
    btn.textContent = bulkMode ? "✕ Sulje toplu muokkaus" : "☑ Toplu muokkaus";
    btn.classList.toggle("active", bulkMode);
  }
  updateBulkBar();
  renderJobs();
}

function toggleJobSelect(id, checked) {
  if (checked) selectedJobIds.add(id); else selectedJobIds.delete(id);
  updateBulkBar();
}

function clearJobSelection() {
  selectedJobIds.clear();
  updateBulkBar();
  renderJobs();
}

function updateBulkBar() {
  const bar = document.getElementById("bulkActionBar");
  const count = document.getElementById("bulkCount");
  if (!bar || !count) return;
  bar.style.display = bulkMode && selectedJobIds.size > 0 ? "flex" : "none";
  count.textContent = `${selectedJobIds.size} valittu`;
}

// Applies a status to every selected job at once, without opening each
// job's detail/customer view — same status change setStatus() does per job,
// just batched.
function bulkSetStatus(status) {
  if (selectedJobIds.size === 0) return;
  selectedJobIds.forEach(id => {
    const j = jobs.find(x => x.id === id);
    if (!j) return;
    j.status = status;
    if (status === "done" && !j.delivered_at) {
      j.delivered_at = new Date().toISOString();
      dbUpdateJob(id, { status, delivered_at: j.delivered_at });
    } else {
      dbUpdateJobStatus(id, status);
    }
  });
  saveState();
  selectedJobIds.clear();
  updateBulkBar();
  renderHome();
  renderJobs();
}

function setJobFilter(filter, btn) {
  currentJobFilter = filter;
  document.querySelectorAll("#jobs .chips button").forEach(x => x.classList.remove("active"));
  btn.classList.add("active");
  setJobsFilterNote("");
  renderJobs();
}

function setJobsFilterNote(text) {
  const el = document.getElementById("jobsFilterNote");
  if (el) el.innerHTML = text;
}

// Makes the "Tänään" home page stat cards clickable shortcuts into the
// filtered Työt view they summarize, instead of being static numbers.
const HOME_STAT_NOTES = {
  "needs-action": "⚠️ Toimenpiteitä tarvitaan: myöhässä olevat työt ja odottavat WhatsApp-tilaukset.",
  "active": "🔧 Verstaalla: työn alla olevat (ja myöhässä olevat) työt.",
  "ready": "✅ Valmiit, asiakasta odottavat työt.",
  "whatsapp-waiting": "💬 WhatsApp-tilaukset, jotka odottavat tuotteen saapumista."
};
function goHomeStat(type) {
  currentJobFilter = type;
  const chipIndexByFilter = { all: 0, active: 1, waiting: 2, ready: 3, done: 4 };
  const chipButtons = document.querySelectorAll("#jobs .chips button");
  chipButtons.forEach(b => b.classList.remove("active"));
  const chipIdx = chipIndexByFilter[type];
  if (chipIdx != null && chipButtons[chipIdx]) chipButtons[chipIdx].classList.add("active");
  let note = type === "today"
    ? (isAfterClosing() ? "📦 Huomenna toimitettavat työt." : "📦 Tänään toimitettavat työt.")
    : (HOME_STAT_NOTES[type] || "");
  if (type === "overdue-unclaimed") {
    const list = overdueUnclaimedJobs();
    const sum = list.reduce((s,j) => s + (Number(j.price)||0), 0);
    const timesTotal = list.reduce((s,j) => s + (j.postponed_count||0), 0);
    note = `🔴 Asiakas ei ole noutanut tuotetta sovittuna päivänä — toimituspäivää on siirretty eteenpäin. Yhteensä ${list.length} työtä, arvo ${sum} €, siirretty yhteensä ${timesTotal} kertaa.`;
  }
  setJobsFilterNote(note ? `${note} <a href="#" onclick="setJobFilter('all', document.querySelector('#jobs .chips button')); return false;" style="color:var(--teal);">Näytä kaikki</a>` : "");
  showPage("jobs");
}

function parseFinDate(str){
  if(!str) return null;
  const parts = str.split(".");
  if(parts.length !== 3) return null;
  const d = new Date(+parts[2], +parts[1]-1, +parts[0]);
  return isNaN(d) ? null : d;
}

function finDateToIso(str){
  const d = parseFinDate(str);
  return d ? localISO(d) : "";
}

// Suggests the earliest upcoming date (starting 2 days out, for a minimum
// realistic lead time) that isn't already near the shop's soft 6-jobs/day
// capacity guideline (see calendarDensityClass) — so intake doesn't default
// to stacking every new job onto whatever day is already busiest.
function suggestDeliveryDate(){
  const stats = jobStatsByDate();
  const d = new Date();
  d.setDate(d.getDate() + 2);
  for(let i=0; i<60; i++){
    const dateStr = `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
    const count = stats[dateStr]?.count || 0;
    if(count <= 4) return { iso: localISO(d), fin: dateStr, count };
    d.setDate(d.getDate()+1);
  }
  return null;
}

// Multi-model fallback list shared by the Gemini-backed AI helpers (social
// captions, price estimates, photo recognition) — some models/API versions
// aren't available on every key, so trying a few in order beats hard-coding
// one. gemini-1.5-*, gemini-2.0-flash and the "-latest" aliases have all
// been retired by Google — this list was rebuilt from the actual model
// list Asetukset → "Testaa AI-yhteys" returned for a real key (Sept 2026).
// If AI features go quiet again, that button is the fastest way to see
// what Google currently serves and refresh this list.
const GEMINI_MODEL_TARGETS = [
  { ver: "v1beta", model: "gemini-3.7-flash" },
  { ver: "v1", model: "gemini-3.7-flash" },
  { ver: "v1beta", model: "gemini-3.5-flash" },
  { ver: "v1", model: "gemini-3.5-flash" },
  { ver: "v1beta", model: "gemini-2.5-flash" },
  { ver: "v1", model: "gemini-2.5-flash" },
  { ver: "v1beta", model: "gemini-2.5-pro" },
  { ver: "v1", model: "gemini-2.5-pro" }
];

// Returns { text, error }: text is the model's reply on success; on total
// failure (every model/version tried) text is null and error carries the
// last API error message, so callers can show *why* it failed instead of
// just silently going quiet — a silent failure looks identical to "nothing
// happened" and is impossible to diagnose remotely.
async function callGemini(apiKey, parts){
  let lastError = "Tuntematon virhe";
  for (const t of GEMINI_MODEL_TARGETS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/${t.ver}/models/${t.model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] })
      });
      const data = await res.json();
      if (res.ok && data.candidates && data.candidates[0]) {
        return { text: data.candidates[0].content.parts[0].text.trim(), error: null };
      }
      lastError = data?.error?.message || `HTTP ${res.status}`;
      console.warn(`Gemini model ${t.model} on ${t.ver} failed:`, lastError);
    } catch (err) {
      lastError = err.message || String(err);
      console.warn(`Gemini model ${t.model} on ${t.ver} failed, trying next...`, err);
    }
  }
  return { text: null, error: lastError };
}

// Estimates a price from the shop's own price list (Asetukset → "Hinnasto &
// ohjeet") once both Tuote and Korjaus have some text — only fills the price
// field if it's still untouched (empty or the form's "45" default) so it
// never silently overwrites a price staff already typed themselves.
async function suggestPriceFromAI(){
  const prodEl = document.getElementById("prod"), workEl = document.getElementById("work"), priceEl = document.getElementById("price");
  const hint = document.getElementById("priceHint");
  if(!prodEl || !workEl || !priceEl) return;
  const product = prodEl.value.trim(), work = workEl.value.trim();
  if(!product && !work) return;

  const apiKey = localStorage.getItem("suutari_gemini_key");
  if(!apiKey) return;

  const priceList = localStorage.getItem("suutari_ai_instructions") || "";
  if(hint){ hint.textContent = "🪄 AI arvioi hintaa..."; hint.style.display = "inline"; }

  const prompt = `Olet suutari-ateljeen hinnoitteluavustaja. Ateljeen hinnasto ja ohjeet:
${priceList || "(Ei erillistä hinnastoa annettu — käytä yleistä suomalaista suutari-ateljeen hintatasoa.)"}

Asiakkaan tuote: "${product || "ei määritelty"}"
Pyydetty korjaus: "${work || "ei määritelty"}"

Vastaa AINOASTAAN yhdellä kokonaisluvulla euroina, ei valuuttamerkkiä eikä muuta tekstiä. Esim: 35`;

  const { text, error } = await callGemini(apiKey, [{ text: prompt }]);
  const match = text && text.match(/\d+/);
  if(match){
    const estimate = +match[0];
    if(priceEl.value === "" || priceEl.value === "45") priceEl.value = estimate;
    if(hint){ hint.style.color = "var(--teal)"; hint.textContent = `🪄 AI-arvio: €${estimate} (hinnaston perusteella)`; hint.style.display = "inline"; }
  } else if(hint){
    hint.style.color = "#ef4444";
    hint.textContent = `⚠️ AI-hinta-arvio epäonnistui: ${error || "tuntematon virhe"}`;
    hint.style.display = "inline";
  }
}

// Identifies the product (and guesses a likely repair) from the just-uploaded
// intake photo via Gemini vision — only fills fields the staff hasn't already
// typed into, so a manual entry always wins over the AI guess.
async function recognizeProductFromPhoto(){
  const apiKey = localStorage.getItem("suutari_gemini_key");
  const prodEl = document.getElementById("prod"), workEl = document.getElementById("work");
  const hint = document.getElementById("photoRecognizeHint");
  if(!apiKey || !intakeImageBase64 || !prodEl || !workEl) return;
  if(prodEl.value.trim()) return; // staff already entered a product manually

  const match = intakeImageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if(!match) return;
  const [, mimeType, base64Data] = match;
  const priceList = localStorage.getItem("suutari_ai_instructions") || "";

  if(hint){ hint.textContent = "🪄 AI tunnistaa tuotetta kuvasta..."; hint.style.display = "inline"; }

  const prompt = `Olet suutari-ateljeen avustaja. Katso kuva tuotteesta (esim. kenkä, laukku, vaate). Vastaa AINOASTAAN tässä JSON-muodossa, ei muuta tekstiä eikä koodilohkoa:
{"tuote": "lyhyt suomenkielinen tuotekuvaus, esim. Naisten nahkakengät tai Nahkainen käsilaukku", "korjaus": "todennäköisin tarvittava korjaus näkyvän kulumisen perusteella samoilla termeillä kuin hinnastossa, tai tyhjä merkkijono jos ei selvää tarvetta"}

Ateljeen hinnasto ja yleiset palvelut (käytä samoja termejä jos mahdollista):
${priceList || "(ei hinnastoa annettu)"}`;

  const { text, error } = await callGemini(apiKey, [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }]);
  let parsed = null;
  let parseError = null;
  try {
    parsed = text ? JSON.parse(text.replace(/^```(json)?\s*|```\s*$/g, "")) : null;
  } catch (err) {
    parseError = "vastaus ei ollut odotetussa muodossa";
    console.warn("Photo recognition response wasn't valid JSON:", text);
  }

  if(parsed?.tuote && !prodEl.value.trim()){
    prodEl.value = parsed.tuote;
    if(parsed.korjaus && !workEl.value.trim()) workEl.value = parsed.korjaus;
    if(hint){ hint.style.color = "var(--teal)"; hint.textContent = `🪄 AI tunnisti: ${parsed.tuote}`; hint.style.display = "inline"; }
    suggestPriceFromAI();
  } else if(hint){
    hint.style.color = "#ef4444";
    hint.textContent = `⚠️ Kuvan tunnistus epäonnistui: ${error || parseError || "tuntematon virhe"}`;
    hint.style.display = "inline";
  }
}

// Lets staff evaluate a WhatsApp order from whichever inputs they have —
// the customer's pasted message text, an uploaded product photo, or both —
// doing the same job the shop's trained Claude skill was doing by hand:
// estimate product/repair/price from the shop's own price list and draft a
// Finnish reply, filling the intake fields directly. Neither input is
// required on its own; if both are present they're sent together for a
// more accurate combined read. Overwrites Tuote/Korjaus/Hinta/Muistiinpano
// asiakkaalle outright since this is an explicit "evaluate this" click,
// unlike the passive onblur/photo helpers that only fill blank fields.
async function evaluateWhatsappMessage(){
  const pasteEl = document.getElementById("whatsappMsgPaste");
  const hint = document.getElementById("whatsappMsgHint");
  const pasted = pasteEl?.value.trim() || "";
  const imageMatch = intakeImageBase64?.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);

  if(!pasted && !imageMatch){
    if(hint){ hint.style.color = "#ef4444"; hint.textContent = "⚠️ Liitä viesti tai lisää kuva ensin."; hint.style.display = "inline"; }
    return;
  }

  const apiKey = localStorage.getItem("suutari_gemini_key");
  if(!apiKey){
    if(hint){ hint.style.color = "#ef4444"; hint.textContent = "⚠️ Aseta ensin Gemini-avain (Asetukset)."; hint.style.display = "inline"; }
    return;
  }

  if(hint){ hint.style.color = "var(--teal)"; hint.textContent = "🪄 Arvioidaan..."; hint.style.display = "inline"; }

  const priceList = localStorage.getItem("suutari_ai_instructions") || "";
  const prompt = `Olet suutari-ateljeen WhatsApp-asiakaspalvelun avustaja. Ateljeen hinnasto ja ohjeet:
${priceList || "(Ei erillistä hinnastoa annettu — käytä yleistä suomalaista suutari-ateljeen hintatasoa.)"}

Käytössäsi on asiakkaan WhatsApp-viesti, kuva tuotteesta, tai molemmat — käytä kaikkea mitä on saatavilla. Arvioi tuote, tarvittava korjaus ja hinta-arvio hinnaston perusteella, ja kirjoita asiakkaalle Fince vastaus seuraavilla säännöillä:
- Pidä vastaus lyhyenä ja yksinkertaisena, muutama lause riittää — ei pitkiä selityksiä.
- Mainitse hinta-arvio VAIN jos asiakas kysyi hintaa viestissään. Jos asiakas ei kysynyt hintaa (tai viestiä ei ole), älä mainitse sitä vastauksessa lainkaan.
- Pyydä lisätietoa vain jos tiedot ovat aidosti riittämättömät.
- Aloita lyhyellä ystävällisellä tervehdyksellä (esim. "Hei!") ja lopeta vastaus rivillä "Ystävällisin terveisin, Suutari".
Vastaa AINOASTAAN tässä JSON-muodossa, ei muuta tekstiä eikä koodilohkoa:
{"tuote": "lyhyt suomenkielinen tuotekuvaus, tai tyhjä merkkijono jos ei selviä", "korjaus": "pyydetty/tarvittava korjaus, tai tyhjä merkkijono jos ei selviä", "hinta": kokonaisluku euroina hinnaston perusteella, tai null jos arviointi ei ole mahdollista, "vastaus": "asiakkaalle lähetettävä valmis Fince WhatsApp-vastaus"}

${pasted ? `Asiakkaan viesti:\n"""\n${pasted}\n"""` : "(Asiakkaalta ei ole viestitekstiä — arvioi pelkän kuvan perusteella.)"}`;

  const parts = [{ text: prompt }];
  if(imageMatch) parts.push({ inline_data: { mime_type: imageMatch[1], data: imageMatch[2] } });

  const { text, error } = await callGemini(apiKey, parts);
  let parsed = null;
  let parseError = null;
  try {
    parsed = text ? JSON.parse(text.replace(/^```(json)?\s*|```\s*$/g, "")) : null;
  } catch (err) {
    parseError = "vastaus ei ollut odotetussa muodossa";
    console.warn("WhatsApp evaluation response wasn't valid JSON:", text);
  }

  if(!parsed){
    if(hint){ hint.style.color = "#ef4444"; hint.textContent = `⚠️ Arviointi epäonnistui: ${error || parseError || "tuntematon virhe"}`; hint.style.display = "inline"; }
    return;
  }

  const filled = [];
  if(parsed.tuote){ document.getElementById("prod").value = parsed.tuote; filled.push("tuote"); }
  if(parsed.korjaus){ document.getElementById("work").value = parsed.korjaus; filled.push("korjaus"); }
  if(parsed.hinta != null){ document.getElementById("price").value = parsed.hinta; filled.push("hinta"); }
  if(parsed.vastaus){ document.getElementById("customerNote").value = parsed.vastaus; filled.push("vastaus asiakkaalle"); }

  if(hint){
    if(filled.length){
      hint.style.color = "var(--teal)";
      hint.textContent = `🪄 Täytetty: ${filled.join(", ")}. Tarkista tiedot ja hinta ennen tallennusta ja lähettämistä.`;
    } else {
      hint.style.color = "#ef4444";
      hint.textContent = "⚠️ Tuotetta, hintaa tai vastausta ei löytynyt.";
    }
    hint.style.display = "inline";
  }
}

// One-click copy of the drafted (or manually written) customer reply, so
// staff can paste it straight into WhatsApp instead of selecting/copying
// the textarea text by hand.
async function copyCustomerNote(){
  const noteEl = document.getElementById("customerNote");
  const hint = document.getElementById("copyCustomerNoteHint");
  const text = noteEl?.value.trim();
  if(!text) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    noteEl.select();
    document.execCommand("copy");
  }

  if(hint){
    hint.textContent = "✓ Kopioitu leikepöydälle";
    hint.style.display = "inline";
    setTimeout(() => { hint.style.display = "none"; }, 2500);
  }
}

function updateDeliveredStats(){
  const el = document.getElementById("deliveredStats");
  if(!el) return;
  const now = new Date();
  const startOfWeek = new Date(now);
  const dayNum = startOfWeek.getDay() || 7;
  startOfWeek.setDate(now.getDate() - dayNum + 1);
  startOfWeek.setHours(0,0,0,0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const doneJobs = jobs.filter(j => j.status === "done");
  const deliveredDate = j => j.delivered_at ? new Date(j.delivered_at) : parseFinDate(j.date);
  const weekCount = doneJobs.filter(j => { const d = deliveredDate(j); return d && d >= startOfWeek; }).length;
  const monthCount = doneJobs.filter(j => { const d = deliveredDate(j); return d && d >= startOfMonth; }).length;

  el.textContent = `✔ Toimitettu tällä viikolla: ${weekCount} · Tässä kuussa: ${monthCount} · Yhteensä: ${doneJobs.length}`;
}

function renderJobs(){
  let q=(document.getElementById("search")?.value||"").toLowerCase();
  let a=jobs.filter(j=>(j.id+j.name+j.product+j.work).toLowerCase().includes(q));

  const checkboxCell = j => bulkMode ? `<div onclick="event.stopPropagation()"><input type="checkbox" class="job-row-check" ${selectedJobIds.has(j.id)?"checked":""} onchange="toggleJobSelect('${j.id}', this.checked)"></div>` : "";
  const tableHead = `<div class="table-head">${bulkMode?"<div></div>":""}<div></div><div>Asiakas</div><div>Tuote / Työ</div><div>Toimitus</div><div>Hinta</div><div>Tila</div></div>`;
  const rowHtml = j => `<div class="table-row" onclick="openJob('${j.id}')">${checkboxCell(j)}<div style="position:relative;"><img class="row-thumb" src="${j.img||bag}" title="${j.id}">${j.source==="whatsapp"?'<span class="row-thumb-badge">💬</span>':""}</div><div><b>${j.name}</b><small>${j.loc}</small></div><div><b>${j.product}</b><small>${j.work}</small></div><div>${j.date}</div><div><b>${j.price} €</b></div><div onclick="event.stopPropagation()"><span class="pill ${statusPillClass(j.status)}" onclick="openStatus('${j.id}')" title="Päivitä tila">${statusLabel[j.status]||j.status}</span></div></div>`;
  const empty = `<p style="text-align:center;color:var(--text-muted);padding:30px 0;">Ei töitä.</p>`;
  document.getElementById("jobsTable").classList.toggle("bulk-mode", bulkMode);
  // Delivery dates in the past or today surface first — those are the ones
  // staff need to act on; further-out jobs can wait further down the list.
  const byDeliveryUrgency = (x,y) => {
    const dx = parseFinDate(x.date), dy = parseFinDate(y.date);
    if(!dx && !dy) return 0;
    if(!dx) return 1;
    if(!dy) return -1;
    return dx - dy;
  };

  updateDeliveredStats();

  if(currentJobFilter === "done"){
    const done = a.filter(j => j.status === "done")
      .sort((x,y)=> new Date(y.delivered_at||0) - new Date(x.delivered_at||0));
    document.getElementById("jobsTable").innerHTML = done.length ? (tableHead + done.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "active"){
    a = a.filter(j => j.status === "active" || j.status === "late").sort(byDeliveryUrgency);
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "waiting"){
    a = a.filter(j => j.status === "waiting" || j.status === "arrived").sort(byDeliveryUrgency);
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "ready"){
    a = a.filter(j => j.status === "ready").sort(byDeliveryUrgency);
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "needs-action"){
    a = a.filter(j => j.status === "late" || (j.source === "whatsapp" && j.status === "waiting")).sort(byDeliveryUrgency);
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "today"){
    a = a.filter(j => j.date === referenceDateStr());
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "whatsapp-waiting"){
    a = a.filter(j => j.source === "whatsapp" && j.status === "waiting").sort(byDeliveryUrgency);
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }
  if(currentJobFilter === "overdue-unclaimed"){
    const overdueIds = new Set(overdueUnclaimedJobs().map(j => j.id));
    a = a.filter(j => overdueIds.has(j.id)).sort(byDeliveryUrgency);
    document.getElementById("jobsTable").innerHTML = a.length ? (tableHead + a.map(rowHtml).join("")) : empty;
    return;
  }

  // "Kaikki" — grouped by stage, delivered jobs excluded from this default view
  const groups = [
    ["⏳ Odottaa", a.filter(j => j.status === "waiting" || j.status === "arrived").sort(byDeliveryUrgency)],
    ["🔧 Työn alla", a.filter(j => j.status === "active" || j.status === "late").sort(byDeliveryUrgency)],
    ["✅ Valmis", a.filter(j => j.status === "ready").sort(byDeliveryUrgency)]
  ].filter(([,list]) => list.length);

  document.getElementById("jobsTable").innerHTML = groups.length ? groups.map(([title,list])=>
    `<div style="margin:16px 0 8px;font-size:13px;font-weight:700;color:var(--primary);">${title} <span style="color:var(--text-muted);font-weight:600;">(${list.length})</span></div>${tableHead}${list.map(rowHtml).join("")}`
  ).join("") : empty;
}

async function uploadDetailAfterImage(e, id) {
  const f = e.target.files?.[0];
  if(!f) return;

  // Show the local preview immediately, then upload to Storage in the
  // background — a base64 preview here is instant and never touches the DB.
  const preview = document.getElementById("detailAfterPreview");
  try {
    const displayFile = await toDisplayableImage(f);
    preview.src = URL.createObjectURL(displayFile);
    preview.style.opacity = 1;

    const url = await uploadJobImage(displayFile, id, "after");
    const j = jobs.find(x => x.id === id);
    if(j) {
      j.img_after = url;
      saveState();
      dbUpdateJobAfterImage(id, url);
    }
  } catch (err) {
    console.error("After-photo upload failed:", err);
    alert("Kuvan lataus epäonnistui. Yritä uudelleen.");
  }
}

function openJob(id){
  const j=jobs.find(x=>x.id===id);
  document.getElementById("jobNo").textContent=j.id;
  
  const trackUrl = `${window.location.origin}/track.html?code=${encodeURIComponent(j.id)}`;
  const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(trackUrl)}`;

  document.getElementById("jobDetail").innerHTML=`<div class="detail-grid">
    <div class="detail">
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:15px;">
        <div style="position:relative;">
          <img src="${j.img}" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #e6edef;">
          <span style="position:absolute;bottom:4px;left:4px;background:rgba(15,45,74,0.85);color:white;font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700">ENNEN</span>
        </div>
        <div style="position:relative;cursor:pointer;" onclick="document.getElementById('detailAfterFile').click()">
          <img src="${j.img_after || bag}" id="detailAfterPreview" style="width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #e6edef;opacity:${j.img_after ? 1 : 0.4};">
          <span style="position:absolute;bottom:4px;left:4px;background:rgba(16,185,129,0.85);color:white;font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700">JÄLKEEN</span>
          <input type="file" id="detailAfterFile" accept="image/*" style="display:none" onchange="uploadDetailAfterImage(event, '${j.id}')">
        </div>
      </div>
      <div>
        <h2 style="margin:0 0 5px;font-size:18px">${j.name}</h2>
        <p style="font-size:12px;color:#7d8990;margin:0 0 5px;">${j.product}</p>
        <span class="pill teal">${j.loc}</span>${j.source==="whatsapp"?' <span class="pill" style="background:#e8f7f7;color:#138c8c;">💬 WhatsApp</span>':""}
      </div>
      <hr style="border:0;border-top:1px solid #e6edef;margin:18px 0">
      <b style="font-size:11px">Työ</b><p style="font-size:13px">${j.work} · <strong>${j.price} €</strong></p>
      <b style="font-size:11px">Toimitus</b><p style="font-size:13px">${j.date}</p>
      <b style="font-size:11px">Sisäinen huomautus</b><p style="font-size:12px;color:#71818a">${j.note}</p>
      <hr style="border:0;border-top:1px solid #e6edef;margin:18px 0">
      <div style="display:flex;gap:15px;align-items:center;">
        <img src="${qrLink}" style="width:75px;height:75px;border-radius:8px;border:1px solid #e6edef;">
        <div>
          <b style="font-size:11px">Asiakkaan seuranta (QR)</b>
          <p style="font-size:11px;color:#71818a;margin:4px 0 0">Skannaa QR tai avaa linkki: <a href="track.html?code=${j.id}" target="_blank">${j.id}</a></p>
        </div>
      </div>
    </div>
    <div class="detail"><b style="font-size:11px">Työnkulku</b><div class="timeline">${jobTimelineHtml(j)}</div>
      <button class="save" style="width:100%;border:0;border-radius:9px;padding:12px;margin-top:8px;cursor:pointer" onclick="openStatus('${j.id}')">PÄIVITÄ TILA</button>
      <button class="save" style="width:100%;border:0;border-radius:9px;padding:12px;margin-top:8px;cursor:pointer;background:var(--primary-light);color:var(--primary);" onclick="openEditJob('${j.id}')">✏️ MUOKKAA TIETOJA</button>
      <button class="save" style="width:100%;border:0;border-radius:9px;padding:12px;margin-top:8px;cursor:pointer;background:var(--teal-light);color:var(--teal);" onclick="printReceipt('${j.id}')">🖨️ TULOSTA KUITTI</button>
      <button class="save" style="width:100%;border:0;border-radius:9px;padding:12px;margin-top:8px;cursor:pointer;background:var(--teal-light);color:var(--teal);" onclick="addAnotherProductForCustomer('${j.id}')">➕ LISÄÄ UUSI TUOTE TÄLLE ASIAKKAALLE</button>
      <button class="delete-btn" style="width:100%;border:0;border-radius:9px;padding:12px;margin-top:8px;cursor:pointer;background:#ef4444;color:white;font-weight:600;" onclick="deleteJob('${j.id}')">🗑️ POISTA TYÖ</button>
    </div>
  </div>`;
  showPage("job");
}

// Fills the hidden #printReceipt container with a formatted 80mm receipt
// and triggers the browser's native print dialog, which lists whatever
// printer is already installed on the device (tablet or computer) — no
// printer-specific code needed here.
function buildReceiptHtml(j){
  const trackUrl = `${window.location.origin}/track.html?code=${encodeURIComponent(j.id)}`;
  const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(trackUrl)}`;
  const now = new Date();
  const stamp = `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}.${now.getFullYear()} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  return `
    <div class="r-brand">
      <div class="r-mark">TEHTAANKATU SUUTARI PALVELU</div>
      <div class="r-addr">Tehtaankatu 21 lh5, 00150 Helsinki · 041 3177327</div>
    </div>
    <div class="r-rule"></div>
    <div class="r-title">VASTAANOTTOKUITTI</div>
    <div class="r-rule"></div>
    <div class="r-kv"><span>Seurantakoodi</span><b>${j.id}</b></div>
    <div class="r-kv"><span>Vastaanotettu</span><span>${stamp}</span></div>
    <div class="r-block-title">ASIAKAS</div>
    <div class="r-name">${j.name || "-"}</div>
    <div>${j.phone || ""}</div>
    <div class="r-block-title">TUOTE</div>
    <div class="r-line-item"><span class="desc">${j.product || ""}<br>${j.work || ""}</span><span class="price">${j.price || 0} €</span></div>
    <div class="r-kv" style="margin-top:8px"><span>Arvioitu valmis</span><b>${j.date || ""}</b></div>
    ${j.customer_note ? `<div class="r-note">${j.customer_note}</div>` : ""}
    <div class="r-rule"></div>
    <div class="r-qr-row">
      <img class="r-qr" src="${qrLink}" width="70" height="70">
      <div class="r-qr-text">Seuraa tilausta:<br><code>${trackUrl.replace(/^https?:\/\//,"")}</code></div>
    </div>
    <div class="r-thanks"><span class="big">Kiitos, kun toit työn meille!</span>Tehtaankatu Suutari Palvelu</div>
  `;
}

function printReceipt(id){
  const j = jobs.find(x=>x.id===id);
  if(!j) return;
  document.getElementById("printReceipt").innerHTML = buildReceiptHtml(j);
  window.print();
}

function openEditJob(id){
  const j=jobs.find(x=>x.id===id);
  if(!j) return;
  const isoDate = j.date ? j.date.split(".").reverse().join("-") : "";
  document.getElementById("modalBody").innerHTML=`<h2>✏️ Muokkaa tietoja · ${j.id}</h2>
<div class="form">
  <div class="field"><label>Asiakas</label><input id="editName" value="${j.name||""}" placeholder="Nimi"></div>
  <div class="field"><label>Puhelin</label><input id="editPhone" value="${j.phone||""}" placeholder="040..."></div>
  <div class="field"><label>Tuote</label><input id="editProd" list="tuoteOptions" value="${j.product||""}"></div>
  <div class="field"><label>Korjaus</label><input id="editWork" list="korjausOptions" value="${j.work||""}"></div>
  <div class="field"><label>Hinta (€)</label><input id="editPrice" type="number" value="${j.price||0}"></div>
  <div class="field"><label>Toimitus</label><input id="editDate" type="date" value="${isoDate}"></div>
  <div class="field full"><label>Hylly / sijainti</label><input id="editLoc" value="${j.loc||""}"></div>
  <div class="field full"><label>Sisäinen huomautus</label><textarea id="editNote">${j.note||""}</textarea></div>
  <div class="field full"><label>Muistiinpano asiakkaalle <small style="font-weight:400;color:var(--text-muted);">(näkyy asiakkaan seurantasivulla)</small></label><textarea id="editCustomerNote">${j.customer_note||""}</textarea></div>
</div>
<div class="modal-actions">
  <button class="cancel" onclick="closeModal()">Peruuta</button>
  <button class="save" onclick="saveEditJob('${j.id}')">TALLENNA MUUTOKSET</button>
</div>`;
  document.getElementById("modal").classList.remove("hidden");
}

function saveEditJob(id){
  const j=jobs.find(x=>x.id===id);
  if(!j) return;
  j.name = document.getElementById("editName").value.trim() || j.name;
  j.phone = document.getElementById("editPhone").value.trim();
  j.product = document.getElementById("editProd").value.trim() || j.product;
  j.work = document.getElementById("editWork").value.trim() || j.work;
  j.price = +document.getElementById("editPrice").value || 0;
  const d = document.getElementById("editDate").value;
  if(d) j.date = d.split("-").reverse().join(".");
  j.loc = document.getElementById("editLoc").value.trim() || j.loc;
  j.note = document.getElementById("editNote").value;
  j.customer_note = document.getElementById("editCustomerNote").value;

  saveState();
  dbUpdateJob(id, {name:j.name, phone:j.phone, product:j.product, work:j.work, price:j.price, date:j.date, loc:j.loc, note:j.note, customer_note:j.customer_note});
  closeModal();
  openJob(id);
  renderHome();
}

function addAnotherProductForCustomer(id){
  const j=jobs.find(x=>x.id===id);
  if(!j) return;
  openIntake({name:j.name, phone:j.phone});
}

const statusIcon={waiting:"⏳",arrived:"📦",active:"🔧",ready:"✅",done:"✔"};

function openStatus(id){
  const j=jobs.find(x=>x.id===id);
  const options = jobStatusSteps(j);
  document.getElementById("modalBody").innerHTML=`<h2>Muuta tilaa · ${j.id}</h2><p style="font-size:12px;color:#78858d">${j.name} · ${j.product}${j.source==="whatsapp"?" · 💬 WhatsApp":""}</p>
<div style="display:grid;gap:7px;margin-top:15px" id="statusOptions">
  ${options.map(x=>{
    const isCurrent = j.status===x[0];
    return `<button class="wide-btn status-option${isCurrent?" current":""}" id="statusBtn-${x[0]}" onclick="selectStatus('${j.id}','${x[0]}',this)">${isCurrent?"✓":statusIcon[x[0]]||""} ${x[1]}${isCurrent?" (nykyinen)":""}</button>`;
  }).join("")}
  <hr style="border:0;border-top:1px solid var(--border);margin:10px 0">
  <button class="wide-btn" style="background:#ef4444;color:white;font-weight:600;" onclick="closeModal();deleteJob('${j.id}');">🗑️ POISTA TÄMÄ TYÖ</button>
</div>`;
  document.getElementById("modal").classList.remove("hidden");
}

// Gives instant visual confirmation (button turns green + checkmark) before
// the modal closes, so it's never unclear whether the tap registered.
function selectStatus(id,s,btn){
  document.querySelectorAll("#statusOptions .status-option").forEach(b=>{ b.disabled=true; });
  if(btn){
    btn.classList.add("confirmed");
    btn.textContent = "✓ " + btn.textContent.replace(/^[^\s]+\s*/,"").replace(/\s*\(nykyinen\)$/,"");
  }
  setTimeout(()=>setStatus(id,s), 350);
}

function setStatus(id,s){
  const j = jobs.find(job=>job.id===id);
  j.status=s;
  if (s === "done" && !j.delivered_at) {
    j.delivered_at = new Date().toISOString();
    saveState();
    dbUpdateJob(id, {status: s, delivered_at: j.delivered_at});
  } else {
    saveState();
    dbUpdateJobStatus(id, s);
  }
  closeModal();
  // Only jump into the job detail page if that's where the change was made
  // from (the "PÄIVITÄ TILA" button there) — a quick status change from the
  // Työt/Tänään lists should update those lists in place, not pull the user
  // into the job page.
  if(document.querySelector(".page.active")?.id === "job"){
    openJob(id);
  }
  renderHome();
  renderJobs();

  if (s === "ready" || s === "waiting") {
    setTimeout(() => {
      openNotificationModal(id, s);
    }, 300);
  }
}

function openNotificationModal(jobId, status) {
  const j = jobs.find(x => x.id === jobId);
  if(!j) return;
  
  const phone = j.phone || "0400000000"; 
  const name = j.name || "Asiakas";
  const product = j.product || "tuote";
  const work = j.work || "korjaustyö";
  
  const trackUrl = `${window.location.origin}/track.html?code=${encodeURIComponent(j.id)}`;
  
  let msg = "";
  if (status === "ready") {
    msg = `Hei ${name}! Tuotteesi ${product} (${work}) on nyt valmis ja noudettavissa liikkeestämme. Tervetuloa! Seuraa tilauksen tilaa täältä: ${trackUrl}`;
  } else if (status === "waiting") {
    msg = `Hei ${name}! Tuotteesi ${product} (${work}) odottaa tällä hetkellä tarvittavia materiaaleja. Voit seurata tilaa täältä: ${trackUrl}`;
  }
  
  const encodedMsg = encodeURIComponent(msg);
  const waLink = `https://wa.me/${phone.replace(/[^0-9+]/g, "")}?text=${encodedMsg}`;
  const smsLink = `sms:${phone.replace(/[^0-9+]/g, "")}?&body=${encodedMsg}`;
  
  document.getElementById("modalBody").innerHTML = `
    <h2 style="margin-bottom:5px">💬 Lähetä asiakasviesti</h2>
    <p style="font-size:12px;color:#78858d;margin-bottom:15px">Lähetä tilapäivitys asiakkaalle ilman lisäkuluja.</p>
    
    <div class="card" style="margin-bottom:15px;background:#f5f8f9;padding:12px;border-radius:8px">
      <b style="font-size:11px;color:#60747d">Viestiluonnos (Suomi)</b>
      <p style="font-size:13px;line-height:1.5;margin:8px 0 0" id="notifyMsgText">${msg}</p>
    </div>
    
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px">
      <a href="${waLink}" target="_blank" class="wide-btn" style="background:#25d366;color:white;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;font-weight:600;padding:12px;border-radius:9px;border:0;">
        💬 WhatsApp
      </a>
      <a href="${smsLink}" class="wide-btn" style="background:#007aff;color:white;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;font-weight:600;padding:12px;border-radius:9px;border:0;">
        ✉️ SMS-viesti
      </a>
    </div>
    <button class="wide-btn" onclick="closeModal()" style="margin-top:12px;width:100%">Sulje</button>
  `;
  document.getElementById("modal").classList.remove("hidden");
}

const monthNamesFi=["Tammikuu","Helmikuu","Maaliskuu","Huhtikuu","Toukokuu","Kesäkuu","Heinäkuu","Elokuu","Syyskuu","Lokakuu","Marraskuu","Joulukuu"];
const dayNamesFi=["Sunnuntai","Maanantai","Tiistai","Keskiviikko","Torstai","Perjantai","Lauantai"];

// The topbar date and home hero eyebrow used to be hard-coded in index.html
// and never actually updated — always showed the day the template was last
// authored, regardless of the real date.
function updateHeaderDate(){
  const d = new Date();
  const dateStr = todayDateStr();
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val;};
  set("topbarDate", dateStr);
  set("homeEyebrowDate", `${dayNamesFi[d.getDay()]} · ${dateStr}`);
}
let calendarViewYear, calendarViewMonth;
(function initCalendarView(){
  const now = new Date();
  calendarViewYear = now.getFullYear();
  calendarViewMonth = now.getMonth();
})();

function changeCalendarMonth(delta){
  calendarViewMonth += delta;
  if(calendarViewMonth < 0){ calendarViewMonth = 11; calendarViewYear--; }
  if(calendarViewMonth > 11){ calendarViewMonth = 0; calendarViewYear++; }
  renderCalendar();
}

// Soft visual guide, not an enforced cap — 6 jobs/day is just the reference
// point staff asked to see at a glance so a busy day is still pickable.
function calendarDensityClass(count){
  if(count<=0) return "";
  if(count<=2) return "cal-low";
  if(count<=4) return "cal-mid";
  if(count<=6) return "cal-high";
  return "cal-over";
}

function jobStatsByDate(){
  const stats = {};
  jobs.forEach(j=>{
    if(!j.date) return;
    if(!stats[j.date]) stats[j.date] = { count: 0, amount: 0 };
    stats[j.date].count += 1;
    stats[j.date].amount += Number(j.price) || 0;
  });
  return stats;
}

function renderCalendar(){
  const g = document.getElementById("calGrid");
  const titleEl = document.getElementById("calTitle");
  if(titleEl) titleEl.textContent = `${monthNamesFi[calendarViewMonth]} ${calendarViewYear}`;

  const firstOfMonth = new Date(calendarViewYear, calendarViewMonth, 1);
  let leadingBlanks = firstOfMonth.getDay() - 1; // week starts on Monday
  if(leadingBlanks < 0) leadingBlanks = 6;
  const daysInMonth = new Date(calendarViewYear, calendarViewMonth+1, 0).getDate();
  const stats = jobStatsByDate();
  const now = new Date();
  const todayStr = `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}.${now.getFullYear()}`;

  let html = "", monthCount = 0, monthAmount = 0;
  for(let i=0;i<leadingBlanks;i++) html += '<div class="day empty"></div>';
  for(let d=1; d<=daysInMonth; d++){
    const dateStr = `${String(d).padStart(2,"0")}.${String(calendarViewMonth+1).padStart(2,"0")}.${calendarViewYear}`;
    const s = stats[dateStr] || { count: 0, amount: 0 };
    monthCount += s.count;
    monthAmount += s.amount;
    const isToday = dateStr === todayStr;
    html += `<div class="day ${isToday?"today":""} ${calendarDensityClass(s.count)}" onclick="openCalendarDay('${dateStr}')"><strong>${d}</strong>${s.count?`<div class="cal-info"><span class="cal-count">${s.count}</span><span class="cal-amount">€${s.amount}</span></div>`:""}</div>`;
  }
  g.innerHTML = html;

  const summaryEl = document.getElementById("calSummary");
  if(summaryEl) summaryEl.innerHTML = `
    <div class="cal-summary-item"><span>Töitä tässä kuussa</span><strong>${monthCount}</strong></div>
    <div class="cal-summary-item"><span>Kuukauden arvo</span><strong>€${monthAmount}</strong></div>`;
}

function openCalendarDay(dateStr){
  const dayJobs = jobs.filter(j=>j.date===dateStr);
  const count = dayJobs.length;
  const capacityNote = count>6
    ? `⚠️ ${count} työtä — yli suositellun 6 työn rajan.`
    : count===6
      ? "🔶 6 työtä — suositeltu maksimi täynnä."
      : `${6-count} paikkaa vapaana suositeltuun 6 työhön asti.`;
  document.getElementById("modalBody").innerHTML = `<h2>📅 ${dateStr}</h2>
<p style="font-size:12px;color:#78858d">${count} työtä tälle päivälle · ${capacityNote}</p>
<div style="display:grid;gap:8px;margin-top:15px;max-height:340px;overflow-y:auto;">
  ${dayJobs.map(j=>`<div class="wide-btn" style="text-align:left;cursor:pointer;" onclick="closeModal();openJob('${j.id}')">
    <b>${j.id} · ${j.name}</b><br><small>${j.product} · ${j.work} · <span class="pill ${statusPillClass(j.status)}" style="margin-left:4px;">${statusLabel[j.status]||j.status}</span></small>
  </div>`).join("") || '<p style="color:var(--text-muted);font-size:13px;">Ei töitä tälle päivälle. Voit vapaasti antaa tämän päivän asiakkaalle.</p>'}
</div>
<div class="modal-actions" style="margin-top:15px;">
  <button class="cancel" onclick="closeModal()">Sulje</button>
</div>`;
  document.getElementById("modal").classList.remove("hidden");
}

let customerListCache = [];
function renderCustomers(){
  const customerMap = {};

  jobs.forEach(j => {
    const name = (j.name || "Uusi asiakas").trim();
    const phone = (j.phone || "").trim();
    const key = name.toLowerCase() + "|" + phone;
    const created = jobCreatedDateStr(j);

    if (!customerMap[key]) {
      customerMap[key] = {
        name: name,
        phone: phone,
        visits: 0,
        totalSpent: 0,
        lastVisit: "",
        jobs: []
      };
    }

    customerMap[key].visits += 1;
    customerMap[key].totalSpent += Number(j.price) || 0;
    if(created > customerMap[key].lastVisit) customerMap[key].lastVisit = created;
    customerMap[key].jobs.push(j);
  });

  let list = Object.values(customerMap);

  const totalCustomers = list.length;
  const totalRevenue = list.reduce((a,c)=>a+c.totalSpent,0);
  document.getElementById("custTotalCount").textContent = totalCustomers;
  document.getElementById("custTotalRevenue").textContent = "€"+totalRevenue;
  document.getElementById("custAvgSpend").textContent = "€"+(totalCustomers ? Math.round(totalRevenue/totalCustomers) : 0);

  const search = (document.getElementById("customerSearch")?.value || "").trim().toLowerCase();
  if(search){
    list = list.filter(c => c.name.toLowerCase().includes(search) || c.phone.toLowerCase().includes(search));
  }
  const noteEl = document.getElementById("customersFilterNote");
  if(noteEl) noteEl.textContent = search ? `${list.length} / ${totalCustomers} asiakasta haulla "${search}"` : "";

  const sort = document.getElementById("customerSort")?.value || "spent";
  list.sort((a,b) => {
    if(sort==="visits") return b.visits - a.visits;
    if(sort==="recent") return (b.lastVisit||"").localeCompare(a.lastVisit||"");
    if(sort==="name") return a.name.localeCompare(b.name, "fi");
    return b.totalSpent - a.totalSpent;
  });

  customerListCache = list;

  document.getElementById("customersGrid").innerHTML = customerListCache.map((c, idx) => {
    const initial = c.name ? c.name.charAt(0).toUpperCase() : "?";
    return `
      <div class="customer" onclick="openCustomerHistory(${idx})" style="cursor:pointer;">
        <div class="person">
          <div class="person-icon" style="display:flex;align-items:center;justify-content:center;font-weight:bold;background:var(--primary-light);color:var(--primary);">${initial}</div>
          <div>
            <h3>${c.name}</h3>
            <p>${c.phone || "Ei puhelinnumeroa"}</p>
          </div>
        </div>
        <p>${c.visits} käyntiä ${c.lastVisit ? `· viimeksi ${isoToFin(c.lastVisit)}` : ""}</p>
        <div class="money">${c.totalSpent} €</div>
        <p>Yhteensä</p>
      </div>
    `;
  }).join("") || '<p style="color:var(--text-muted);font-size:13px;padding:20px 0;">Ei hakuehtoja vastaavia asiakkaita.</p>';
}

function openCustomerHistory(idx){
  const c = customerListCache[idx];
  if(!c) return;
  const sortedJobs = [...c.jobs].sort((a,b)=> (b.created_at||"").localeCompare(a.created_at||""));
  document.getElementById("modalBody").innerHTML = `<h2>${c.name}</h2>
<p style="font-size:12px;color:#78858d">${c.phone||"Ei puhelinnumeroa"} · ${c.visits} käyntiä · ${c.totalSpent} € yhteensä</p>
<div style="display:grid;gap:8px;margin-top:15px;max-height:360px;overflow-y:auto;">
  ${sortedJobs.map(j=>`<div class="wide-btn" style="text-align:left;cursor:pointer;" onclick="closeModal();openJob('${j.id}')">
    <b>${j.id} · ${j.product}</b><br><small>${j.work} · ${j.date} · <span class="pill ${statusPillClass(j.status)}" style="margin-left:4px;">${statusLabel[j.status]||j.status}</span> · ${j.price} €</small>
  </div>`).join("")}
</div>
<div class="modal-actions" style="margin-top:15px;">
  <button class="cancel" onclick="closeModal()">Sulje</button>
</div>`;
  document.getElementById("modal").classList.remove("hidden");
}

function closeModal(){document.getElementById("modal").classList.add("hidden")}
document.getElementById("modal").onclick=e=>{if(e.target.id==="modal")closeModal()}

// Initialize Data and UI (gated behind a real Supabase Auth session — see checkAuth())
let currentUser = null;
checkAuth();

// Catches the closing-time (18:00) threshold for sessions left open across
// it, without needing a reload — see rolloverOverdueDates().
setInterval(rolloverOverdueDates, 15 * 60 * 1000);

function showLoginScreen(errorMsg) {
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("loginInfo").style.display = "none";
  const errEl = document.getElementById("loginError");
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.style.display = "block";
  } else {
    errEl.style.display = "none";
  }
}

function hideLoginScreen() {
  document.getElementById("loginScreen").style.display = "none";
}

function showRecoveryScreen() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("recoveryScreen").style.display = "flex";
}

function hideRecoveryScreen() {
  document.getElementById("recoveryScreen").style.display = "none";
}

async function checkAuth() {
  if (!initSupabase()) {
    // Supabase SDK not loaded (offline?) — nothing to authenticate against.
    showLoginScreen("Ei yhteyttä tietokantaan. Tarkista verkkoyhteys.");
    return;
  }

  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      jobs = [];
      showLoginScreen();
    }
    if (event === "PASSWORD_RECOVERY") {
      // User clicked the reset-password link from their email.
      showRecoveryScreen();
    }
  });

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    currentUser = session.user;
    hideLoginScreen();
    await initData();
    rolloverOverdueDates();
    renderHome();
  } else {
    showLoginScreen();
  }
}

async function login() {
  const email = document.getElementById("loginUser").value.trim();
  const pass = document.getElementById("loginPass").value;
  const btn = document.getElementById("loginBtn");
  if (!email || !pass) {
    showLoginScreen("Anna sähköposti ja salasana.");
    return;
  }
  if (!supabaseClient) initSupabase();

  btn.disabled = true;
  btn.textContent = "Kirjaudutaan...";
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false;
  btn.textContent = "Kirjaudu";

  if (error) {
    showLoginScreen("Virheellinen sähköposti tai salasana.");
    return;
  }

  currentUser = data.user;
  document.getElementById("loginUser").value = "";
  document.getElementById("loginPass").value = "";
  hideLoginScreen();
  await initData();
  rolloverOverdueDates();
  renderHome();
}

async function logout() {
  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch(err) {
      console.error(err);
    }
  }
  currentUser = null;
  jobs = [];
  showLoginScreen();
}

async function sendPasswordReset() {
  const email = document.getElementById("loginUser").value.trim();
  const infoEl = document.getElementById("loginInfo");
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";

  if (!email) {
    errEl.textContent = "Kirjoita ensin sähköpostiosoitteesi yllä olevaan kenttään.";
    errEl.style.display = "block";
    return;
  }
  if (!supabaseClient) initSupabase();

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname
  });

  // Always show the same message, whether or not the address exists,
  // so this can't be used to check which emails are registered.
  infoEl.textContent = "Jos tili on olemassa, salasanan palautuslinkki on lähetetty sähköpostiisi.";
  infoEl.style.display = "block";
  if (error) console.error("Password reset request failed:", error.message);
}

async function submitNewPassword() {
  const pass = document.getElementById("recoveryPass").value;
  const btn = document.getElementById("recoveryBtn");
  const errEl = document.getElementById("recoveryError");
  errEl.style.display = "none";

  if (!pass || pass.length < 6) {
    errEl.textContent = "Salasanan tulee olla vähintään 6 merkkiä.";
    errEl.style.display = "block";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Tallennetaan...";
  const { error } = await supabaseClient.auth.updateUser({ password: pass });
  btn.disabled = false;
  btn.textContent = "Tallenna salasana";

  if (error) {
    errEl.textContent = "Salasanan tallennus epäonnistui: " + error.message;
    errEl.style.display = "block";
    return;
  }

  document.getElementById("recoveryPass").value = "";
  hideRecoveryScreen();
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  await initData();
  rolloverOverdueDates();
  renderHome();
}

async function changePassword() {
  const pass = document.getElementById("newPassword").value;
  const statusEl = document.getElementById("authSettingsStatus");
  statusEl.style.display = "block";
  if (!pass || pass.length < 6) {
    statusEl.textContent = "Salasanan tulee olla vähintään 6 merkkiä.";
    statusEl.style.color = "var(--red)";
    return;
  }
  const { error } = await supabaseClient.auth.updateUser({ password: pass });
  if (error) {
    statusEl.textContent = "Salasanan vaihto epäonnistui: " + error.message;
    statusEl.style.color = "var(--red)";
    return;
  }
  document.getElementById("newPassword").value = "";
  statusEl.textContent = "Salasana vaihdettu onnistuneesti!";
  statusEl.style.color = "var(--teal)";
}

const SOURCE_META={store:{code:"S",label:"Myymälä",icon:"🏪"},whatsapp:{code:"W",label:"WhatsApp",icon:"💬"}};

function jobCreatedDateStr(j){
  // created_at comes back from Supabase as an ISO timestamp; fall back to
  // the delivery date for jobs that haven't synced yet.
  if(j.created_at) return String(j.created_at).slice(0,10);
  const d = parseFinDate(j.date);
  return d ? d.toISOString().slice(0,10) : "";
}

// SVG path for a bar with rounded top corners and a square baseline —
// "4px rounded data-end, square at the baseline" per the mark spec.
function roundedTopBarPath(x, y, w, h, r){
  if(h <= 0) return "";
  r = Math.min(r, w/2, h);
  return `M${x},${y+h} L${x},${y+r} Q${x},${y} ${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h} Z`;
}

// Motivational "how many jobs came in, day by day" chart on the home page —
// counts jobs by intake date (jobCreatedDateStr), not delivery date.
function buildIntakeChartData(days){
  const out = [];
  const today = new Date();
  today.setHours(0,0,0,0);
  for(let i = days - 1; i >= 0; i--){
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = localISO(d);
    const dayJobs = jobs.filter(j => jobCreatedDateStr(j) === iso);
    const sum = dayJobs.reduce((s,j) => s + (Number(j.price) || 0), 0);
    out.push({ iso, date: d, count: dayJobs.length, sum });
  }
  return out;
}

function renderIntakeChart(){
  const el = document.getElementById("intakeChart");
  const totalEl = document.getElementById("intakeChartTotal");
  if(!el) return;

  const days = 14;
  const data = buildIntakeChartData(days);
  const totalCount = data.reduce((s,d) => s + d.count, 0);
  const totalSum = data.reduce((s,d) => s + d.sum, 0);
  if(totalEl) totalEl.textContent = `14 pv: ${totalCount} työtä · ${totalSum} €`;

  const max = Math.max(1, ...data.map(d => d.count));
  const W = 420, H = 132, padTop = 22, padBottom = 20;
  const gap = 4;
  const barW = Math.min(24, (W - gap * (data.length - 1)) / data.length);
  const usableW = barW * data.length + gap * (data.length - 1);
  const startX = (W - usableW) / 2;
  const baseline = H - padBottom;
  const todayIso = localISO(new Date());

  const bars = data.map((d,i) => {
    const x = startX + i * (barW + gap);
    const h = d.count ? Math.max(4, (d.count / max) * (baseline - padTop)) : 0;
    const y = baseline - h;
    const isToday = d.iso === todayIso;
    const fill = isToday ? "#138c8c" : "rgba(19,140,140,0.32)";
    const countLabel = d.count ? `<text x="${x + barW/2}" y="${y - 5}" text-anchor="middle" font-size="9" font-weight="700" fill="#74828a">${d.count}</text>` : "";
    const dayLabel = String(d.date.getDate()).padStart(2,"0");
    const finDate = `${dayLabel}.${String(d.date.getMonth()+1).padStart(2,"0")}.${d.date.getFullYear()}`;
    const path = roundedTopBarPath(x, y, barW, h, 4);
    return `<g tabindex="0">
      <title>${finDate} — ${d.count} työtä · ${d.sum} €</title>
      <rect x="${x}" y="${padTop - 4}" width="${barW}" height="${baseline - padTop + 4}" fill="transparent"></rect>
      ${path ? `<path d="${path}" fill="${fill}"></path>` : ""}
      ${countLabel}
      <text x="${x + barW/2}" y="${H - 4}" text-anchor="middle" font-size="8" fill="#9bb0bc">${dayLabel}</text>
    </g>`;
  }).join("");

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Vastaanotetut työt päivittäin, viimeiset ${days} päivää">
    <line x1="${startX - 2}" y1="${baseline}" x2="${startX + usableW + 2}" y2="${baseline}" stroke="#dce6eb" stroke-width="1"></line>
    ${bars}
  </svg>`;
}

function getExportData(){
  let f=document.getElementById("exportFrom")?.value||"",t=document.getElementById("exportTo")?.value||"",s=document.getElementById("exportSource")?.value||"all",st=document.getElementById("exportStatus")?.value||"all";
  return jobs.filter(j=>{
    const created = jobCreatedDateStr(j);
    return (!f||created>=f)&&(!t||created<=t)&&(s==="all"||j.source===s||(s==="store"&&!j.source))&&(st==="all"||j.status===st);
  });
}

function isoToFin(iso){
  if(!iso) return "";
  const [y,m,day]=iso.split("-");
  return `${Number(day)}.${Number(m)}.${y}`;
}

// Local-calendar-date ISO string — new Date(...).toISOString() converts to
// UTC first, which rolls the date back a day in Finland's UTC+2/+3 zone.
function localISO(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

let reportsActivePeriod = "month";
function setReportPeriod(kind){
  const fromEl=document.getElementById("exportFrom"), toEl=document.getElementById("exportTo");
  const d=new Date();
  if(kind==="today"){
    const iso=localISO(d);
    fromEl.value=iso;
    toEl.value=iso;
  } else if(kind==="week"){
    const dow=(d.getDay()+6)%7; // Monday = 0
    const monday=new Date(d); monday.setDate(d.getDate()-dow);
    const sunday=new Date(monday); sunday.setDate(monday.getDate()+6);
    fromEl.value=localISO(monday);
    toEl.value=localISO(sunday);
  } else if(kind==="month"){
    fromEl.value=localISO(new Date(d.getFullYear(), d.getMonth(), 1));
    toEl.value=localISO(new Date(d.getFullYear(), d.getMonth()+1, 0));
  } else if(kind==="year"){
    fromEl.value=localISO(new Date(d.getFullYear(), 0, 1));
    toEl.value=localISO(new Date(d.getFullYear(), 11, 31));
  } else {
    fromEl.value="";
    toEl.value="";
  }
  reportsActivePeriod = kind;
  renderReports();
}

function highlightReportPeriod(){
  document.querySelectorAll(".export-btn[data-period]").forEach(btn=>{
    btn.classList.toggle("primary", btn.dataset.period===reportsActivePeriod);
  });
}

// Only auto-scope the reports view to the current month the first time it's
// opened in a session — after that, whatever period the user picked (incl.
// "Kaikki ajat") sticks until reload instead of being reset on every visit.
let reportsPeriodInitialized = false;
function initReportsPeriod(){
  if(reportsPeriodInitialized) { renderReports(); return; }
  reportsPeriodInitialized = true;
  setReportPeriod("month");
}

function renderReports(){
  let d=getExportData();
  let delivered=d.filter(j=>j.status==="done"), pending=d.filter(j=>j.status!=="done");
  let deliveredRevenue=delivered.reduce((a,j)=>a+(Number(j.price)||0),0);
  let pendingRevenue=pending.reduce((a,j)=>a+(Number(j.price)||0),0);

  document.getElementById("rTotal").textContent=d.length;
  document.getElementById("rConverted").textContent=delivered.length;
  document.getElementById("rDeliveredRevenue").textContent="€"+deliveredRevenue+" tuottoa";
  document.getElementById("rPending").textContent=pending.length;
  document.getElementById("rPendingRevenue").textContent="€"+pendingRevenue+" arvoltaan";

  const fromVal=document.getElementById("exportFrom").value, toVal=document.getElementById("exportTo").value;
  document.getElementById("rPeriodLabel").textContent = (fromVal||toVal) ? `${isoToFin(fromVal)||"…"} – ${isoToFin(toVal)||"…"}` : "Kaikki ajat";
  highlightReportPeriod();

  // Still-open deliveries for the reference day — always "today" (or, after
  // closing time, "tomorrow" — see referenceDateStr()), regardless of the
  // period filter above.
  const afterClosingReports = isAfterClosing();
  const dueRefReportJobs = jobs.filter(j => j.date===referenceDateStr() && j.status!=="done");
  document.getElementById("rDueTodayLabel").textContent = afterClosingReports ? "Huomenna toimitettavana" : "Tänään toimitettavana";
  document.getElementById("rDueTodayCount").textContent = dueRefReportJobs.length;
  document.getElementById("rDueTodayRevenue").textContent = "€"+dueRefReportJobs.reduce((a,j)=>a+(Number(j.price)||0),0);

  let src=document.getElementById("sourceStats"),sourceKeys=["store","whatsapp"],mx=Math.max(1,...sourceKeys.map(s=>jobs.filter(j=>(j.source||"store")===s).length));
  src.innerHTML=sourceKeys.map(s=>{let n=jobs.filter(j=>(j.source||"store")===s).length,m=SOURCE_META[s];return `<div class="source-row"><span>${m.icon} ${m.label}</span><div class="bar"><i style="width:${n/mx*100}%"></i></div><b>${n}</b></div>`}).join("");

  let sts=[["waiting","Odottaa"],["arrived","Tuote saapui"],["active","Työn alla"],["late","Myöhässä"],["ready","Valmis"],["done","Luovutettu"]],sm=Math.max(1,...sts.map(x=>jobs.filter(j=>j.status===x[0]).length));
  document.getElementById("statusStats").innerHTML=sts.map(x=>{let n=jobs.filter(j=>j.status===x[0]).length;return `<div class="status-row"><span>${x[1]}</span><div class="bar"><i style="width:${n/sm*100}%"></i></div><b>${n}</b></div>`}).join("");

  document.getElementById("exportTable").innerHTML=d.map(j=>`<tr><td>${j.id}</td><td><span class="source-pill">${SOURCE_META[j.source||"store"]?.icon||""} ${SOURCE_META[j.source||"store"]?.label||j.source}</span></td><td>${j.name||""}</td><td>${jobCreatedDateStr(j)}</td><td>${j.product||""}</td><td>${j.work||""}</td><td><span class="status-pill">${statusLabel[j.status]||j.status||""}</span></td><td>${j.price!==""&&j.price!=null?"€"+j.price:""}</td></tr>`).join("")||'<tr><td colspan="8" class="empty-row">Ei hakuehtoja vastaavia tietoja.</td></tr>';
  document.getElementById("previewCount").textContent=d.length+" työtä";
}

function csvRows(){let d=getExportData();return [["Työ ID","Lähde","Asiakas","Päivämäärä","Tuote","Korjaus","Tila","Hinta"],...d.map(j=>[j.id,SOURCE_META[j.source||"store"]?.label||j.source,j.name,jobCreatedDateStr(j),j.product,j.work,statusLabel[j.status]||j.status,j.price])]}
function exportCSV(){let rows=csvRows(),csv="\uFEFF"+rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n"),a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download="tehtaankatu_suutari_export.csv";a.click()}
function exportExcel(){let rows=csvRows(),table="<table><tr>"+rows[0].map(x=>`<th>${x}</th>`).join("")+"</tr>"+rows.slice(1).map(r=>"<tr>"+r.map(x=>`<td>${x??""}</td>`).join("")+"</tr>").join("")+"</table>",a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff<html><meta charset='UTF-8'><body>"+table+"</body></html>"],{type:"application/vnd.ms-excel"}));a.download="tehtaankatu_suutari_export.xls";a.click()}
["exportFrom","exportTo"].forEach(id=>document.getElementById(id)?.addEventListener("change",()=>{reportsActivePeriod=null; renderReports();}));
["exportSource","exportStatus"].forEach(id=>document.getElementById(id)?.addEventListener("change",renderReports));

// Settings operations
function saveSettings() {
  const url = document.getElementById("dbUrl").value.trim();
  const key = document.getElementById("dbKey").value.trim();
  localStorage.setItem("suutari_db_url", url);
  localStorage.setItem("suutari_db_key", key);
  const statusEl = document.getElementById("connStatus");
  statusEl.style.display = "block";

  if (typeof supabase === 'undefined') {
    statusEl.textContent = "Asetukset tallennettu, mutta Supabase SDK-kirjastoa ei ole ladattu. Varmista verkkoyhteys.";
    statusEl.style.color = "red";
    return;
  }

  if(url && key) {
    initSupabase();
    statusEl.textContent = "Asetukset tallennettu! Yritetään yhdistää...";
    statusEl.style.color = "var(--teal)";
    syncFromDb().then(success => {
      if(success) {
        statusEl.textContent = "Yhdistetty ja synkronoitu Supabasen kanssa!";
        statusEl.style.color = "var(--teal)";
        renderHome();
      } else {
        statusEl.textContent = "Yhteys onnistui, mutta taulujen alustus puuttuu Supabasesta. Suorita SQL-alustuskoodi.";
        statusEl.style.color = "orange";
      }
    });
  } else {
    supabaseClient = null;
    statusEl.textContent = "Supabase otettu pois käytöstä. Käytetään paikallista demo-tilaa.";
    statusEl.style.color = "var(--text-muted)";
  }
}

async function testConnection() {
  const url = document.getElementById("dbUrl").value.trim();
  const key = document.getElementById("dbKey").value.trim();
  const statusEl = document.getElementById("connStatus");
  statusEl.style.display = "block";
  statusEl.textContent = "Yhdistetään...";
  statusEl.style.color = "var(--text-muted)";
  
  if (typeof supabase === 'undefined') {
    statusEl.textContent = "Yhteys epäonnistui: Supabase SDK-kirjastoa ei ladattu. Varmista verkkoyhteys.";
    statusEl.style.color = "red";
    return;
  }

  try {
    const client = supabase.createClient(url, key);
    const { error } = await client.from("jobs").select("count");
    if(error) throw error;
    statusEl.textContent = "Yhteys muodostettu onnistuneesti! Tietokanta vastaa.";
    statusEl.style.color = "var(--teal)";
  } catch(err) {
    statusEl.textContent = "Yhteys epäonnistui (Varmista SQL-alustus): " + err.message;
    statusEl.style.color = "red";
  }
}

function copySQLSetup() {
  // Locked-down version: table access requires a real Supabase Auth session
  // (role = authenticated). Anonymous visitors can only call get_job_status()
  // for order tracking — they get no direct table access at all.
  const sql = `-- Create jobs table
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    product TEXT,
    work TEXT,
    price NUMERIC,
    date TEXT,
    status TEXT,
    loc TEXT,
    img TEXT,
    img_after TEXT,
    note TEXT,
    customer_note TEXT,
    request_id TEXT,
    source TEXT DEFAULT 'store',
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so
-- these guarantee any pre-existing jobs table also has every column the app
-- writes to (running this again is always safe).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'store';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_note TEXT;

-- Enable Row Level Security (RLS)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Remove any old wide-open public policies (safe if they don't exist)
DROP POLICY IF EXISTS "Allow public read" ON jobs;
DROP POLICY IF EXISTS "Allow public insert" ON jobs;
DROP POLICY IF EXISTS "Allow public update" ON jobs;
DROP POLICY IF EXISTS "Allow public delete" ON jobs;
DROP POLICY IF EXISTS "Authenticated full access" ON jobs;

-- Only logged-in staff (Supabase Auth) may read/write this table
CREATE POLICY "Authenticated full access" ON jobs
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Secure lookup functions for customer order tracking (hide phone and the
-- internal "Sisäinen huomautus" note; only ever expose customer_note).
-- DROP first: changing the return columns isn't allowed via CREATE OR REPLACE.
DROP FUNCTION IF EXISTS get_job_status(TEXT);
CREATE OR REPLACE FUNCTION get_job_status(job_id TEXT)
RETURNS TABLE(id TEXT, product TEXT, work TEXT, status TEXT, date TEXT, img TEXT, img_after TEXT, customer_note TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT j.id, j.product, j.work, j.status, j.date, j.img, j.img_after, j.customer_note
  FROM jobs j
  WHERE j.id = job_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Looks up every job filed under a given ticket/card number (the physical
-- card handed to the customer at drop-off; stored in jobs.name).
CREATE OR REPLACE FUNCTION get_jobs_by_ticket(ticket TEXT)
RETURNS TABLE(id TEXT, product TEXT, work TEXT, status TEXT, date TEXT, img TEXT, img_after TEXT, customer_note TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT j.id, j.product, j.work, j.status, j.date, j.img, j.img_after, j.customer_note
  FROM jobs j
  WHERE trim(lower(j.name)) = trim(lower(ticket))
  ORDER BY j.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Only these narrow functions are public; the tables themselves are not
GRANT EXECUTE ON FUNCTION get_job_status(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION get_job_status(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_jobs_by_ticket(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION get_jobs_by_ticket(TEXT) TO authenticated;

-- Job photo storage: photos are uploaded here (not embedded as base64 in
-- the jobs table) so "select * from jobs" stays fast no matter how many
-- photos have been taken. Bucket is public for reads (so <img> tags and the
-- customer tracking page can load photos directly); only logged-in staff
-- can upload/change/delete.
INSERT INTO storage.buckets (id, name, public)
VALUES ('job-photos', 'job-photos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated upload job photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update job photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete job photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read job photos" ON storage.objects;

CREATE POLICY "Authenticated upload job photos" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'job-photos');
CREATE POLICY "Authenticated update job photos" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'job-photos');
CREATE POLICY "Authenticated delete job photos" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'job-photos');
CREATE POLICY "Public read job photos" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'job-photos');`;
  navigator.clipboard.writeText(sql).then(() => {
    alert("SQL-alustuskoodi kopioitu leikepöydälle!");
  });
}

function saveGeminiSettings() {
  const key = document.getElementById("geminiKey").value.trim();
  localStorage.setItem("suutari_gemini_key", key);
  const statusEl = document.getElementById("aiStatus");
  statusEl.style.display = "block";
  if(key) {
    statusEl.textContent = "AI-asetukset tallennettu! Voit nyt käyttää automaattista tekoälyanalyysiä.";
    statusEl.style.color = "var(--teal)";
  } else {
    statusEl.textContent = "AI-avain poistettu. Käytetään manuaalisia oletuksia.";
    statusEl.style.color = "var(--text-muted)";
  }
}

let afterImageBase64 = null;

async function loadAfterImage(e) {
  const f = e.target.files?.[0];
  if(!f) return;

  const preview = document.getElementById("afterImgPreview");
  const dropText = document.getElementById("afterDropText");
  dropText.style.display = "none";

  try {
    const displayFile = await toDisplayableImage(f);
    preview.src = URL.createObjectURL(displayFile);
    preview.style.display = "block";

    const select = document.getElementById("socialJobSelect");
    const jobId = select.value;
    const url = await uploadJobImage(displayFile, jobId || "social", "after");
    afterImageBase64 = url;

    if (jobId) {
      const j = jobs.find(x => x.id === jobId);
      if (j) {
        j.img_after = url;
        saveState();
        dbUpdateJobAfterImage(jobId, url);
      }
    }
  } catch (err) {
    console.error("After-photo load failed:", err);
    dropText.style.display = "block";
    preview.style.display = "none";
    alert("Kuvan lataus epäonnistui. Yritä uudelleen.");
  }
}

function renderSocial() {
  document.getElementById("postMon").checked = localStorage.getItem("social_post_mon") === "true";
  document.getElementById("postWed").checked = localStorage.getItem("social_post_wed") === "true";
  document.getElementById("postFri").checked = localStorage.getItem("social_post_fri") === "true";
  updateSocialProgress();

  const relevantJobs = jobs.filter(j => j.status === "ready" || j.status === "done" || j.status === "active");
  const select = document.getElementById("socialJobSelect");
  
  if (relevantJobs.length === 0) {
    select.innerHTML = `<option value="">Ei aktiivisia tai valmiita töitä</option>`;
    return;
  }
  
  select.innerHTML = relevantJobs.map(j => `<option value="${j.id}">${j.id} - ${j.name} (${j.product})</option>`).join("");
  loadJobForSocial();
}

function updateSocialProgress() {
  localStorage.setItem("social_post_mon", document.getElementById("postMon").checked);
  localStorage.setItem("social_post_wed", document.getElementById("postWed").checked);
  localStorage.setItem("social_post_fri", document.getElementById("postFri").checked);
  
  const count = [document.getElementById("postMon").checked, document.getElementById("postWed").checked, document.getElementById("postFri").checked].filter(Boolean).length;
  
  const ideaText = document.getElementById("socialIdeaText");
  if (count === 0) {
    ideaText.textContent = "Maanantai suositus: Jaa Google Mapsissa uusi hyödyllinen vinkki (esim. nahanhoito syksyllä).";
  } else if (count === 1) {
    ideaText.textContent = "Keskiviikko suositus: Jaa lyhyt kuva tai tarina meneillään olevasta työstänne (🔧 Työn alla).";
  } else if (count === 2) {
    ideaText.textContent = "Perjantai suositus: Luo upea \"Ennen & Jälkeen\" -kuva ja julkaise se viikonlopuksi!";
  } else {
    ideaText.textContent = "✨ Upeaa työtä! Viikon julkaisutavoite (3 postausta) on saavutettu!";
  }
}

function loadJobForSocial() {
  const select = document.getElementById("socialJobSelect");
  const jobId = select.value;
  if (!jobId) return;
  
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  
  document.getElementById("beforeImgPreview").src = j.img || bag;
  
  const afterPreview = document.getElementById("afterImgPreview");
  const afterDropText = document.getElementById("afterDropText");
  
  if (j.img_after) {
    afterImageBase64 = j.img_after;
    afterPreview.src = j.img_after;
    afterPreview.style.display = "block";
    afterDropText.style.display = "none";
  } else {
    afterImageBase64 = null;
    afterPreview.src = "";
    afterPreview.style.display = "none";
    afterDropText.style.display = "block";
  }
}

function copyCaption() {
  const text = document.getElementById("aiCaptionText")?.textContent || "";
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    alert("Teksti kopioitu leikepöydälle!");
  });
}

async function generateAISocialPost() {
  const select = document.getElementById("socialJobSelect");
  const jobId = select.value;
  if (!jobId) {
    alert("Valitse ensin työ listasta.");
    return;
  }
  
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  
  const apiKey = localStorage.getItem("suutari_gemini_key");
  if (!apiKey) {
    const fallbackText = `🔨 Ennen & Jälkeen - Korjaus valmis!\n\nTeimme upean korjauksen tähän tuotteeseen: ${j.product} (${j.work}). Kengät tai laukku ovat nyt valmiina uusiin seikkailuihin! \n\nTervetuloa huoltamaan suosikkituotteesi ateljeehenne.\n\n📍 Tehtaankatu 18, Helsinki\n#suutari #helsinki #kenkähuolto`;
    document.getElementById("aiCaptionText").textContent = fallbackText;
    document.getElementById("aiCaptionCard").style.display = "block";
    return;
  }
  
  const btn = document.getElementById("btnGenerateSocial");
  const oldText = btn.textContent;
  btn.textContent = "AI kirjoittaa... 🪄";
  btn.disabled = true;
  
  const prompt = `Olet ammattitaitoinen suutari ja sisällöntuottaja Tehtaankatu Suutari -liikkeelle Helsingissä.
Kirjoita mukaansatempaava ja ammattimainen sosiaalisen median julkaisuteksti (Instagram, Facebook tai Google Maps) Fince seuraavasta valmiista työstä:
- Tuote: ${j.product}
- Tehty korjaus: ${j.work}
- Hinta: ${j.price} €

Sisällytä tekstiin sopivia emojiyhdistelmiä (kuten 🔨, 🥾, 👜, ✨), osoite "Tehtaankatu 18, Helsinki" sekä suosittuja hashtageja (kuten #suutari #helsinki #kenkähuolto #nahkatyöt). Pidä sävy ystävällisenä, paikallisena ja laatuun keskittyvänä. Vastaa AINOASTAAN valmiilla julkaisutekstillä.`;

  let success = false;
  const { text: caption } = await callGemini(apiKey, [{ text: prompt }]);
  if (caption) {
    document.getElementById("aiCaptionText").textContent = caption;
    document.getElementById("aiCaptionCard").style.display = "block";
    success = true;
  }
  
  if (!success) {
    alert("AI-tekstin luominen epäonnistui. Käytetään valmista pohjaa.");
    const fallbackText = `🔨 Ennen & Jälkeen - Korjaus valmis!\n\nTeimme upean korjauksen tähän tuotteeseen: ${j.product} (${j.work}). Kengät tai laukku ovat nyt valmiina uusiin seikkailuihin! \n\nTervetuloa huoltamaan suosikkituotteesi ateljeehenne.\n\n📍 Tehtaankatu 18, Helsinki\n#suutari #helsinki #kenkähuolto`;
    document.getElementById("aiCaptionText").textContent = fallbackText;
    document.getElementById("aiCaptionCard").style.display = "block";
  }
  
  btn.textContent = oldText;
  btn.disabled = false;
}

function combineImages() {
  const select = document.getElementById("socialJobSelect");
  const jobId = select.value;
  if (!jobId) return;
  
  const j = jobs.find(x => x.id === jobId);
  if (!j) return;
  
  const beforeSrc = j.img || bag;
  const afterSrc = afterImageBase64 || bag;
  
  const canvas = document.getElementById("combinedCanvas");
  const ctx = canvas.getContext("2d");
  
  const imgBefore = new Image();
  const imgAfter = new Image();
  
  let loadedCount = 0;
  function onImageLoaded() {
    loadedCount++;
    if (loadedCount === 2) {
      const width = 1200;
      const height = 600;
      canvas.width = width;
      canvas.height = height;
      
      ctx.drawImage(imgBefore, 0, 0, width/2, height);
      ctx.drawImage(imgAfter, width/2, 0, width/2, height);
      
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(width/2, 0);
      ctx.lineTo(width/2, height);
      ctx.stroke();
      
      ctx.fillStyle = "rgba(15, 45, 74, 0.85)";
      ctx.font = "bold 24px 'Inter', sans-serif";
      
      ctx.fillRect(15, 15, 120, 40);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("ENNEN", 30, 44);
      
      ctx.fillStyle = "rgba(16, 185, 129, 0.85)";
      ctx.fillRect(width/2 + 15, 15, 140, 40);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("JÄLKEEN", width/2 + 30, 44);
      
      const wm = document.getElementById("watermarkText").value || "Tehtaankatu Suutari";
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(0, height - 50, width, 50);
      
      ctx.fillStyle = "#ffffff";
      ctx.font = "italic 18px 'Inter', sans-serif";
      ctx.fillText(wm, 25, height - 18);
      ctx.fillText("✨ Tehty Suomessa", width - 200, height - 18);
      
      document.getElementById("combinedCanvasCard").style.display = "block";
    }
  }
  
  imgBefore.onload = onImageLoaded;
  imgAfter.onload = onImageLoaded;

  // Photos now often come from Supabase Storage (a different origin) rather
  // than an inline data: URL — without this, drawing them to the canvas
  // taints it and canvas.toDataURL() in downloadCombinedImage() below throws.
  imgBefore.crossOrigin = "anonymous";
  imgAfter.crossOrigin = "anonymous";

  imgBefore.src = beforeSrc;
  imgAfter.src = afterSrc;
}

function downloadCombinedImage() {
  const canvas = document.getElementById("combinedCanvas");
  const select = document.getElementById("socialJobSelect");
  const jobId = select.value || "suutari";
  
  const link = document.createElement("a");
  link.download = `ennen_jalkeen_${jobId}.jpg`;
  link.href = canvas.toDataURL("image/jpeg", 0.9);
  link.click();
}

let selectedShelf = null;

function renderShelves() {
  const rows = ["A", "B", "C"];
  const numCells = 8;

  rows.forEach(r => {
    let cellsHtml = "";
    for (let i = 1; i <= numCells; i++) {
      const cellCode = `${r}${i}`;
      
      const shelfJobs = jobs.filter(j => j.status !== "done" && j.loc.trim().toUpperCase().startsWith(cellCode));
      const jobCount = shelfJobs.length;
      const hasLate = shelfJobs.some(j => j.status === "late");
      
      let classes = "shelf-cell";
      if (selectedShelf === cellCode) classes += " selected";
      if (hasLate) classes += " late";
      else if (jobCount > 0) classes += " filled";
      
      cellsHtml += `
        <div class="${classes}" onclick="selectShelf('${cellCode}')">
          ${cellCode}
          ${jobCount > 0 ? `<span class="badge">${jobCount}</span>` : ""}
        </div>
      `;
    }
    document.getElementById(`row${r}Cells`).innerHTML = cellsHtml;
  });
  
  if (selectedShelf) {
    showShelfDetails(selectedShelf);
  } else {
    document.getElementById("selectedShelfTitle").textContent = "Valitse hylly";
    document.getElementById("shelfJobList").innerHTML = `
      <div class="empty-row" style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 40px 0;">
        Klikkaa hyllysolua nähdäksesi sen sisällön.
      </div>
    `;
  }
}

function selectShelf(shelfCode) {
  selectedShelf = shelfCode;
  renderShelves();
}

function showShelfDetails(shelfCode) {
  document.getElementById("selectedShelfTitle").textContent = `Hylly ${shelfCode}`;
  
  const shelfJobs = jobs.filter(j => j.status !== "done" && j.loc.trim().toUpperCase().startsWith(shelfCode));
  
  if (shelfJobs.length === 0) {
    document.getElementById("shelfJobList").innerHTML = `
      <div class="empty-row" style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 40px 0;">
        Hylly on tyhjä.
      </div>
    `;
    return;
  }
  
  document.getElementById("shelfJobList").innerHTML = shelfJobs.map(j => `
    <div class="shelf-job-row" onclick="openJob('${j.id}')">
      <div>
        <b style="font-size:14px;display:block;">${j.id} · ${j.name}</b>
        <small style="font-size:11px;color:var(--text-muted)">${j.product} (${j.loc})</small>
      </div>
      <div>
        <span class="pill ${statusPillClass(j.status)}">${statusLabel[j.status] || j.status}</span>
      </div>
    </div>
  `).join("");
}

function saveAIInstructions() {
  const text = document.getElementById("aiInstructions").value;
  localStorage.setItem("suutari_ai_instructions", text);
  const status = document.getElementById("aiInstructionsStatus");
  status.textContent = "AI-ohjeet tallennettu onnistuneesti!";
  status.style.color = "var(--teal)";
  status.style.display = "block";
}

async function testAISettings() {
  const key = document.getElementById("geminiKey").value.trim();
  const statusEl = document.getElementById("aiStatus");
  statusEl.style.display = "block";
  statusEl.textContent = "Testataan AI-yhteyttä...";
  statusEl.style.color = "var(--text-muted)";

  if (!key) {
    statusEl.textContent = "Syötä ensin API-avain.";
    statusEl.style.color = "var(--red)";
    return;
  }

  // Try v1 first, fallback to v1beta if needed
  const versions = ["v1", "v1beta"];
  let lastError = "Tuntematon virhe";
  
  for (const ver of versions) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${key}`);
      const data = await res.json();
      
      if (res.ok) {
        if (data.models && data.models.length > 0) {
          const modelNames = data.models.map(m => m.name.replace("models/", "")).join(", ");
          statusEl.textContent = `Yhteys onnistui (${ver})! Mallit: ${modelNames}`;
          statusEl.style.color = "var(--teal)";
          alert(`AI-yhteys toimii loistavasti (${ver})!\n\nSaatavilla olevat mallit avaimellesi:\n\n${modelNames}`);
          return;
        } else {
          statusEl.textContent = `Yhteys onnistui (${ver}), mutta yhtään mallia ei ole saatavilla tälle avaimelle.`;
          statusEl.style.color = "orange";
          alert(`Google API (${ver}) vastasi, mutta yhtään mallia ei palautettu. API-avaimessa saattaa olla rajoituksia.`);
          return;
        }
      } else {
        lastError = data.error ? data.error.message : "Virhe";
      }
    } catch (err) {
      console.warn(`ListModels on ${ver} failed:`, err);
      lastError = err.message;
    }
  }

  statusEl.textContent = `Yhteys epäonnistui: ${lastError}`;
  statusEl.style.color = "var(--red)";
  alert(`Google Gemini API Yhteysvirhe:\n\n${lastError}`);
}

function copySyncLink() {
  const url = localStorage.getItem("suutari_db_url") || "";
  const key = localStorage.getItem("suutari_db_key") || "";
  const geminiKey = localStorage.getItem("suutari_gemini_key") || "";
  const aiInstructions = localStorage.getItem("suutari_ai_instructions") || "";

  if (!url || !key) {
    alert("Määritä ja tallenna Supabase-yhteysasetukset ensin!");
    return;
  }

  const payload = { url, key, geminiKey, aiInstructions };
  const encoded = btoa(JSON.stringify(payload));
  // URL fragment (#), not a query string — never sent to the server/CDN logs.
  const syncLink = `${window.location.origin}${window.location.pathname}#sync=${encodeURIComponent(encoded)}`;

  navigator.clipboard.writeText(syncLink).then(() => {
    const statusEl = document.getElementById("syncStatus");
    statusEl.style.display = "block";
    statusEl.textContent = "Synkronointilinkki kopioitu leikepöydälle! Avaa tämä linkki puhelimellasi tai kotikoneellasi.";
    alert("Synkronointilinkki kopioitu leikepöydälle!\n\nVoit nyt avata tämän linkin millä tahansa muulla laitteella synkronoidaksesi asetukset automaattisesti. Huom: linkki paljastaa tietokantayhteytesi jos joku muu sen näkee, joten lähetä se vain luotetulla kanavalla. Kirjautuminen vaaditaan silti erikseen uudella laitteella.");
  }).catch(err => {
    alert("Kopiointi epäonnistui: " + err.message);
  });
}

function deleteJob(id) {
  if (confirm("Haluatko varmasti poistaa tämän työn (" + id + ") kokonaan? Tätä ei voi peruuttaa.")) {
    jobs = jobs.filter(x => x.id !== id);
    saveState();
    dbDeleteJob(id);
    showPage("home");
    renderHome();
  }
}

/* Morning Brief (Sabah Özeti) helper functions */
function renderMorningBrief() {
  const briefList = document.getElementById("briefList");
  const briefCard = document.getElementById("morningBrief");
  if (!briefList || !briefCard) return;

  if (sessionStorage.getItem("suutari_brief_dismissed") === "true") {
    briefCard.style.display = "none";
    return;
  }

  const items = [];
  const afterClosingBrief = isAfterClosing();
  const refStr = referenceDateStr();

  // 1. Myöhässä olevat (Late jobs)
  const lateJobsList = jobs.filter(j => j.status === "late");
  if (lateJobsList.length > 0) {
    items.push(`🔴 <strong>${lateJobsList.length} työtä on myöhässä!</strong> Suosittelemme saattamaan nämä nopeasti valmiiksi.`);
  }

  // 2. Tänään/huomenna toimitettavat (Due today, or tomorrow after closing time)
  const dueTodayList = jobs.filter(j => j.date === refStr && j.status !== "done" && j.status !== "ready");
  if (dueTodayList.length > 0) {
    items.push(`📅 <strong>${dueTodayList.length} työ(tä) tulee luovuttaa ${afterClosingBrief ? "huomenna" : "tänään"}.</strong> Varmista, että nämä ovat valmiina.`);
  }

  // 3. Riskiryhmä: Malzeme bekleyen acil işler (Waiting for material due within 2 days)
  const now = new Date();
  const riskJobs = jobs.filter(j => {
    if (j.status !== "waiting") return false;
    try {
      const parts = j.date.split(".");
      if (parts.length === 3) {
        const dueDate = new Date(parts[2], parts[1] - 1, parts[0]);
        const diffTime = dueDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return diffDays >= 0 && diffDays <= 2;
      }
    } catch(e) {}
    return false;
  });
  if (riskJobs.length > 0) {
    items.push(`⚠️ <strong>${riskJobs.length} työ(tä) odottaa materiaaleja, vaikka toimitusaika on alle 48 tunnin päästä!</strong>`);
  }

  // 4. WhatsApp-lähteiset työt jotka odottavat tuotteen saapumista
  const whatsappWaitingCount = jobs.filter(j => j.source === "whatsapp" && j.status === "waiting").length;
  if (whatsappWaitingCount > 0) {
    items.push(`💬 <strong>${whatsappWaitingCount} WhatsApp-tuotetta odottaa saapumista.</strong>`);
  }

  if (items.length > 0) {
    briefList.innerHTML = items.map(item => `<li>${item}</li>`).join("");
    briefCard.style.display = "block";
  } else {
    briefList.innerHTML = `<li>✨ Kaikki ajallaan! Ei kiireellisiä huomioita tälle päivälle. Hyvää työpäivää!</li>`;
    briefCard.style.display = "block";
  }
}

function dismissBrief() {
  sessionStorage.setItem("suutari_brief_dismissed", "true");
  const briefCard = document.getElementById("morningBrief");
  if (briefCard) briefCard.style.display = "none";
}

/* Tehtävälista (Muistilista) helper functions */
function renderTodos() {
  const listEl = document.getElementById("todoList");
  const countEl = document.getElementById("todoCount");
  if (!listEl || !countEl) return;

  const activeCount = todos.filter(t => !t.done).length;
  countEl.textContent = `${activeCount} active`;

  if (todos.length === 0) {
    listEl.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:12px; padding:20px 0;">Ei tehtäviä. Lisää ensimmäinen ylhäältä!</div>`;
    return;
  }

  listEl.innerHTML = todos.map(t => `
    <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-main); padding:10px 12px; border-radius:10px; border:1px solid var(--border-color); opacity: ${t.done ? 0.6 : 1}; transition: opacity 0.2s;">
      <label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-size:13px; text-decoration: ${t.done ? 'line-through' : 'none'}; color: ${t.done ? 'var(--text-muted)' : 'var(--text-main)'}; width:80%;">
        <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleTodoTask(${t.id})" style="width:16px; height:16px; cursor:pointer;">
        <span>${t.text}</span>
      </label>
      <button onclick="deleteTodoTask(${t.id})" style="background:none; border:0; color:#ef4444; font-size:14px; cursor:pointer; padding:4px 8px; display:flex; align-items:center; justify-content:center;">🗑️</button>
    </div>
  `).join("");
}

function addTodoTask() {
  const input = document.getElementById("todoInput");
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;

  todos.push({
    id: Date.now(),
    text: val,
    done: false
  });

  input.value = "";
  saveState();
  renderTodos();
}

function toggleTodoTask(id) {
  const t = todos.find(x => x.id === id);
  if (t) {
    t.done = !t.done;
    saveState();
    renderTodos();
  }
}

function deleteTodoTask(id) {
  todos = todos.filter(x => x.id !== id);
  saveState();
  renderTodos();
}



