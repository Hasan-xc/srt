/**
 * editor.js — محرر SRT (واجهة البطاقات + القائمة الزجاجية)
 *
 * المسؤولية:
 *  - رسم أسطر الترجمة كبطاقات (renderCards)
 *  - تعديل النص والتوقيتات لكل سطر (inline editing)
 *  - العمليات على السطر الواحد: حذف، إضافة، تقسيم، دمج
 *  - العمليات على الكل: إزاحة التوقيتات، بحث واستبدال، تنزيل SRT
 *  - القائمة المنسدلة (3 نقاط) وتفعيل السطر النشط
 */

import { state } from './state.js';
import { formatMs, parseTimeStringToMs, fmtTimeShort, toStandardTime } from './time.js';
import { toast } from './ui.js';
import { updateSubOverlayLive } from './styling.js';
import { scheduleAutosave } from './autosave.js';
import { captureHistory, scheduleTextCapture } from './history.js';

/* ════════════════════════════════════════════════════════════════
   شارات سرعة القراءة (CPS) وطول السطر (CPL) — معايير الترجمة العالمية
   - CPS = عدد الأحرف ÷ مدة الظهور بالثواني: أخضر <17، أصفر 17-21، أحمر >21
   - CPL: تنبيه فقط إذا تجاوز أي سطر داخلي 42 حرفاً
   - الحساب عند الرسم فقط + debounce عند تعديل النص — صفر معالجة أثناء التشغيل
════════════════════════════════════════════════════════════════ */
const CPS_EASY = 17, CPS_HARD = 21, CPL_MAX = 42;
const badgeTimers = new Map();   // id → مؤقت debounce لكل بطاقة

function cpsClass(cps){
  if(cps < CPS_EASY) return 'cps-ok';
  if(cps <= CPS_HARD) return 'cps-mid';
  return 'cps-fast';
}

/** يحدّث شارة CPS/CPL لبطاقة واحدة (قراءة DOM محصورة داخل البطاقة) */
export function updateRowBadge(id){
  const b = state.blocks.find(x => x.id === id);
  const el = document.getElementById('cps-' + id);
  if(!b || !el) return;
  const durSec = (parseTimeStringToMs(b.end) - parseTimeStringToMs(b.start)) / 1000;
  const chars = (b.text || '').replace(/\s+/g, ' ').trim().length;
  const cps = (durSec > 0.3 && chars > 0) ? Math.round(chars / durSec) : null;
  const maxLine = (b.text || '').split('\n').reduce((m, l) => Math.max(m, l.trim().length), 0);
  const cplOver = maxLine > CPL_MAX;
  if(cps === null){
    el.textContent = '⚡ —';
    el.className = 'cps-badge';
    el.title = 'سرعة القراءة غير محسوبة (مدة/نص غير صالح)';
  } else {
    el.textContent = '⚡' + cps + (cplOver ? ' ↵' + maxLine : '');
    el.className = 'cps-badge ' + cpsClass(cps);
    el.title = `سرعة القراءة: ${cps} حرف/ثانية (${cps < CPS_EASY ? 'مريح ✅' : cps <= CPS_HARD ? 'مقبول ⚠️' : 'سريع جداً ❌'})`
      + (cplOver ? ` — سطر طويل (${maxLine} حرفاً > ${CPL_MAX}) يُفضل تقسيمه` : '');
  }
}

/** debounce خفيف لتحديث شارة البطاقة عند انتهاء تعديل النص */
function scheduleBadgeUpdate(id){
  clearTimeout(badgeTimers.get(id));
  badgeTimers.set(id, setTimeout(() => { badgeTimers.delete(id); updateRowBadge(id); }, 500));
}

/* ════════════════════════════════════════════════════════════════
   CLEAN CARDS RENDERING (WITH GLASS 3-DOTS MENU)
══════════════════════════════════════════════════════════════ */

