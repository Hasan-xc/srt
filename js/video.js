/**
 * video.js — مشغل الفيديو والمزامنة ثنائية الاتجاه
 *
 * المسؤولية:
 *  - تحميل الفيديو المرفوع وعرض المشغل
 *  - مزامنة الترجمة مع زمن تشغيل الفيديو (overlay)
 *  - أزرار التشغيل/التخطي/الإغلاق
 *  - تمييز السطر النشط أثناء التشغيل (highlightAndScrollRow)
 *  - تحديث شريط التقدم والمؤقت
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

/** إعادة ضبط حالة المزامنة عند تحميل فيديو جديد */
function resetSyncState(){
  syncIndex = 0; lastSubText = null; lastPct = -1; lastHlId = null;
}

/**
 * مزامنة واحدة (تُستدعى مقيدة الإيقاع): مؤقت + شريط تقدم + overlay + تمييز.
 * البحث عن السطر النشط من syncIndex للأمام/الخلف — O(1) مُستهلك.
 */
export function syncVideoSubs(v){
  const ct = v.currentTime || 0;

  // ── المؤقت وشريط التقدم: كتابة فقط عند تغيّر النسبة فعلياً ──
  const timerOv = document.getElementById('timerOv');
  if(timerOv) timerOv.textContent = new Date(ct * 1000).toISOString().substr(11, 8);
  if(v.duration && isFinite(v.duration) && v.duration > 0){
    const pct = Math.round((ct / v.duration) * 10000) / 100;
    if(pct !== lastPct){
      lastPct = pct;
      const fill = document.getElementById('progFill');
      const thumb = document.getElementById('progThumb');
      if(fill) fill.style.width = pct + '%';
      if(thumb) thumb.style.left = pct + '%';
    }
  }

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

export function togglePlay(){ const v = document.getElementById('mainVideo'); v.paused ? v.play() : v.pause(); }

export function skipVid(s){ const v = document.getElementById('mainVideo'); if(!v || !v.src) return; v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + s)); }

export function removeVideo(){
  const v = document.getElementById('mainVideo'); v.pause(); v.src = '';
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
