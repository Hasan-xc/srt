/**
 * history.js — تراجع/إعادة (Undo/Redo) لتغييرات أسطر الترجمة
 *
 * المسؤولية:
 *  - تسجيل لقطات (snapshots) لحالة state.blocks بعد كل تغيير
 *  - حد أقصى 50 خطوة في المكدس تفادياً لاستهلاك الذاكرة
 *  - ضغطات الكتابة المتتالية تُجمع في خطوة واحدة (debounce 800ms)
 *    بنفس أسلوب محررات النصوص المعتاد
 *  - اختصارات لوحة المفاتيح: Ctrl+Z للتراجع، Ctrl+Y (أو Ctrl+Shift+Z)
 *    للإعادة، وCmd بدل Ctrl على ماك
 *  - داخل حقول الإدخال (INPUT/TEXTAREA) يُترك التراجع الأصلي للمتصفح
 *    كما هو حتى لا يُكسر أي سلوك موجود
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 * ملاحظة: لا توجد أي اختصارات لوحة مفاتيح أخرى في التطبيق (تم فحصه)،
 * لذا لا يوجد أي تعارض.
 */

import { state } from './state.js';
import { toast } from './ui.js';
import { renderCards } from './editor.js';

const MAX_HISTORY = 50;
const undoStack = [];   // مكدس اللقطات — الأعلى فيه = الحالة الحالية
const redoStack = [];
let suppressCapture = false;   // يمنع التسجيل أثناء الاسترجاع نفسه
let textCaptureTimer = null;

/**
 * لقطة نصية للحالة الحالية (blocks + uid)
 */
function snapshot(){
  return JSON.stringify({ blocks: state.blocks, uid: state.uid });
}

/**
 * تسجيل اللقطة الحالية (يُستدعى بعد كل تغيير هيكلي — انظر editor.js).
 * يتجاهل التسجيل إذا لم يتغير شيء عن آخر لقطة.
 */
export function captureHistory(){
  if(suppressCapture) return;
  try {
    const snap = snapshot();
    if(undoStack.length && undoStack[undoStack.length - 1] === snap) return;
    undoStack.push(snap);
    if(undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0; // أي تغيير جديد يُبطل سجل الإعادة
    updateHistoryButtons();
  } catch(_) {}
}

/**
 * تجميع ضغطات الكتابة المتتالية في خطوة تاريخ واحدة.
 */
export function scheduleTextCapture(){
  clearTimeout(textCaptureTimer);
  textCaptureTimer = setTimeout(captureHistory, 800);
}

/**
 * استرجاع لقطة إلى الحالة الحالية (بدون تسجيلها في التاريخ).
 */
function restore(json){
  suppressCapture = true;
  try {
    const data = JSON.parse(json);
    state.blocks = Array.isArray(data.blocks) ? data.blocks : [];
    state.uid = data.uid || 0;
    renderCards();
  } finally { suppressCapture = false; }
}

/**
 * تراجع خطوة واحدة.
 */
export function undoHistory(){
  try {
    if(undoStack.length < 2) return toast('لا يوجد ما يمكن التراجع عنه','⏪');
    redoStack.push(undoStack.pop());
    restore(undoStack[undoStack.length - 1]);
    updateHistoryButtons();
    toast('تم التراجع','⏪');
  } catch(_) {}
}

/**
 * إعادة الخطوة المتراجعة.
 */
export function redoHistory(){
  try {
    if(!redoStack.length) return toast('لا يوجد ما يمكن إعادته','⏩');
    const next = redoStack.pop();
    undoStack.push(next);
    restore(next);
    updateHistoryButtons();
    toast('تمت الإعادة','⏩');
  } catch(_) {}
}

/**
 * مزامنة حالة زري التراجع/الإعادة في شريط الأدوات.
 */
export function updateHistoryButtons(){
  try {
    const u = document.getElementById('undoBtn');
    const r = document.getElementById('redoBtn');
    if(u) u.disabled = undoStack.length < 2;
    if(r) r.disabled = !redoStack.length;
  } catch(_) {}
}

/**
 * التهيئة: تسجيل اختصارات لوحة المفاتيح + الحالة الابتدائية.
 */
export function initHistory(){
  try {
    document.addEventListener('keydown', (e) => {
      try {
        const mod = e.ctrlKey || e.metaKey; // Ctrl على ويندوز/لينكس، Cmd على ماك
        if(!mod) return;
        const key = (e.key || '').toLowerCase();
        const tag = (e.target && e.target.tagName) || '';
        // داخل الحقول النصية نترك التراجع الأصلي للمتصفح بدون أي تدخل
        if(tag === 'INPUT' || tag === 'TEXTAREA') return;
        if(key === 'z' && !e.shiftKey){ e.preventDefault(); undoHistory(); }
        else if(key === 'y' || (key === 'z' && e.shiftKey)){ e.preventDefault(); redoHistory(); }
      } catch(_) {}
    });
    captureHistory(); // الحالة الابتدائية (فارغة)
    updateHistoryButtons();
  } catch(_) {}
}
