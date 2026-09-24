/**
 * main.js — نقطة الدخول الرئيسية للتطبيق
 *
 * المسؤولية:
 *  - استيراد كل الوحدات وربطها ببعضها
 *  - تهيئة المستمعات (رفع الملفات، الفيديو، التفريغ) مرة واحدة
 *  - استعادة الإعدادات والمفاتيح المحفوظة من localStorage عند الإقلاع
 *  - تعريض الدوال التي تستخدمها معالجات HTML الضمنية (onclick/oninput/...)
 *    على نطاق window، لأن ES Modules لا تضع الدوال في النطاق العام تلقائياً.
 *
 * هذا التعريض ضروري للحفاظ على توافق سلوك واجهة المستخدم 100% مع الأصل،
 * حيث يستخدم HTML الأصلي معالجات ضمنية مثل onclick="startAi()".
 */

import { state } from './state.js';

import { toast, toggleAiBody } from './ui.js';
import {
  saveApiKey, saveOrApiKey, saveKieApiKey, saveTargetLangPref,
  setTrProvider, onPA, processInput, initCoreEvents,
  toggleKeyPanel, setKeyPanelOpen, refreshKeyBadges
} from './core.js';
import {
  renderCards, toggleRowMenu, onTextInput, onRowClick, onTimeInputChange,
  stepBlockTime, delBlock, addNewBlockAfter, addNewBlockEnd,
  mergeWithNext, splitBlock, shiftAllTimes, highlightMatches,
  replaceAllMatches, dlSRT, splitLongLines, saveSplitLimit, initSplitLimit
} from './editor.js';
import {
  togglePlay, skipVid, removeVideo, showVidSec, jumpToBlock, initVideoEvents
} from './video.js';
import {
  toggleStylePanel, updateSubStyles, loadSavedSubStyles
} from './styling.js';
import {
  checkAiReady, startAi, pauseAi, resumeAi, cancelAi,
  onAudioQualityChange, cancelExtraction,
  aiPlayExtracted, aiDownloadExtracted, initTranscribeEvents
} from './transcribe.js';
import {
  checkTrReady, startTranslation,
  cancelAiTask, retryMissingTranslation
} from './translate.js?v=2';
import { dlVTT } from './editor.js';
import { initAutosave } from './autosave.js';
import { initHistory, undoHistory, redoHistory } from './history.js';
import { initGlossary, toggleGlossary, addGlossaryPair, removeGlossaryPair } from './glossary.js';
import {
  toggleDrawer, closeDrawer, openDrawer, saveProjectAs, openProject,
  deleteProject, clearAllProjects, initProjects, renderProjectsList
} from './projects.js';

/* ═══════════════════════════════════════
   تعريض الدوال لمعالجات HTML الضمنية
═════════════════════════════════════ */
const globalApi = {
  // ui
  toast, toggleAiBody,
  // core (الإعدادات والإدخال)
  onPA, processInput, saveApiKey, saveOrApiKey, saveKieApiKey,
  saveTargetLangPref, setTrProvider,
  toggleKeyPanel, setKeyPanelOpen, refreshKeyBadges,
  // editor (المحرر)
  renderCards, toggleRowMenu, onTextInput, onRowClick, onTimeInputChange,
  stepBlockTime, delBlock, addNewBlockAfter, addNewBlockEnd,
  mergeWithNext, splitBlock, shiftAllTimes, highlightMatches,
  replaceAllMatches, dlSRT,
  splitLongLines, saveSplitLimit, initSplitLimit,
  // video (المشغل والمزامنة)
  togglePlay, skipVid, removeVideo, showVidSec, jumpToBlock,
  // styling (مظهر الترجمة)
  toggleStylePanel, updateSubStyles,
  // transcribe (التفريغ واستخراج الصوت)
  checkAiReady, startAi, pauseAi, resumeAi, cancelAi,
  onAudioQualityChange, cancelExtraction,
  aiPlayExtracted, aiDownloadExtracted,
  // translate (الترجمة)
  checkTrReady, startTranslation,
  cancelAiTask, retryMissingTranslation,
  // ميزات إضافية (تراجع/إعادة، تصدير VTT، قاموس المصطلحات)
  undoHistory, redoHistory, dlVTT,
  toggleGlossary, addGlossaryPair, removeGlossaryPair,
  // القائمة الجانبية للمسودات والمشاريع
  toggleDrawer, closeDrawer, openDrawer, saveProjectAs, openProject,
  deleteProject, clearAllProjects
};

Object.assign(window, globalApi);

/* ═══════════════════════════════════════
   التهيئة عند تحميل الصفحة
═════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  // ── استعادة المفاتيح المحفوظة ──
  const gk = localStorage.getItem('groq_api_key');
  if(gk) document.getElementById('aiKeyIn').value = gk;
  const ok = localStorage.getItem('openrouter_api_key');
  if(ok) document.getElementById('orKeyIn').value = ok;
  const kk = localStorage.getItem('kie_api_key');
  if(kk) document.getElementById('kieKeyIn').value = kk;
  // نقطة اتصال Kie ثابتة داخلياً (API_ENDPOINTS) — حقل الإدخال حُذف من الواجهة

  // ── استعادة التفضيلات المحفوظة ──
  const savedTargetLang = localStorage.getItem('tr_target_lang');
  if(savedTargetLang) document.getElementById('trTargetLang').value = savedTargetLang;

  const savedProvider = localStorage.getItem('tr_provider');
  if(savedProvider === 'kie') setTrProvider('kie');

  loadSavedSubStyles();
  checkTrReady();
  try { refreshKeyBadges(); } catch(e) { console.warn('key badges:', e); }
  try { initSplitLimit(); } catch(e) { console.warn('split limit:', e); }

  // ── ربط مستمعات رفع الملفات (مرة واحدة) ──
  initCoreEvents();
  initTranscribeEvents();
  initVideoEvents();

  // ── تهيئة الميزات الإضافية — فشل أي منها لا يوقف الباقي ──
  try { initAutosave(); } catch(e) { console.warn('autosave init:', e); }
  try { initHistory(); } catch(e) { console.warn('history init:', e); }
  try { initGlossary(); } catch(e) { console.warn('glossary init:', e); }
  try { initProjects(); } catch(e) { console.warn('projects init:', e); }
});
