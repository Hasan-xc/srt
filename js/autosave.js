/**
 * autosave.js — حفظ تلقائي للمسودة محلياً + استرجاعها عند الإقلاع
 *
 * المسؤولية:
 *  - حفظ state.blocks تلقائياً في localStorage بعد كل تعديل (بتأخير debounce
 *    800ms — لا يكتب مع كل ضغطة حرف مباشرة)
 *  - عند تحميل الصفحة: لو توجد مسودة محفوظة، يعرض شريطاً صغيراً يسأل
 *    "فيه مسودة محفوظة، تبي تسترجعها؟" مع زرين (نعم / تجاهل)
 *  - لا يستبدل بيانات المستخدم تلقائياً أبداً بدون تأكيده
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 * تُستدعى نقاط الربط (scheduleAutosave) من editor.js عند كل تعديل/رسم.
 */

import { state } from './state.js';
import { toast } from './ui.js';
import { renderCards } from './editor.js';
import { showEditor } from './core.js';

const AUTOSAVE_KEY = 'srt_autosave_v1';
const DEBOUNCE_MS = 800;

let saveTimer = null;
let lastSavedJson = '';

/**
 * يجدول عملية حفظ بعد DEBOUNCE_MS من آخر تعديل (تُلغي الجدولة السابقة).
 */
export function scheduleAutosave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraftNow, DEBOUNCE_MS);
}

/**
 * حفظ فوري للمسودة (يُستدعى داخلياً بعد انتهاء التأخير).
 */
export function saveDraftNow(){
  try {
    if(!state.blocks.length) return;
    const payload = JSON.stringify({ savedAt: Date.now(), blocks: state.blocks });
    if(payload === lastSavedJson) return; // لا كتابة إن لم يتغير شيء
    localStorage.setItem(AUTOSAVE_KEY, payload);
    lastSavedJson = payload;
  } catch(_) {}
}

/**
 * قراءة المسودة إن وجدت (بدون تعديل أي شيء).
 * @returns {object|null} {savedAt, blocks} أو null
 */
function peekDraft(){
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if(!raw) return null;
    const data = JSON.parse(raw);
    if(!Array.isArray(data.blocks) || !data.blocks.length) return null;
    return data;
  } catch(_) { return null; }
}

/**
 * استرجاع المسودة إلى المحرر (يُستدعى فقط بعد تأكيد المستخدم).
 * @returns {boolean} نجاح الاسترجاع
 */
export function restoreDraft(){
  try {
    const data = peekDraft();
    if(!data) return false;
    state.blocks = data.blocks;
    state.uid = state.blocks.reduce((m, b) => Math.max(m, b.id || 0), 0);
    renderCards();
    showEditor();
    toast('تم استرجاع المسودة المحفوظة','💾');
    return true;
  } catch(_) { return false; }
}

/* ═══════════════ شريط سؤال الاسترجاع (توست صغير بزرين) ═══════════════ */

function dismissDraftBar(){
  const bar = document.getElementById('draftBar');
  if(bar) bar.classList.remove('on');
}

function showDraftPrompt(draft){
  if(document.getElementById('draftBar')) return;
  const count = draft.blocks.length;
  const when = draft.savedAt ? new Date(draft.savedAt).toLocaleTimeString() : '';
  const bar = document.createElement('div');
  bar.id = 'draftBar';
  bar.className = 'draft-bar';
  bar.innerHTML =
    `<span>💾 فيه مسودة محفوظة (${count} سطر${when ? ' — ' + when : ''})، تبي تسترجعها؟</span>` +
    '<button class="btn b-green b-sm" id="draftYes">نعم</button>' +
    '<button class="btn b-ghost b-sm" id="draftNo">تجاهل</button>';
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('on'));
  document.getElementById('draftYes').addEventListener('click', () => {
    dismissDraftBar();
    restoreDraft();
  });
  document.getElementById('draftNo').addEventListener('click', () => {
    dismissDraftBar();
    toast('تم تجاهل المسودة (ما زالت محفوظة)','👌');
  });
}

/**
 * التهيئة عند إقلاع الصفحة — يعرض سؤال الاسترجاع إن وُجدت مسودة.
 */
export function initAutosave(){
  try {
    const draft = peekDraft();
    if(draft) showDraftPrompt(draft);
  } catch(_) {}
}
