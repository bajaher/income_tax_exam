/* =====================================================================
   محاكي الاختبار — المنطق الرئيسي
   يعتمد على: config.js (الإعدادات) و questions.js (بنك الأسئلة)
   ===================================================================== */
"use strict";

/* ---------------- أدوات عامة ---------------- */
const $ = (sel) => document.querySelector(sel);
const LETTERS = ["أ","ب","ج","د","هـ","و"];

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function normalizeAns(s){
  return String(s).trim().toLowerCase()
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[،,%٪\s]/g,"")
    .replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي");
}
function fmtTime(sec){
  const m = Math.floor(sec/60), s = sec%60;
  return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}
const TYPE_NAMES = {mcq:"اختيار من متعدد", tf:"صح / خطأ", fill:"أكمل الفراغ", match:"مطابقة", calc:"مسألة حسابية"};

/* ---------------- التخزين المحلي ---------------- */
const STORE_KEY = "taxExamSim_v1";
function loadStore(){
  try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {attempts:[]}; }
  catch(e){ return {attempts:[]}; }
}
function saveStore(st){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(st)); }catch(e){} }

/* ---------------- حالة الاختبار ---------------- */
let exam = null;      // {questions:[...], idx, answers:[], flags:[], remaining, timerId, startedAt}
let lastResult = null;

/* =====================================================
   بناء نسخة اختبار من البنك
   ===================================================== */
function buildExam(){
  let pool = QUESTION_BANK.filter(q => CONFIG.allowedTypes.includes(q.type));
  if(CONFIG.shuffleQuestions) pool = shuffle(pool);

  // تنويع الاختيار: نوزع الأسئلة على الموضوعات قدر الإمكان
  const n = Math.min(CONFIG.examQuestions, pool.length);
  const byTopic = {};
  pool.forEach(q => { (byTopic[q.topic] = byTopic[q.topic]||[]).push(q); });
  const topics = Object.keys(byTopic);
  const chosen = [];
  let ti = 0;
  while(chosen.length < n){
    const t = topics[ti % topics.length];
    if(byTopic[t].length) chosen.push(byTopic[t].shift());
    ti++;
    if(topics.every(t2 => byTopic[t2].length===0)) break;
  }
  const questions = (CONFIG.shuffleQuestions ? shuffle(chosen) : chosen).map(instantiate);
  return {
    questions,
    idx:0,
    answers: questions.map(()=>null),
    flags: questions.map(()=>false),
    remaining: CONFIG.examDuration*60,
    startedAt: Date.now(),
    timerId:null
  };
}

/* ضمان عدم تكرار الخيارات في الأسئلة المولّدة عشوائيًا */
function dedupeBase(base){
  const correct = base.opts[base.a];
  const others = [];
  base.opts.forEach((o,i)=>{
    if(i!==base.a && o!==correct && !others.includes(o)) others.push(o);
  });
  const need = base.opts.length - 1;
  if(others.length < need){
    // نولّد بدائل رقمية مشتقة من الإجابة الصحيحة أو من أول خيار رقمي
    const numOf = (s)=>{
      const m = String(s).match(/([\d][\d,\.]*)/);
      return m ? {num: parseFloat(m[1].replace(/,/g,"")), tmpl: String(s), lit: m[1]} : null;
    };
    let seed = numOf(correct) || others.map(numOf).find(Boolean);
    if(seed && seed.num === 0){
      seed = others.map(numOf).find(x => x && x.num > 0) || seed;
    }
    const factors = [2, 0.5, 1.5, 3, 0.25, 4, 0.75, 5, 0.1];
    let fi = 0;
    while(others.length < need && fi < factors.length){
      let filler;
      if(seed){
        let v = seed.num * factors[fi];
        v = v >= 100 ? Math.round(v) : Math.round(v*100)/100;
        filler = seed.tmpl.replace(seed.lit, v.toLocaleString("en-US"));
      } else {
        filler = "لا شيء مما ذكر" + " ".repeat(fi);
      }
      if(filler !== correct && !others.includes(filler)) others.push(filler);
      fi++;
    }
  }
  return {q:base.q, opts:[correct].concat(others.slice(0,need)), a:0, expl:base.expl};
}