export function renderCards(){
  const container = document.getElementById('subListContainer');
  container.innerHTML = '';

  state.blocks.forEach((b, idx) => {
    const card = document.createElement('div');
    card.className = 'srt-card';
    card.id = 'row-' + b.id;
    if(state.activeRowId === b.id) card.classList.add('active-row');

    card.innerHTML = `
      <div class="srt-card-head">
        <div class="head-right">
          <span class="row-num-badge">#${idx + 1}</span>
          <span class="cps-badge" id="cps-${b.id}">⚡ —</span>
          <div class="row-menu-wrap">
            <button class="menu-dots-btn" onclick="toggleRowMenu(event, ${b.id})" title="خيارات">⋮</button>
            <div class="row-dropdown-menu" id="menu-${b.id}">
              <button onclick="jumpToBlock(${b.id})"><span>▶️</span> تشغيل من هنا</button>
              <button onclick="addNewBlockAfter(${b.id})"><span>➕</span> إضافة سطر تالٍ</button>
              <button onclick="splitBlock(${b.id})"><span>✂️</span> تقسيم السطر</button>
              <button onclick="mergeWithNext(${b.id})"><span>🔗</span> دمج مع التالي</button>
              <div class="menu-divider"></div>
              <button class="menu-del-btn" onclick="delBlock(${b.id})"><span>🗑️</span> حذف السطر</button>
            </div>
          </div>
        </div>

        <div class="head-left">
          <div class="micro-time-box">
            <button class="m-step" onclick="stepBlockTime(${b.id}, 'start', -100)" title="-100ms">-</button>
            <input type="text" class="m-time-in" value="${fmtTimeShort(b.start)}" onchange="onTimeInputChange(${b.id}, 'start', this)">
            <button class="m-step" onclick="stepBlockTime(${b.id}, 'start', 100)" title="+100ms">+</button>
          </div>
          <span class="time-arrow">→</span>
          <div class="micro-time-box">
            <button class="m-step" onclick="stepBlockTime(${b.id}, 'end', -100)" title="-100ms">-</button>
            <input type="text" class="m-time-in" value="${fmtTimeShort(b.end)}" onchange="onTimeInputChange(${b.id}, 'end', this)">
            <button class="m-step" onclick="stepBlockTime(${b.id}, 'end', 100)" title="+100ms">+</button>
          </div>
        </div>
      </div>

      <div class="srt-card-body">
        <textarea class="inline-ta" id="ta-${b.id}" oninput="onTextInput(${b.id}, this)" onclick="onRowClick(${b.id})">${escapeHtml(b.text || '')}</textarea>
      </div>
    `;
    container.appendChild(card);

    setTimeout(() => autoResizeTa(document.getElementById(`ta-${b.id}`)), 0);
    updateRowBadge(b.id);
  });

  // نقاط ربط الميزات الإضافية (سجل التراجع + الحفظ التلقائي) — فشلها صامت
  try { captureHistory(); scheduleAutosave(); } catch(_) {}

  checkTrReady();
}

