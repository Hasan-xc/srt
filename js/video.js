/**
 * video.js — مشغل الفيديو والمزامنة ثنائية الاتجاه
 *
 * المسؤولية:
 *  - تحميل الفيديو المرفوع وعرض المشغل
 *  - مزامنة الترجمة مع زمن التشغيل (throttle ~14fps + بحث O(1) — المرحلة السابقة)
 *  - معالجة أحداث الشبكة/البفرينج (stalled/waiting/canplay/error) لمنع التجمد
 *  - أنيميشن مركزية عند التشغيل/الإيقاف (Ripple ~350ms)
 *  - شريط تقدم لمسي كامل: pointerdown/move/up + setPointerCapture
 *    مع معاينة حية (Live Scrubbing) وقفز نهائي عند الإفلات
 *  - أزرار التشغيل/التخطي/الإغلاق + تمييز السطر النشط
 */

import { state } from './state.js';
import { parseTimeStringToMs } from './time.js';

/* ════════════════════════════════════════════════════════════════
   حالة مزامنة خفيفة (Anti-Freeze)
   - throttle عبر requestAnimationFrame بحد ~14 مرة/ثانية بدل كل إطار
   - بحث السطر النشط O(1) من موقع آخر سطر بدل O(N) في كل نبضة
   - كتابة DOM فقط عند حدوث تغيير فعلي (نص/نسبة/سطر نشط)
════════════════════════════════════════════════════════════════ */
const SYNC_MIN_INTERVAL = 70;  // ms → ~14 تحديثاً كحد أقصى في الثانية
let syncIndex = 0;             // مؤشر آخر سطر تم التعامل معه (اختصار البحث)
let lastSubText = null;        // آخر نص عرضه الـ overlay
let lastPct = -1;              // آخر نسبة تقدم مكتوبة (تفادي style thrash)
let lastHlId = null;           // آخر سطر مُميّز (التمرير عند التغيّر فقط)
let rafPending = false;
let lastSyncT = 0;
let scrubbing = false;         // هل المستخدم يسحب شريط التقدم الآن؟

/** إعادة ضبط حالة المزامنة عند تحميل فيديو جديد */
function resetSyncState(){
  syncIndex = 0; lastSubText = null; lastPct = -1; lastHlId = null;
}

/**
 * مزامنة واحدة (تُستدعى مقيدة الإيقاع): مؤقت + شريط تقدم + overlay + تمييز.
 * البحث عن السطر النشط من syncIndex للأمام/الخلف — O(1) مُستهلك.
 * @param {HTMLVideoElement} v
 * @param {object} [opts] خيارات داخلية: { seekPreview: pct } أثناء السحب اللمسي
 *   يعرض وقت ومعاينة الترجمة للنقطة المشار إليها دون المساس بموقع التشغيل الحقيقي.
 */
