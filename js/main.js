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
  saveApiKey, saveOrApiKey, saveKieApiKey, saveWhisperModel, saveDialectPref,
  setTrProvider, onPA, processInput, initCoreEvents
} from './core.js';
import {
  renderCards, toggleRowMenu, onTextInput, onRowClick, onTimeInputChange,
  stepBlockTime, delBlock, addNewBlockAfter, addNewBlockEnd,
  mergeWithNext, splitBlock, shiftAllTimes, highlightMatches,
  replaceAllMatches, dlSRT
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
  checkTrReady, startTranslation, startTextRefinement,
  cancelAiTask, testKieConnection
} from './translate.js';
import { dlVTT } from './editor.js';
import { initAutosave } from './autosave.js';
import { initHistory, undoHistory, redoHistory } from './history.js';
import { initGlossary, toggleGlossary, addGlossaryPair, removeGlossaryPair } from './glossary.js';
import { startAiEnhance } from './enhance.js';

/* ═══════════════════════════════════════
   تعريض الدوال لمعالجات HTML الضمنية
═════════════════════════════════════ */
const globalApi = {
  // ui
  toast, toggleAiBody,
  // core (الإعدادات والإدخال)
  onPA, processInput, saveApiKey, saveOrApiKey, saveKieApiKey,
  saveWhisperModel, saveDialectPref, setTrProvider,
  // editor (المحرر)
  renderCards, toggleRowMenu, onTextInput, onRowClick, onTimeInputChange,
  stepBlockTime, delBlock, addNewBlockAfter, addNewBlockEnd,
  mergeWithNext, splitBlock, shiftAllTimes, highlightMatches,
  replaceAllMatches, dlSRT,
  // video (المشغل والمزامنة)
  togglePlay, skipVid, removeVideo, showVidSec, jumpToBlock,
  // styling (مظهر الترجمة)
  toggleStylePanel, updateSubStyles,
  // transcribe (التفريغ واستخراج الصوت)
  checkAiReady, startAi, pauseAi, resumeAi, cancelAi,
  onAudioQualityChange, cancelExtraction,
  aiPlayExtracted, aiDownloadExtracted,
  // translate (الترجمة والتحسين)
  checkTrReady, startTranslation, startTextRefinement,
  cancelAiTask, testKieConnection,
  // ميزات إضافية (تراجع/إعادة، تصدير VTT، قاموس المصطلحات)
  undoHistory, redoHistory, dlVTT,
  toggleGlossary, addGlossaryPair, removeGlossaryPair,
  // تحسين بـ AI
  startAiEnhance
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
  const kb = localStorage.getItem('kie_base_url');
  if(kb) document.getElementById('kieBaseUrl').value = kb;

  // ── استعادة التفضيلات المحفوظة ──
  const savedWhisperModel = localStorage.getItem('whisper_model');
  if(savedWhisperModel) document.getElementById('whisperModelSel').value = savedWhisperModel;

  const savedDialect = localStorage.getItem('tr_dialect');
  if(savedDialect) document.getElementById('trDialect').value = savedDialect;

  const savedProvider = localStorage.getItem('tr_provider');
  if(savedProvider === 'kie') setTrProvider('kie');

  loadSavedSubStyles();
  checkTrReady();

  // ── ربط مستمعات رفع الملفات (مرة واحدة) ──
  initCoreEvents();
  initTranscribeEvents();
  initVideoEvents();

  // ── تهيئة الميزات الإضافية — فشل أي منها لا يوقف الباقي ──
  try { initAutosave(); } catch(e) { console.warn('autosave init:', e); }
  try { initHistory(); } catch(e) { console.warn('history init:', e); }
  try { initGlossary(); } catch(e) { console.warn('glossary init:', e); }
});