/* توليد نسخة قابلة للعرض من السؤال (مع خلط الخيارات وتوليد الأرقام) */
function instantiate(q){
  const inst = {src:q, type:q.type, topic:q.topic, ref:q.ref||""};
  if(q.type==="mcq" || q.type==="calc"){
    let base;
    if(typeof q.gen === "function"){
      base = dedupeBase(q.gen()); // سؤال ديناميكي بأرقام عشوائية
    } else {
      base = {q:q.q, opts:q.opts, a:q.a, expl:q.expl};
    }
    inst.q = base.q; inst.expl = base.expl;
    let order = base.opts.map((_,i)=>i);
    if(CONFIG.shuffleChoices) order = shuffle(order);
    inst.opts = order.map(i=>base.opts[i]);
    inst.correct = order.indexOf(base.a);
  } else if(q.type==="tf"){
    inst.q = q.q; inst.expl = q.expl;
    inst.opts = ["صحيحة ✓","خاطئة ✗"];
    inst.correct = q.a ? 0 : 1;
  } else if(q.type==="fill"){
    inst.q = q.q; inst.expl = q.expl;
    inst.answers = q.answers;
  } else if(q.type==="match"){
    inst.q = q.q; inst.expl = q.expl;
    inst.left = q.left;
    inst.right = q.right;
    let order = q.right.map((_,i)=>i);
    if(CONFIG.shuffleChoices) order = shuffle(order);
    inst.rightShuffled = order.map(i=>q.right[i]);
    // لكل عنصر يسار: موقع الإجابة الصحيحة داخل القائمة المخلوطة
    inst.correctMap = q.right.map((r,i)=> order.indexOf(i));
  }
  return inst;
}

/* =====================================================
   الشاشات
   ===================================================== */
function show(id){
  ["screen-dash","screen-exam","screen-result","screen-review"].forEach(s=>{
    $("#"+s).classList.toggle("hidden", s!==id);
  });
  window.scrollTo({top:0});
}

/* ---------------- لوحة البداية ---------------- */
function renderDash(){
  $("#d-course").textContent = CONFIG.courseTitle;
  $("#d-instructor").textContent = CONFIG.instructor;
  $("#d-chapter").textContent = CONFIG.chapterName;
  $("#d-bank").textContent = QUESTION_BANK.length;
  $("#d-qn").textContent = CONFIG.examQuestions;
  $("#d-dur").textContent = CONFIG.examDuration + " دقيقة";
  $("#d-pass").textContent = CONFIG.passingGrade + "%";

  const st = loadStore();
  const el = $("#d-progress");
  if(st.attempts.length){
    const best = Math.max(...st.attempts.map(a=>a.pct));
    const avg = Math.round(st.attempts.reduce((s,a)=>s+a.pct,0)/st.attempts.length);
    const totalMin = Math.round(st.attempts.reduce((s,a)=>s+a.usedSec,0)/60);
    el.innerHTML = "المحاولات السابقة: <b>"+st.attempts.length+"</b> • أعلى درجة: <b>"+best+"%</b> • المتوسط: <b>"+avg+"%</b> • إجمالي وقت التدريب: <b>"+totalMin+" دقيقة</b>";
    $("#btn-clear").classList.remove("hidden");
  } else {
    el.textContent = "لا توجد محاولات سابقة — ابدأ أول اختبار لك الآن!";
    $("#btn-clear").classList.add("hidden");
  }
  show("screen-dash");
}

/* ---------------- شاشة الاختبار ---------------- */
function startExam(){
  exam = buildExam();
  $("#palette").innerHTML = exam.questions.map((_,i)=>
    '<button class="pal" data-i="'+i+'">'+(i+1)+"</button>").join("");
  startTimer();
  renderQuestion();
  show("screen-exam");
}

function startTimer(){
  updateTimer();
  exam.timerId = setInterval(()=>{
    exam.remaining--;
    updateTimer();
    if(exam.remaining<=0){
      clearInterval(exam.timerId);
      submitExam(true);
    }
  },1000);
}
function updateTimer(){
  const t = $("#timer");
  t.textContent = fmtTime(Math.max(0,exam.remaining));
  t.classList.toggle("low", exam.remaining<=300);
}