export function syncVideoSubs(v, opts = {}){
  const scrubPct = (typeof opts.seekPreview === 'number') ? opts.seekPreview : null;
  const ct = v.currentTime || 0;

  // ── المؤقت وشريط التقدم: كتابة فقط عند تغيّر النسبة فعلياً ──
  if(v.duration && isFinite(v.duration) && v.duration > 0){
    const pct = Math.round((ct / v.duration) * 10000) / 100;
    if(pct !== lastPct){
      lastPct = pct;
      const timerOv = document.getElementById('timerOv');
      const fill = document.getElementById('progFill');
      const thumb = document.getElementById('progThumb');
      if(timerOv) timerOv.textContent = new Date(ct * 1000).toISOString().substr(11, 8);
      if(fill) fill.style.width = pct + '%';
      if(thumb) thumb.style.left = pct + '%';
    }
  }

  // أثناء السحب اللمسي: المعاينة تُدار في previewSubAt() — لا شيء إضافي هنا

  // ── السطر النشط: بحث مجاور O(1) من آخر موقع معروف ──
  const blocks = state.blocks;
  if(blocks.length === 0){
    syncIndex = 0;
  } else {
    if(syncIndex >= blocks.length) syncIndex = blocks.length - 1;
    if(syncIndex < 0) syncIndex = 0;
    const startOf = (i) => parseTimeStringToMs(blocks[i].start) / 1000;

    if(startOf(syncIndex) > ct){
      // قفز للخلف (رجوع/seek): نمسح للخلف من الموقع الحالي فقط
      while(syncIndex > 0 && startOf(syncIndex) > ct) syncIndex--;
    } else {
      // التشغيل الطبيعي: تقدم للأمام حتى حدود الزمن الحالي
      while(syncIndex < blocks.length - 1 && startOf(syncIndex + 1) <= ct) syncIndex++;
    }
  }

  const b = blocks[syncIndex];
  const active = (b
    && parseTimeStringToMs(b.start) / 1000 <= ct
    && ct <= parseTimeStringToMs(b.end) / 1000) ? b : null;

  // ── overlay الترجمة: كتابة فقط عند تغيّر النص فعلياً ──
  const subDom = document.getElementById('subTextDom');
  if(subDom){
    const txt = (active && active.text.trim()) ? active.text : '';
    if(txt !== lastSubText){
      lastSubText = txt;
      subDom.textContent = txt;
      subDom.style.display = txt ? 'inline-block' : 'none';
    }
  }

  // ── تمييز + تمرير: فقط عند تغيّر السطر الفعلي (وليس كل نبضة) ──
  if(active && active.id !== lastHlId){
    lastHlId = active.id;
    highlightAndScrollRow(active.id);
  }
}

/* ════════════════════════════════════════════════════════════════
   الأنيميشن المركزية (Ripple): ▶ عند الإيقاف / ⏸ عند الاستئناف
════════════════════════════════════════════════════════════════ */
let rippleTimer = null;
function showCenterRipple(icon){
  const el = document.getElementById('centerRipple');
  if(!el) return;
  const ico = document.getElementById('centerRippleIco');
  if(ico) ico.textContent = icon;
  el.classList.remove('go');
  void el.offsetWidth; // إعادة تشغيل الأنيميشن
  el.classList.add('go');
  clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => el.classList.remove('go'), 380);
}

/**
 * تشغيل/إيقاف مع أنيميشن مركزية — نفس نقطة الدخول القديمة togglePlay.
 */
export function togglePlay(){
  const v = document.getElementById('mainVideo');
  if(!v) return;
  // الحماية الأصلية كانت !v.src لكن بعض بيئات الاختبار/المتصفحات
  // تدير الوسائط بلا src نصي (Blob) — نعتمد readyState بدلها
  if(!v.src && !v.readyState) return;
  if(v.paused){
    try { const pr = v.play(); if(pr && pr.catch) pr.catch(() => {}); } catch(_){}
    showCenterRipple('▶');
  } else {
    v.pause();
    showCenterRipple('⏸');
  }
}

/* ════════════════════════════════════════════════════════════════
   معالجات الشبكة/البفرينج: عرض حالة + منع أي تجمد صامت
════════════════════════════════════════════════════════════════ */
function bufferStatus(msg, show = true){
  const el = document.getElementById('vidBufferNote');
  if(!el) return;
  el.textContent = msg;
  el.style.display = show ? 'block' : 'none';
}

function attachBufferHandlers(v){
  v.addEventListener('stalled', () => bufferStatus('⏳ الشبكة بطيئة — جاري التحميل...'));
  v.addEventListener('waiting', () => bufferStatus('⏳ جاري التحميل (بفرينج)...'));
  v.addEventListener('canplay', () => bufferStatus('', false));
  v.addEventListener('playing', () => bufferStatus('', false));
  v.addEventListener('error', () => {
    bufferStatus('⚠️ تعذر تشغيل الملف — جرّب صيغة MP4 (H.264)', true);
  });
  // حماية إضافية: لو توقف اللاعب رغم وجود بيانات (مشكلة متصفحات الموبايل)
  v.addEventListener('timeupdate', () => { v.__lastT = performance.now(); });
  setIntervalGuard(v);
}

