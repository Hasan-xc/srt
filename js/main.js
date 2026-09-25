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
  deleteProject, clearAllProjects, initProjects
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
   تسجيل Service Worker (PWA) — فشله لا يوقف التطبيق
═══════════════════════════════════════ */
try {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => {
        console.warn('sw register:', e && e.message);
      });
    });
  }
} catch (e) { console.warn('sw:', e && e.message); }

/* ═══════════════════════════════════════
   التهيئة عند تحميل الصفحة
═════════════════════════════════════ */
/* ═══════════════════════════════════════
   قائمة الهيدر + زر «تثبيت التطبيق» (PWA)
═══════════════════════════════════════ */
let navMenuEl = null;

function closeNavMenu(){
  if (!navMenuEl) return;
  navMenuEl.hidden = true;
  const btn = document.getElementById('menuBtn');
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = '☰'; }
}

function initNavMenu(){
  navMenuEl = document.getElementById('navMenu');
  const menuBtn = document.getElementById('menuBtn');
  const menuDrawer = document.getElementById('menuDrawer');
  const menuInstall = document.getElementById('menuInstall');
  const iosHint = document.getElementById('iosInstallHint');
  const textMode = document.getElementById('menuTextMode');
  if (!navMenuEl || !menuBtn) return;

  menuBtn.addEventListener('click', () => {
    const open = navMenuEl.hidden;       // true = كانت مغلقة → سنفتحها
    navMenuEl.hidden = !open;
    menuBtn.textContent = open ? '✕' : '☰';
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  navMenuEl.addEventListener('click', (e) => e.stopPropagation());
  menuBtn.addEventListener('click', (e) => e.stopPropagation());

  // «أعمالي المحفوظة» — نفس الدروار الحالي بلا أي تغيير منطقه
  if (menuDrawer) menuDrawer.addEventListener('click', () => {
    closeNavMenu();
    toggleDrawer();
  });

  // «تفريغ نصي» — مخفي حتى يُبنى مسار #/text لاحقاً
  if (textMode) textMode.hidden = true;

  // إغلاق بالنقر خارج القائمة
  document.addEventListener('click', (e) => {
    if (!navMenuEl.hidden && !navMenuEl.contains(e.target) && e.target !== menuBtn) closeNavMenu();
  });
  // إغلاق بـ Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navMenuEl && !navMenuEl.hidden) closeNavMenu();
  });

  /* ── زر التثبيت: يظهر فقط عند توفر beforeinstallprompt ── */
  let deferredPrompt = null;
  const isStandalone = () => {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    } catch (_) { return false; } // بيئات بلا matchMedia (webviews غريبة) — لا تكسر init
  };
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone() && menuInstall) menuInstall.hidden = false;
  });

  if (menuInstall) menuInstall.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') menuInstall.hidden = true;
      deferredPrompt = null;
    }
    closeNavMenu();
  });

  // iOS لا يدعم beforeinstallprompt → إرشاد نصي (وليس في وضع standalone)
  if (isIOS() && !isStandalone() && iosHint) iosHint.hidden = false;

  // مُثبّت بالفعل → أخفِ كل ما يتعلق بالتثبيت
  window.addEventListener('appinstalled', () => {
    if (menuInstall) menuInstall.hidden = true;
    if (iosHint) iosHint.hidden = true;
  });
  if (isStandalone()) {
    if (menuInstall) menuInstall.hidden = true;
    if (iosHint) iosHint.hidden = true;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // ── استعادة المفاتيح المحفوظة ──
  const gk = localStorage.getItem('groq_api_key');
  if(gk) document.getElementById('aiKeyIn').value = gk;
  const ok = localStorage.getItem('openrouter_api_key');
  if(ok) { const oIn = document.getElementById('orKeyIn'); if(oIn) oIn.value = ok; } // الحقل أُزيل من الواجهة (Kie.ai فقط)
  const kk = localStorage.getItem('kie_api_key');
  if(kk) document.getElementById('kieKeyIn').value = kk;
  // نقطة اتصال Kie ثابتة داخلياً (API_ENDPOINTS) — حقل الإدخال حُذف من الواجهة

  // ── استعادة التفضيلات المحفوظة ──
  const savedTargetLang = localStorage.getItem('tr_target_lang');
  if(savedTargetLang) document.getElementById('trTargetLang').value = savedTargetLang;

  // ── Kie.ai هو المزود الوحيد — يُفعّل تلقائياً عند كل تحميل ──
  setTrProvider('kie');
  {
    const kieKey = localStorage.getItem('kie_api_key') ||
                   (document.getElementById('kieKeyIn') || {}).value || '';
    const kieBlock = document.getElementById('kieBlock');
    if (kieKey.trim()) {
      if (kieBlock) kieBlock.style.display = 'none';
      try { setKeyPanelOpen('kie', false); } catch(e) {}
    } else {
      if (kieBlock) kieBlock.style.display = 'block';
      try { setKeyPanelOpen('kie', true); } catch(e) {}
    }
  }

  loadSavedSubStyles();
  checkTrReady();
  try { refreshKeyBadges(); } catch(e) { console.warn('key badges:', e); }
  try { initSplitLimit(); } catch(e) { console.warn('split limit:', e); }

  // ── ربط مستمعات رفع الملفات (مرة واحدة) ──
  initCoreEvents();
  initTranscribeEvents();
  initVideoEvents();

  // ── قائمة الهيدر (همبرغر): فتح/إغلاق بالنقر خارجه أو Escape ──
  try { initNavMenu(); } catch(e) { console.warn('nav menu:', e); }

  // ── تهيئة الميزات الإضافية — فشل أي منها لا يوقف الباقي ──
  try { initAutosave(); } catch(e) { console.warn('autosave init:', e); }
  try { initHistory(); } catch(e) { console.warn('history init:', e); }
  try { initGlossary(); } catch(e) { console.warn('glossary init:', e); }
  try { initProjects(); } catch(e) { console.warn('projects init:', e); }
});