function renderQuestion(){
  const i = exam.idx, q = exam.questions[i], ans = exam.answers[i];
  $("#qcount").textContent = "السؤال "+(i+1)+" من "+exam.questions.length;
  $("#pbar").style.width = (exam.answers.filter(a=>a!==null).length / exam.questions.length * 100)+"%";
  $("#qmeta").innerHTML =
    '<span class="chip type">'+TYPE_NAMES[q.type]+'</span>'+
    '<span class="chip">'+esc(CONFIG.topics[q.topic]||"")+'</span>';
  $("#qtext").textContent = q.q;

  const box = $("#qbody");
  if(q.type==="fill"){
    box.innerHTML = '<input class="fillin" id="fillin" type="text" inputmode="text" placeholder="اكتب إجابتك هنا..." value="'+(ans!==null?esc(ans):"")+'">';
    $("#fillin").addEventListener("input", e=>{
      exam.answers[i] = e.target.value.trim()===""? null : e.target.value.trim();
      refreshPalette();
    });
  } else if(q.type==="match"){
    box.innerHTML = q.left.map((l,li)=>{
      const sel = ans && ans[li]!==undefined && ans[li]!==null ? ans[li] : -1;
      return '<div class="match-row"><div class="mleft">'+esc(l)+'</div>'+
        '<select data-li="'+li+'"><option value="-1">— اختر —</option>'+
        q.rightShuffled.map((r,ri)=>'<option value="'+ri+'"'+(sel===ri?" selected":"")+'>'+esc(r)+"</option>").join("")+
        "</select></div>";
    }).join("");
    box.querySelectorAll("select").forEach(sel=>{
      sel.addEventListener("change", ()=>{
        const cur = exam.answers[i] || q.left.map(()=>null);
        const v = parseInt(sel.value,10);
        cur[parseInt(sel.dataset.li,10)] = v<0? null : v;
        exam.answers[i] = cur.every(x=>x===null)? null : cur;
        refreshPalette();
      });
    });
  } else {
    box.innerHTML = '<div class="opts">'+q.opts.map((o,oi)=>
      '<div class="opt'+(ans===oi?" selected":"")+'" data-oi="'+oi+'">'+
      '<span class="letter">'+LETTERS[oi]+"</span><span>"+esc(o)+"</span></div>").join("")+"</div>";
    box.querySelectorAll(".opt").forEach(el=>{
      el.addEventListener("click", ()=>{
        exam.answers[i] = parseInt(el.dataset.oi,10);
        renderQuestion(); refreshPalette();
      });
    });
  }

  $("#btn-prev").disabled = i===0;
  $("#btn-next").textContent = i===exam.questions.length-1 ? "إنهاء ➜" : "التالي ⬅";
  const bf = $("#btn-flag");
  bf.classList.toggle("flagged", exam.flags[i]);
  bf.textContent = exam.flags[i] ? "★ معلَّم" : "☆ للمراجعة";
  refreshPalette();
}

function refreshPalette(){
  document.querySelectorAll(".pal").forEach((b,bi)=>{
    b.className = "pal"
      + (exam.answers[bi]!==null ? " answered":"")
      + (exam.flags[bi] ? " flagged":"")
      + (bi===exam.idx ? " current":"");
  });
  $("#pbar").style.width = (exam.answers.filter(a=>a!==null).length / exam.questions.length * 100)+"%";
}

function go(delta){
  const ni = exam.idx + delta;
  if(ni < 0) return;
  if(ni >= exam.questions.length){ confirmSubmit(); return; }
  exam.idx = ni; renderQuestion();
}