let guardTimer = null;
/**
 * مراقب خفيف (كل 3 ثوانٍ فقط): إن كان اللاعب "يشغّل" لكن الزمن لا يتقدم
 * منذ 3 ثوانٍ → محاولة play() واحدة لتحفيز المتصفح (حالة متصفحات الهاتف).
 */
function setIntervalGuard(v){
  clearInterval(guardTimer);
  let lastSeen = -1, stalls = 0;
  guardTimer = setInterval(() => {
    if(v.paused || !v.src) { stalls = 0; lastSeen = -1; return; }
    const t = v.currentTime;
    if(t === lastSeen){
      stalls++;
      if(stalls >= 2){ // زمن ثابت ~6 ثوانٍ
        v.play().catch(() => {});
        stalls = 0;
      }
    } else {
      stalls = 0;
    }
    lastSeen = t;
  }, 3000);
}

/* ════════════════════════════════════════════════════════════════
   الشريط اللمسي (Fluid Touch Scrubber)
   - pointerdown: بدء السحب + setPointerCapture + معاينة فورية
   - pointermove: تحديث المؤشر والوقت ومعاينة الترجمة بنعومة (بلا قفز فيديو)
   - pointerup: القفز الفعلي مرة واحدة (سلاسة تامة بلا تقطيع)
════════════════════════════════════════════════════════════════ */
let scrubPct = null; // نسبة السحب الحالية (null = لا سحب جارٍ)

function pctFromEvent(e, wrap){
  const rect = wrap.getBoundingClientRect();
  const x = (e.clientX != null) ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX) || 0;
  return Math.min(1, Math.max(0, (x - rect.left) / Math.max(1, rect.width)));
}

function paintScrubPreview(pct, v){
  const fill = document.getElementById('progFill');
  const thumb = document.getElementById('progThumb');
  const p = Math.round(pct * 10000) / 100;
  if(fill) fill.style.width = p + '%';
  if(thumb) thumb.style.left = p + '%';
  const timerOv = document.getElementById('timerOv');
  if(timerOv && v.duration) timerOv.textContent = new Date(pct * v.duration * 1000).toISOString().substr(11, 8);
}

function previewSubAt(pct, v){
  if(!v.duration) return;
  const ms = pct * v.duration * 1000;
  const b = state.blocks.find(x =>
    parseTimeStringToMs(x.start) <= ms && ms <= parseTimeStringToMs(x.end));
  const subDom = document.getElementById('subTextDom');
  if(!subDom) return;
  const txt = (b && b.text.trim()) ? b.text : '';
  subDom.textContent = txt || '';
  subDom.style.display = txt ? 'inline-block' : 'none';
}