export function toggleRowMenu(event, id) {
  event.stopPropagation();
  const currentMenu = document.getElementById('menu-' + id);
  const isOpen = currentMenu.classList.contains('show');

  // إغلاق باقي القوائم أولاً
  document.querySelectorAll('.row-dropdown-menu.show').forEach(m => m.classList.remove('show'));

  if (!isOpen) {
    currentMenu.classList.add('show');
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function autoResizeTa(el) {
  if(!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(36, el.scrollHeight) + 'px';
}

/* ═══════════════ التعديل المباشر للنص والتوقيت ═══════════════ */

export function onTextInput(id, el) {
  const b = state.blocks.find(x => x.id === id);
  if(b) {
    b.text = el.value;
    autoResizeTa(el);
    updateSubOverlayLive();
    try { scheduleTextCapture(); scheduleAutosave(); scheduleBadgeUpdate(id); } catch(_) {}
  }
}

export function onRowClick(id) {
  state.activeRowId = id;
  document.querySelectorAll('.srt-card').forEach(r => r.classList.remove('active-row'));
  const target = document.getElementById('row-' + id);
  if(target) target.classList.add('active-row');
}

export function onTimeInputChange(id, field, el) {
  const b = state.blocks.find(x => x.id === id);
  if(b) {
    b[field] = toStandardTime(el.value);
    el.value = fmtTimeShort(b[field]);
    updateSubOverlayLive();
    try { captureHistory(); scheduleAutosave(); scheduleBadgeUpdate(id); } catch(_) {}
  }
}

export function stepBlockTime(id, field, deltaMs) {
  const b = state.blocks.find(x => x.id === id);
  if(!b) return;
  let ms = parseTimeStringToMs(b[field]) + deltaMs;
  ms = Math.max(0, ms);
  b[field] = formatMs(ms);

  const card = document.getElementById('row-' + id);
  if(card) {
    const inputs = card.querySelectorAll('.m-time-in');
    if(field === 'start' && inputs[0]) inputs[0].value = fmtTimeShort(b.start);
    if(field === 'end' && inputs[1]) inputs[1].value = fmtTimeShort(b.end);
  }
  updateSubOverlayLive();
  try { captureHistory(); scheduleAutosave(); scheduleBadgeUpdate(id); } catch(_) {}
}

/* ═══════════════ عمليات السطر الواحد ═══════════════ */

export function delBlock(id){
  state.blocks = state.blocks.filter(x => x.id !== id);
  renderCards();
  toast('تم حذف السطر','🗑️');
}

export function addNewBlockAfter(id){
  const idx = state.blocks.findIndex(x => x.id === id);
  if(idx === -1) return;
  const current = state.blocks[idx];
  const curEndMs = parseTimeStringToMs(current.end);
  const nextStartMs = (idx + 1 < state.blocks.length) ? parseTimeStringToMs(state.blocks[idx+1].start) : curEndMs + 2500;

  const newStartMs = curEndMs;
  const newEndMs = Math.max(newStartMs + 1000, Math.min(newStartMs + 2500, nextStartMs));

  const newBlock = {
    id: ++state.uid,
    start: formatMs(newStartMs),
    end: formatMs(newEndMs),
    text: ''
  };

  state.blocks.splice(idx + 1, 0, newBlock);
  renderCards();
  const nextTa = document.getElementById(`ta-${newBlock.id}`);
  if(nextTa) nextTa.focus();
  toast('تمت إضافة سطر جديد','➕');
}

export function addNewBlockEnd(){
  let startMs = 0;
  if(state.blocks.length > 0) {
    startMs = parseTimeStringToMs(state.blocks[state.blocks.length - 1].end);
  }
  const newBlock = {
    id: ++state.uid,
    start: formatMs(startMs),
    end: formatMs(startMs + 3000),
    text: ''
  };
  state.blocks.push(newBlock);
  renderCards();

  const container = document.getElementById('subListContainer');
  container.scrollTop = container.scrollHeight;
  const nextTa = document.getElementById(`ta-${newBlock.id}`);
  if(nextTa) nextTa.focus();
}

export function mergeWithNext(id){
  const idx = state.blocks.findIndex(x => x.id === id);
  if(idx === -1 || idx === state.blocks.length - 1) return toast('لا يوجد سطر تالٍ لدمجه','⚠️');

  const current = state.blocks[idx];
  const next = state.blocks[idx + 1];

  current.text = (current.text.trim() + ' ' + next.text.trim()).trim();
  current.end = next.end;

  state.blocks.splice(idx + 1, 1);
  renderCards();
  toast('تم دمج السطرين بنجاح','🔗');
}

export function splitBlock(id){
  const idx = state.blocks.findIndex(x => x.id === id);
  if(idx === -1) return;
  const current = state.blocks[idx];
  const ta = document.getElementById(`ta-${id}`);

  let splitIndex = -1;
  if(ta && typeof ta.selectionStart === 'number' && ta.selectionStart > 0 && ta.selectionStart < current.text.length) {
    splitIndex = ta.selectionStart;
  } else {
    const mid = Math.floor(current.text.length / 2);
    const spaceBefore = current.text.lastIndexOf(' ', mid);
    const spaceAfter = current.text.indexOf(' ', mid);
    if(spaceBefore !== -1) splitIndex = spaceBefore;
    else if(spaceAfter !== -1) splitIndex = spaceAfter;
    else splitIndex = mid;
  }

  const text1 = current.text.substring(0, splitIndex).trim();
  const text2 = current.text.substring(splitIndex).trim();

  if(!text1 || !text2) return toast('ضع المؤشر داخل النص لتحديد مكان التقسيم','⚠️');

  const startMs = parseTimeStringToMs(current.start);
  const endMs = parseTimeStringToMs(current.end);
  const totalDuration = Math.max(500, endMs - startMs);
  const ratio = text1.length / (text1.length + text2.length || 1);
  const splitMs = Math.round(startMs + (totalDuration * ratio));

  current.text = text1;
  current.end = formatMs(splitMs);

  const newBlock = {
    id: ++state.uid,
    start: formatMs(splitMs),
    end: formatMs(endMs),
    text: text2
  };

  state.blocks.splice(idx + 1, 0, newBlock);
  renderCards();
  toast('تم تقسيم السطر بنجاح','✂️');
}

/* ═══════════════ عمليات الكل (إزاحة، بحث، تنزيل) ═══════════════ */

export function shiftAllTimes(direction) {
  const delta = parseInt(document.getElementById('shiftVal').value) || 500;
  const shiftAmount = delta * direction;

  state.blocks.forEach(b => {
    const s = Math.max(0, parseTimeStringToMs(b.start) + shiftAmount);
    const e = Math.max(0, parseTimeStringToMs(b.end) + shiftAmount);
    b.start = formatMs(s);
    b.end = formatMs(e);
  });
  renderCards();
  toast(`تمت إزاحة التوقيتات بمقدار ${shiftAmount > 0 ? '+' : ''}${shiftAmount}ms`,'⏱');
}

export function highlightMatches() {
  const q = document.getElementById('findIn').value.trim().toLowerCase();
  document.querySelectorAll('.srt-card').forEach(r => r.classList.remove('match-row'));
  if(!q) return;

  state.blocks.forEach(b => {
    if(b.text && b.text.toLowerCase().includes(q)) {
      const r = document.getElementById('row-' + b.id);
      if(r) r.classList.add('match-row');
    }
  });
}

export function replaceAllMatches() {
  const findStr = document.getElementById('findIn').value;
  const repStr = document.getElementById('replaceIn').value;
  if(!findStr) return toast('أدخل نص البحث أولاً','⚠️');

  let count = 0;
  state.blocks.forEach(b => {
    if(b.text && b.text.includes(findStr)) {
      b.text = b.text.replaceAll(findStr, repStr);
      count++;
    }
  });

  renderCards();
  toast(`تم استبدال النصوص في ${count} سطر`,'✅');
}

export function dlSRT(){
  if(state.blocks.length === 0) return toast('لا يوجد محتوى لتنزيله','⚠️');
  const t = state.blocks.map((b,i) => `${i+1}\n${b.start} --> ${b.end}\n${b.text}`).join('\n\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], {type:'text/plain;charset=utf-8'}));
  a.download = (document.getElementById('fnIn').value || 'subtitle') + '.srt';
  a.click();
}

/**
 * تصدير WebVTT — نفس منطق dlSRT لكن بصيغة WebVTT الصحيحة:
 * سطر "WEBVTT" في البداية + فواصل توقيت بنقطة بدل الفاصلة (00:00:01.000).
 */
export function dlVTT(){
  try {
    if(state.blocks.length === 0) return toast('لا يوجد محتوى لتنزيله','⚠️');
    const vttTime = (tc) => String(tc || '00:00:00,000').replace(',', '.');
    const t = 'WEBVTT\n\n' + state.blocks.map((b,i) => `${i+1}\n${vttTime(b.start)} --> ${vttTime(b.end)}\n${b.text}`).join('\n\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t], {type:'text/vtt;charset=utf-8'}));
    a.download = (document.getElementById('fnIn').value || 'subtitle') + '.vtt';
    a.click();
    toast('تم تنزيل ملف VTT','⬇️');
  } catch(_) { toast('تعذر تصدير VTT','⚠️'); }
}
