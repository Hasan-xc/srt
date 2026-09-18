/**
 * projects.js — القائمة الجانبية للمسودات والمشاريع (Sidebar Project Manager)
 *
 * المسؤولية:
 *  - درج جانبي ينزلق بنعومة (Off-canvas) مع خلفية معتمة وإغلاق بالنقر خارجه
 *  - حفظ تلقائي للمسودة الحالية (Debounced 1s) في localStorage
 *  - حفظ "مشروع جديد" باسم مخصص + قائمة مشاريع ببطاقات (اسم/عدد أسطر/تاريخ)
 *  - استرجاع فوري للمحرر + حذف بسرعة تأكيد + تفريغ كامل
 *  - يخزّن نصوص وتوقيتات SRT فقط {id,start,end,text} + وصفية — لا فيديو أبداً
 *    (الفيديو Object URL مؤقت ولا يتسع في حد 5MB لـ localStorage)
 *
 * ميزة معزولة: كل العمليات داخل try/catch — فشلها لا يوقف التطبيق.
 */

import { state } from './state.js';
import { toast } from './ui.js';
import { renderCards } from './editor.js';
import { showEditor } from './core.js';

const PROJECTS_KEY = 'srt_projects_v1';     // قائمة المشاريع المحفوظة
const DRAFT_KEY    = 'srt_autosave_v1';     // مسودة العمل الجاري (مستقلة عن القائمة)
const DRAFT_DEBOUNCE_MS = 1000;
const MAX_PROJECTS = 30;                    // حد منطقي يحفظ مساحة localStorage

let draftTimer = null;

/* ════════════════════════════════════════════════════════════════
   محرك التخزين (Storage Engine) — نصوص وتوقيتات فقط، بلا فيديو
════════════════════════════════════════════════════════════════ */

/** بيانات المشروع النقية فقط (بلا أي Blob/ObjectURL) */
function snapshotPayload(name){
  return {
    name: name || 'بدون اسم',
    savedAt: Date.now(),
    count: state.blocks.length,
    uid: state.uid,
    blocks: state.blocks.map(b => ({ id: b.id, start: b.start, end: b.end, text: b.text }))
  };
}

function readProjects(){
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if(!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch(_){ return []; }
}

function writeProjects(list){
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
    return true;
  } catch(e){
    toast('مساحة التخزين ممتلئة — احذف مشاريع قديمة','⚠️');
    return false;
  }
}

/**
 * الحفظ التلقائي للمسودة الحالية (Debounced 1s — يُستدعى من renderCards
 * عبر نقطة الربط scheduleProjectAutosave؛ لا يثقل الرام ولا يكتب كل حرف).
 */
export function scheduleProjectAutosave(){
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftSilently, 1000);
}

function saveDraftSilently(){
  try {
    if(!state.blocks.length) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshotPayload('مسودة العمل')));
  } catch(_){}
}

/**
 * حفظ كمشروع جديد باسم مخصص (زر يدوي).
 */
export function saveProjectAs(){
  if(!state.blocks.length) return toast('لا يوجد محتوى لحفظه كمشروع','⚠️');
  const defaultName = (document.getElementById('fnIn') && document.getElementById('fnIn').value.trim())
    || 'مشروع ' + new Date().toLocaleDateString('ar');
  const name = (prompt('اسم المشروع الجديد:', defaultName) || '').trim();
  if(!name) return;

  const list = readProjects();
  list.unshift(snapshotPayload(name));
  if(list.length > MAX_PROJECTS) list.length = MAX_PROJECTS;
  if(writeProjects(list)){
    renderProjectsList();
    toast(`تم حفظ المشروع: ${name}`,'💾');
  }
}

/**
 * استرجاع مشروع إلى المحرر فوراً (أسطر + مزامنة العرض).
 * @param {number} index
 */