function attachScrubber(v){
  const wrap = document.getElementById('progWrap');
  if(!wrap) return;

  wrap.addEventListener('pointerdown', (e) => {
    if(!v.duration) return;
    scrubbing = true;
    try { wrap.setPointerCapture(e.pointerId); } catch(_){}
    scrubPct = pctFromEvent(e, wrap);
    paintScrubPreview(scrubPct, v);
    previewSubAt(scrubPct, v);
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => {
    if(scrubPct == null) return;
    scrubPct = pctFromEvent(e, wrap);
    paintScrubPreview(scrubPct, v);
    previewSubAt(scrubPct, v);
    e.preventDefault();
  });
  // الإفلات يُستمع له على window (نمط السحب القياسي): يعمل حتى لو
  // خرج الإصبع من حدود الشريط، ولا يتأثر بسلوك setPointerCapture
  const finish = (e) => {
    if(scrubPct == null) return;
    // استخدم آخر نسبة محفوظة أثناء السحب (وليس إحداثيات الحدث الأخير
    // التي قد تختلف على الأجهزة اللمسية) — ثم القفز مرة واحدة
    const pct = scrubPct;
    scrubPct = null;
    try { v.currentTime = pct * (v.duration || 0); } catch(_){}
    // إعادة مزامنة فورية بعد القفز (بدل انتظار timeupdate التالي)
    requestAnimationFrame(() => syncVideoSubs(v));
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', () => { scrubPct = null; });
}

/**
 * ربط أحداث المشغل على عنصر فيديو معين — مُصدَّرة لأغراض الاختبار
 * والاستخدام المباشر (تُستدعى تلقائياً بعد رفع الفيديو).
 */
export function attachPlayerControls(v){
  attachBufferHandlers(v);
  attachScrubber(v);
  v.addEventListener('pause', () => { if(!v.ended) showCenterRipple('⏸'); });
  v.addEventListener('play',  () => showCenterRipple('▶'));
}

/**
 * يربط مستمع change لحقل رفع الفيديو.
 * يُستدعى مرة واحدة من main.js عند بدء التشغيل.
 */
export function initVideoEvents(){
  document.getElementById('vidFileIn').addEventListener('change', function(){
    if(state.videoURL) URL.revokeObjectURL(state.videoURL);
    state.videoURL = URL.createObjectURL(this.files[0]);
    const v = document.getElementById('mainVideo');
    v.src = state.videoURL; v.load();
    resetSyncState();
    document.getElementById('vidDrop').style.display = 'none';
    document.getElementById('playerWrap').style.display = 'block';

    attachPlayerControls(v);

    // timeupdate يصل بمعدل مرتفع جداً على الهواتف — نقيد الإيقاع عبر
    // requestAnimationFrame + حد زمني أدنى (~14 مرة/ثانية) بدل معالجة كل إطار
    v.addEventListener('timeupdate', () => {
      if(rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const now = performance.now();
        if(now - lastSyncT < SYNC_MIN_INTERVAL) return;
        lastSyncT = now;
        syncVideoSubs(v);
      });
    });
  });
}

export function skipVid(s){ const v = document.getElementById('mainVideo'); if(!v || !v.src) return; v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + s)); }

export function removeVideo(){
  const v = document.getElementById('mainVideo'); v.pause(); v.src = '';
  clearInterval(guardTimer);
  resetSyncState();
  document.getElementById('vidDrop').style.display = 'flex';
  document.getElementById('playerWrap').style.display = 'none';
}

export function showVidSec(){
  document.getElementById('vidUploadBar').style.display = 'none';
  document.getElementById('vidSec').style.display = 'block';
}

/**
 * يقفز بالفيديو إلى بداية سطر محدد ويشغّله.
 * @param {number} id معرّف السطر
 */
export function jumpToBlock(id){
  const b = state.blocks.find(x => x.id === id);
  if(!b) return;
  const v = document.getElementById('mainVideo');
  const sec = parseTimeStringToMs(b.start) / 1000;
  if(v && v.src) {
    v.currentTime = sec;
    v.play();
  }
  highlightAndScrollRow(id, true);
  document.querySelectorAll('.row-dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

/**
 * يفعّل السطر المحدد ويمرره إلى داخل نطاق الرؤية في المحرر.
 * @param {number} id معرّف السطر
 * @param {boolean} forced تجاوز فحص "السطر النشط حالياً"
 */
export function highlightAndScrollRow(id, forced=false){
  if(state.activeRowId === id && !forced) return;
  state.activeRowId = id;
  document.querySelectorAll('.srt-card').forEach(r => r.classList.remove('active-row'));
  const row = document.getElementById('row-' + id);
  if(row) {
    row.classList.add('active-row');
    // تمرير خفيف: فقط إذا كان السطر خارج نطاق الرؤية (بدون Reflow متكرر)
    const rect = row.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const visible = rect.top >= 0 && rect.bottom <= vh;
    if(!visible) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
