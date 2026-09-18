/**
 * styling.js — تخصيص مظهر الترجمة الحية على الفيديو
 *
 * المسؤولية:
 *  - فتح/إغلاق لوحة تخصيص المظهر
 *  - تطبيق اختيارات المستخدم (حجم/نوع/لون/ظل/خلفية/مكان) على متغيرات CSS
 *  - حفظ التفضيلات في localStorage واستعادتها عند التحميل
 *  - تحديث overlay الترجمة فوراً عند تعديل النص أو التوقيت في المحرر
 */

import { state } from './state.js';
import { parseTimeStringToMs } from './time.js';

export function toggleStylePanel(){
  const p = document.getElementById('stylePanel');
  const isHide = p.style.display === 'none' || !p.style.display;
  p.style.display = isHide ? 'block' : 'none';
  document.getElementById('styleToggleIco').textContent = isHide ? '⚙️ إغلاق ▲' : '⚙️ إعدادات المظهر ▼';
}

export function updateSubStyles(){
  const size = document.getElementById('stSize').value;
  const font = document.getElementById('stFont').value;
  const color = document.getElementById('stColor').value;
  const shadowType = document.getElementById('stShadow').value;
  const bg = document.getElementById('stBg').value;
  const pos = document.getElementById('stPos').value;

  let shadowVal = 'none';
  if(shadowType === 'shadow') shadowVal = '0px 2px 4px rgba(0,0,0,0.9), 0px 0px 2px #000';
  else if(shadowType === 'heavy') shadowVal = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0px 3px 6px rgba(0,0,0,0.9)';
  else if(shadowType === 'soft') shadowVal = '0px 0px 8px rgba(0,0,0,0.8)';

  document.documentElement.style.setProperty('--sub-font-size', size);
  document.documentElement.style.setProperty('--sub-font-family', font);
  document.documentElement.style.setProperty('--sub-color', color);
  document.documentElement.style.setProperty('--sub-shadow', shadowVal);
  document.documentElement.style.setProperty('--sub-bg-color', bg);

  if(pos === 'top') {
    document.documentElement.style.setProperty('--sub-top', '10%');
    document.documentElement.style.setProperty('--sub-bottom', 'auto');
  } else if(pos === 'bottom-low') {
    document.documentElement.style.setProperty('--sub-top', 'auto');
    document.documentElement.style.setProperty('--sub-bottom', '5%');
  } else {
    document.documentElement.style.setProperty('--sub-top', 'auto');
    document.documentElement.style.setProperty('--sub-bottom', '12%');
  }

  const pref = { size, font, color, shadowType, bg, pos };
  localStorage.setItem('sub_style_prefs', JSON.stringify(pref));
}

export function loadSavedSubStyles(){
  const s = localStorage.getItem('sub_style_prefs');
  if(!s) return;
  try {
    const pref = JSON.parse(s);
    if(pref.size) document.getElementById('stSize').value = pref.size;
    if(pref.font) document.getElementById('stFont').value = pref.font;
    if(pref.color) document.getElementById('stColor').value = pref.color;
    if(pref.shadowType) document.getElementById('stShadow').value = pref.shadowType;
    if(pref.bg) document.getElementById('stBg').value = pref.bg;
    if(pref.pos) document.getElementById('stPos').value = pref.pos;
    updateSubStyles();
  } catch(_) {}
}

/**
 * يحدّث نص الترجمة الظاهر على الفيديو بناءً على زمن التشغيل الحالي.
 * تُستدعى من المحرر عند كل تعديل للنص أو التوقيت (تحديث لحظي).
 */
export function updateSubOverlayLive(){
  const v = document.getElementById('mainVideo');
  if(!v) return;
  const ct = v.currentTime;
  const active = state.blocks.find(b => {
    const s = parseTimeStringToMs(b.start) / 1000;
    const e = parseTimeStringToMs(b.end) / 1000;
    return s <= ct && ct <= e;
  });
  const subDom = document.getElementById('subTextDom');
  if(active && active.text.trim()) {
    subDom.textContent = active.text;
    subDom.style.display = 'inline-block';
  } else {
    subDom.textContent = '';
    subDom.style.display = 'none';
  }
}
