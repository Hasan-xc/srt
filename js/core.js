/**
 * core.js — النواة: الإعدادات، المفاتيح، ومعالجة الإدخال
 *
 * المسؤولية:
 *  - قراءة/حفظ مفاتيح API وإعدادات التفريغ والترجمة من localStorage
 *  - معالجة النص أو ملف SRT الملصق وتحويله إلى blocks
 *  - التحكم في مزود الترجمة (OpenRouter / Kie.ai)
 *  - إظهار المحرر
 *
 * لا يحتوي على أي منطق استدعاء شبكة (يوجد في transcribe.js / translate.js).
 */

import { state } from './state.js';
import { formatMs } from './time.js';
import { toast } from './ui.js';

/* ═══════════════ حفظ المفاتيح والإعدادات ═══════════════ */

export function saveApiKey(){
  const k = document.getElementById('aiKeyIn').value.trim();
  if(!k) return toast('أدخل المفتاح أولاً','⚠️');
  localStorage.setItem('groq_api_key', k);
  toast('تم حفظ مفتاح Groq','🔐');
}
export function saveOrApiKey(){
  const k = document.getElementById('orKeyIn').value.trim();
  if(!k) return toast('أدخل المفتاح أولاً','⚠️');
  localStorage.setItem('openrouter_api_key', k);
  toast('تم حفظ مفتاح OpenRouter','🔐');
  checkTrReady();
}
export function saveKieApiKey(){
  const k = document.getElementById('kieKeyIn').value.trim();
  if(!k) return toast('أدخل المفتاح أولاً','⚠️');
  const u = document.getElementById('kieBaseUrl').value.trim();
  localStorage.setItem('kie_api_key', k);
  if(u) localStorage.setItem('kie_base_url', u);
  toast('تم حفظ إعدادات Kie.ai','🔐');
  checkTrReady();
}
export function saveWhisperModel(){
  const m = document.getElementById('whisperModelSel').value;
  localStorage.setItem('whisper_model', m);
  toast(`تم تفعيل: ${m.includes('turbo') ? 'Whisper Turbo' : 'Whisper Large الدقيق'}`,'⚡');
}
export function saveDialectPref(){
  const d = document.getElementById('trDialect').value;
  localStorage.setItem('tr_dialect', d);
}

/* ═══════════════ تبديل مزود الترجمة ═══════════════ */

export function setTrProvider(p){
  state.trProvider = p;
  localStorage.setItem('tr_provider', p);
  document.getElementById('provBtnOR').classList.toggle('active', p === 'openrouter');
  document.getElementById('provBtnKie').classList.toggle('active', p === 'kie');
  document.getElementById('orBlock').style.display   = (p === 'openrouter') ? 'block' : 'none';
  document.getElementById('kieBlock').style.display  = (p === 'kie') ? 'block' : 'none';
  document.getElementById('trModel').style.display    = (p === 'openrouter') ? '' : 'none';
  document.getElementById('trModelKie').style.display = (p === 'kie') ? '' : 'none';
  checkTrReady();
}

/* ═══════════════ معالجة الإدخال (نص أو SRT) ═══════════════ */

export function onPA(){ document.getElementById('procBtn').disabled = !document.getElementById('pasteArea').value.trim(); }

export function processInput(){
  const raw = document.getElementById('pasteArea').value; if(!raw.trim()) return;
  state.blocks = []; state.uid = 0;
  const regex = /(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})/g;
  let match, matches = [];
  while ((match = regex.exec(raw)) !== null) {
    matches.push({ startStr: match[1].replace('.', ','), endStr: match[2].replace('.', ','), index: match.index, length: match[0].length });
  }
  if(matches.length > 0) {
    for(let i=0; i<matches.length; i++) {
      let textStart = matches[i].index + matches[i].length;
      let textEnd = (i + 1 < matches.length) ? matches[i+1].index : raw.length;
      let chunk = raw.substring(textStart, textEnd);
      let lines = chunk.trim().split('\n');
      let cleanLines = [];
      for(let j=0; j<lines.length; j++) {
        let l = lines[j].trim();
        if(j === lines.length - 1 && /^\d+$/.test(l)) continue;
        if(l) cleanLines.push(l);
      }
      state.blocks.push({ id: ++state.uid, start: matches[i].startStr, end: matches[i].endStr, text: cleanLines.join('\n') });
    }
  } else {
    let lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
    lines.forEach((l, i) => {
      state.blocks.push({ id: ++state.uid, start: formatMs(i * 3000), end: formatMs((i + 1) * 3000), text: l.trim() });
    });
  }
  showEditor(); renderCards();
  checkTrReady();
  toast('تم تحميل الأسطر بنجاح','✅');
}

export function showEditor(){
  document.getElementById('inputCard').style.display = 'none';
  document.getElementById('edSec').style.display = 'block';
  document.getElementById('vidUploadBar').style.display = 'block';
}

/* ═══════════════ تهيئة مستمعات رفع الملفات النصية ═══════════════ */

/**
 * يربط مستمع change لحقل رفع ملفات SRT/TXT (النصية فقط).
 * يُستدعى مرة واحدة من main.js عند بدء التشغيل.
 */
export function initCoreEvents(){
  document.getElementById('fileIn').addEventListener('change', function(){
    const f = this.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = e => {
      document.getElementById('pasteArea').value = e.target.result;
      onPA(); processInput();
      toast('تم رفع "' + f.name + '"','📂');
    };
    r.readAsText(f, 'UTF-8');
    this.value = '';
  });
}
