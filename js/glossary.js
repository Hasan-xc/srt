/**
 * glossary.js — قاموس المصطلحات الثابتة (Glossary)
 *
 * المسؤولية:
 *  - واجهة نافذة صغيرة يضيف فيها المستخدم أزواج "مصطلح أصلي → ترجمة ثابتة"
 *  - الحفظ في localStorage (مفتاح مستقل: srt_glossary_v1)
 *  - توفير getGlossaryPromptBlock() التي تُحقن في برومبت الترجمة داخل
 *    translate.js كقاعدة إلزامية رقم 6 (فقط عند وجود أزواج —
 *    القاموس الفارغ = برومبت مطابق للأصل حرفياً)
 *  - لا تؤثر على التدقيق/التحسين (refine) ولا على بنية الطلب الأساسية
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 */

import { toast } from './ui.js';

const GLOSSARY_KEY = 'srt_glossary_v1';

/**
 * قراءة أزواج القاموس من localStorage.
 * @returns {Array<{from:string,to:string}>}
 */
function loadGlossary(){
  try {
    const raw = localStorage.getItem(GLOSSARY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(p => p && p.from && p.to) : [];
  } catch(_) { return []; }
}

function saveGlossary(pairs){
  try { localStorage.setItem(GLOSSARY_KEY, JSON.stringify(pairs)); } catch(_) {}
}

/**
 * كتلة القاموس النصية للبرومبت — فارغة إذا لا توجد أزواج.
 * تُستدعى من buildTranslationPrompt في translate.js.
 */
export function getGlossaryPromptBlock(){
  try {
    const pairs = loadGlossary();
    if(!pairs.length) return '';
    return pairs.map(p => `- "${p.from}" => "${p.to}"`).join('\n');
  } catch(_) { return ''; }
}

/**
 * فتح/إغلاق نافذة القاموس.
 */
export function toggleGlossary(){
  const ov = document.getElementById('glossaryOverlay');
  if(!ov) return;
  ov.classList.toggle('on');
  if(ov.classList.contains('on')) renderGlossaryList();
}

/**
 * حماية بسيطة عند عرض أزواج المستخدم داخل innerHTML.
 */
function escapeGlossHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * رسم قائمة الأزواج داخل النافذة.
 */
function renderGlossaryList(){
  const list = document.getElementById('glossaryList');
  if(!list) return;
  const pairs = loadGlossary();
  list.innerHTML = '';
  if(!pairs.length){
    list.innerHTML = '<div class="glossary-empty">لا توجد مصطلحات بعد — أضف أول زوج من الحقول بالأسفل</div>';
    return;
  }
  pairs.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'glossary-row';
    row.innerHTML =
      `<span class="g-from">${escapeGlossHtml(p.from)}</span>` +
      '<span class="g-arrow">←</span>' +
      `<span class="g-to">${escapeGlossHtml(p.to)}</span>` +
      `<button class="btn b-red b-sm" onclick="removeGlossaryPair(${i})" title="حذف">🗑️</button>`;
    list.appendChild(row);
  });
}

/**
 * إضافة زوج جديد من حقول الإدخال.
 */
export function addGlossaryPair(){
  try {
    const fromEl = document.getElementById('glossFrom');
    const toEl = document.getElementById('glossTo');
    const from = (fromEl.value || '').trim();
    const to = (toEl.value || '').trim();
    if(!from || !to) return toast('أدخل المصطلح والترجمة معاً','⚠️');
    const pairs = loadGlossary();
    if(pairs.some(p => p.from.toLowerCase() === from.toLowerCase())) return toast('هذا المصطلح موجود بالقاموس','⚠️');
    pairs.push({ from, to });
    saveGlossary(pairs);
    fromEl.value = ''; toEl.value = '';
    renderGlossaryList();
    toast('تمت إضافة المصطلح للقاموس','📖');
  } catch(_) {}
}

/**
 * حذف زوج بالفهرس.
 */
export function removeGlossaryPair(i){
  try {
    const pairs = loadGlossary();
    if(i < 0 || i >= pairs.length) return;
    pairs.splice(i, 1);
    saveGlossary(pairs);
    renderGlossaryList();
    toast('تم حذف المصطلح','🗑️');
  } catch(_) {}
}

/**
 * التهيئة عند الإقلاع: رسم القائمة المحفوظة + إغلاق النافذة بالنقر خلفها.
 */
export function initGlossary(){
  try {
    renderGlossaryList();
    const ov = document.getElementById('glossaryOverlay');
    if(ov) ov.addEventListener('click', (e) => { if(e.target === ov) toggleGlossary(); });
  } catch(_) {}
}