/* ---------------- التصحيح ---------------- */
function gradeOne(q, ans){
  if(ans===null || ans===undefined) return {status:"skip", pts:0};
  if(q.type==="fill"){
    const ok = q.answers.some(a => normalizeAns(a)===normalizeAns(ans));
    return {status: ok?"ok":"bad", pts: ok?1:0};
  }
  if(q.type==="match"){
    let c=0;
    q.correctMap.forEach((m,li)=>{ if(ans[li]===m) c++; });
    const all = c===q.correctMap.length;
    if(ans.every(x=>x===null)) return {status:"skip", pts:0};
    return {status: all?"ok": (c>0?"partial":"bad"), pts: c/q.correctMap.length};
  }
  const ok = ans === q.correct;
  return {status: ok?"ok":"bad", pts: ok?1:0};
}

function submitExam(auto){
  clearInterval(exam.timerId);
  const usedSec = CONFIG.examDuration*60 - Math.max(0,exam.remaining);
  let pts=0, correct=0, wrong=0, skipped=0;
  const topicAgg = {};
  const detail = exam.questions.map((q,i)=>{
    const g = gradeOne(q, exam.answers[i]);
    pts += g.pts;
    if(g.status==="skip") skipped++;
    else if(g.pts===1) correct++;
    else wrong++;
    const t = topicAgg[q.topic] = topicAgg[q.topic]||{got:0,total:0};
    t.got += g.pts; t.total += 1;
    return g;
  });
  const pct = Math.round(pts / exam.questions.length * 100);
  lastResult = {
    pct, correct, wrong, skipped, usedSec, auto:!!auto,
    pass: pct >= CONFIG.passingGrade,
    topicAgg, detail,
    questions: exam.questions,
    answers: exam.answers
  };
  const st = loadStore();
  st.attempts.push({date:new Date().toISOString(), pct, usedSec, correct, wrong, skipped});
  if(st.attempts.length>100) st.attempts = st.attempts.slice(-100);
  saveStore(st);
  renderResult();
  show("screen-result");
}

function renderResult(){
  const r = lastResult;
  const ring = $("#score-ring");
  ring.style.background = "conic-gradient("+(r.pass?"var(--ok)":"var(--bad)")+" "+(r.pct*3.6)+"deg, var(--border) 0deg)";
  $("#score-inner").innerHTML =
    '<div class="pct">'+r.pct+'%</div><div class="verdict">'+(r.pass?"ناجح ✓":"راسب ✗")+"</div>";
  $("#score-inner").parentElement.style.color = "var(--text)";
  $("#r-auto").classList.toggle("hidden", !r.auto);
  $("#r-correct").textContent = r.correct;
  $("#r-wrong").textContent = r.wrong;
  $("#r-skip").textContent = r.skipped;
  $("#r-time").textContent = fmtTime(r.usedSec);

  $("#topic-perf").innerHTML = Object.keys(r.topicAgg).map(t=>{
    const a = r.topicAgg[t];
    const p = Math.round(a.got/a.total*100);
    return '<div class="topicbar"><div class="tname"><span>'+esc(CONFIG.topics[t]||t)+
      '</span><span>'+p+'%</span></div><div class="tbar"><div style="width:'+p+'%;background:'+
      (p>=CONFIG.passingGrade?"var(--ok)":"var(--bad)")+'"></div></div></div>';
  }).join("");
}