export function openProject(index){
  try {
    const list = readProjects();
    const p = list[index];
    if(!p || !Array.isArray(p.blocks) || !p.blocks.length) return toast('المشروع فارغ أو تالف','⚠️');
    state.blocks = p.blocks.map(b => ({ id: b.id, start: b.start, end: b.end, text: b.text || '' }));
    state.uid = p.uid || state.blocks.reduce((m, b) => Math.max(m, b.id || 0), 0);
    state.activeRowId = null;
    if(document.getElementById('fnIn')) document.getElementById('fnIn').value = p.name || 'subtitle';
    renderCards();
    showEditor();
    closeDrawer();
    toast(`تم فتح "${p.name}" (${p.blocks.length} سطر)`,'📂');
  } catch(_){ toast('تعذر فتح المشروع','⚠️'); }
}

/**
 * حذف مشروع بتأكيد سريع (confirm).
 * @param {number} index
 */
export function deleteProject(index){
  const list = readProjects();
  const p = list[index];
  if(!p) return;
  if(!window.confirm(`حذف المشروع "${p.name}" نهائياً؟`)) return;
  list.splice(index, 1);
  writeProjects(list);
  renderProjectsList();
  toast('تم حذف المشروع','🗑️');
}

/**
 * تفريغ كافة المسودات والمشاريع — بتأكيد مزدوج بسيط.
 */
export function clearAllProjects(){
  const n = readProjects().length;
  if(!n) return toast('لا توجد مشاريع محفوظة','📂');
  if(!window.confirm(`حذف كل المشاريع (${n}) نهائياً؟ لا يمكن التراجع.`)) return;
  try { localStorage.removeItem(PROJECTS_KEY); } catch(_){}
  renderProjectsList();
  toast('تم تفريغ كل المشاريع','🗑️');
}

/* ════════════════════════════════════════════════════════════════
   واجهة الدرج (Drawer UI)
════════════════════════════════════════════════════════════════ */

export function openDrawer(){
  const ov = document.getElementById('projectsDrawer');
  if(!ov) return;
  renderProjectsList();
  ov.classList.add('on');
}
export function closeDrawer(){
  const ov = document.getElementById('projectsDrawer');
  if(ov) ov.classList.remove('on');
}
export function toggleDrawer(){
  const ov = document.getElementById('projectsDrawer');
  if(!ov) return;
  ov.classList.contains('on') ? closeDrawer() : openDrawer();
}

/**
 * رسم بطاقات المشاريع (اسم/عدد أسطر/تاريخ + استرجاع/حذف).
 */
export function renderProjectsList(){
  const box = document.getElementById('projectsList');
  if(!box) return;
  const list = readProjects();
  if(!list.length){
    box.innerHTML = '<div class="projects-empty">📂 لا توجد مشاريع محفوظة بعد.<br>احفظ عملك الحالي بزر «حفظ كمشروع جديد».</div>';
    return;
  }
  box.innerHTML = list.map((p, i) => {
    const when = p.savedAt ? new Date(p.savedAt).toLocaleString('ar') : '';
    const count = Array.isArray(p.blocks) ? p.blocks.length : 0;
    return `<div class="project-card">
      <div class="proj-info">
        <div class="proj-name">${escapeHtml(p.name || 'بدون اسم')}</div>
        <div class="proj-meta">${count} سطر • ${when}</div>
      </div>
      <div class="proj-actions">
        <button class="btn b-green b-sm" onclick="openProject(${i})">📂 فتح</button>
        <button class="btn b-red b-sm" onclick="deleteProject(${i})">🗑️</button>
      </div>
    </div>`;
  }).join('');
}

function escapeHtml(str){
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * التهيئة: ربط الإغلاق بالنقر خارج الدرج + مرة أولى لرسم القائمة.
 * يُستدعى من main.js عند الإقلاع.
 */
export function initProjects(){
  try {
    const ov = document.getElementById('projectsDrawer');
    if(ov){
      // النقر على الخلفية المعتمة (وليس على الصندوق نفسه) يغلق
      ov.addEventListener('click', (e) => { if(e.target === ov) closeDrawer(); });
    }
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape') closeDrawer();
    });
    // الحفظ التلقائي يرتبط بنفس نقاط تعديل المحرر (renderCards تستدعيها)
    renderProjectsList();
  } catch(_){}
}