/* ---------------- المراجعة ---------------- */
function renderReview(){
  const r = lastResult;
  $("#review-list").innerHTML = r.questions.map((q,i)=>{
    const g = r.detail[i], ans = r.answers[i];
    const badge = g.status==="ok" ? '<span class="badge ok">إجابة صحيحة</span>'
                : g.status==="skip" ? '<span class="badge skip">لم تتم الإجابة</span>'
                : g.status==="partial" ? '<span class="badge skip">إجابة جزئية</span>'
                : '<span class="badge bad">إجابة خاطئة</span>';
    let body="";
    if(q.type==="fill"){
      body = '<div class="opts">'+
        '<div class="opt '+(g.status==="ok"?"correct":"wrong")+'"><span>إجابتك: '+(ans!==null?esc(ans):"—")+"</span></div>"+
        '<div class="opt correct"><span>الإجابة الصحيحة: '+esc(q.answers[0])+"</span></div></div>";
    } else if(q.type==="match"){
      body = q.left.map((l,li)=>{
        const sel = ans && ans[li]!==null && ans[li]!==undefined ? ans[li] : null;
        const okm = sel===q.correctMap[li];
        return '<div class="match-row"><div class="mleft">'+esc(l)+'</div>'+
          '<div class="opt '+(okm?"correct":"wrong")+'" style="flex:1"><span>'+
          (sel!==null? esc(q.rightShuffled[sel]) : "—")+
          (okm? "" : ' <b style="color:var(--ok)">(الصحيح: '+esc(q.rightShuffled[q.correctMap[li]])+")</b>")+
          "</span></div></div>";
      }).join("");
    } else {
      body = '<div class="opts">'+q.opts.map((o,oi)=>{
        let cls="opt";
        if(oi===q.correct) cls+=" correct";
        else if(oi===ans) cls+=" wrong";
        return '<div class="'+cls+'"><span class="letter">'+LETTERS[oi]+"</span><span>"+esc(o)+"</span></div>";
      }).join("")+"</div>";
    }
    return '<div class="card review-item">'+
      '<div class="qmeta"><span class="chip">س'+(i+1)+'</span><span class="chip type">'+TYPE_NAMES[q.type]+'</span>'+badge+'</div>'+
      '<div class="qtext">'+esc(q.q)+"</div>"+body+
      '<div class="explain"><b>الشرح:</b> '+esc(q.expl)+
      '<div class="refline">📖 المرجع: '+esc(q.ref)+" — "+esc(CONFIG.topics[q.topic]||"")+"</div></div></div>";
  }).join("");
  show("screen-review");
}

/* ---------------- التأكيد والمودالات ---------------- */
function confirmSubmit(){
  const un = exam.answers.filter(a=>a===null).length;
  $("#m-text").textContent = un>0
    ? "لديك "+un+" سؤالًا بدون إجابة. هل تريد إنهاء الاختبار وتسليمه؟"
    : "هل أنت متأكد من إنهاء الاختبار وتسليمه؟";
  $("#modal").classList.remove("hidden");
}

/* ---------------- الوضع الليلي ---------------- */
function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  $("#btn-theme").textContent = t==="dark" ? "☀️" : "🌙";
  try{ localStorage.setItem("taxExamTheme", t); }catch(e){}
}

/* ---------------- الربط ---------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  applyTheme(localStorage.getItem("taxExamTheme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark":"light"));
  renderDash();

  $("#btn-theme").addEventListener("click", ()=>{
    applyTheme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark");
  });
  $("#btn-start").addEventListener("click", startExam);
  $("#btn-clear").addEventListener("click", ()=>{
    if(confirm("هل تريد مسح سجل المحاولات السابقة؟")){ saveStore({attempts:[]}); renderDash(); }
  });
  $("#btn-prev").addEventListener("click", ()=>go(-1));
  $("#btn-next").addEventListener("click", ()=>go(1));
  $("#btn-skip").addEventListener("click", ()=>{ if(exam.idx<exam.questions.length-1) go(1); else confirmSubmit(); });
  $("#btn-flag").addEventListener("click", ()=>{
    exam.flags[exam.idx] = !exam.flags[exam.idx]; renderQuestion();
  });
  $("#btn-submit").addEventListener("click", confirmSubmit);
  $("#m-cancel").addEventListener("click", ()=> $("#modal").classList.add("hidden"));
  $("#m-ok").addEventListener("click", ()=>{ $("#modal").classList.add("hidden"); submitExam(false); });
  $("#palette").addEventListener("click", e=>{
    const b = e.target.closest(".pal");
    if(b){ exam.idx = parseInt(b.dataset.i,10); renderQuestion(); }
  });
  $("#btn-review").addEventListener("click", renderReview);
  $("#btn-retry").addEventListener("click", startExam);
  $("#btn-home").addEventListener("click", renderDash);
  $("#btn-back-result").addEventListener("click", ()=>show("screen-result"));

  // تحذير عند محاولة مغادرة الصفحة أثناء الاختبار
  window.addEventListener("beforeunload", (e)=>{
    if(exam && exam.timerId && !$("#screen-exam").classList.contains("hidden")){
      e.preventDefault(); e.returnValue = "";
    }
  });
});
