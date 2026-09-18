/**
 * video.js — مشغل الفيديو والمزامنة ثنائية الاتجاه
 *
 * المسؤولية:
 *  - تحميل الفيديو المرفوع وعرض المشغل
 *  - مزامنة الترجمة مع زمن تشغيل الفيديو (overlay)
 *  - أزرار التشغيل/التخطي/الإغلاق
 *  - تمييز السطر النشط أثناء التشغيل (highlightAndScrollRow)
 *  - تحديث شريط التقدم والمؤقت
 */

import { state } from './state.js';
import { parseTimeStringToMs } from './time.js';

/**
 * يربط مستمع change لحقل رفع الفيديو.
 * يُستدعى مرة واحدة من main.js عند بدء التشغيل.
 */
export function initVideoEvents(){
  document.getElementById('vidFileIn').addEventListener('change', function(){
    if(state.videoURL) URL.revokeObjectURL(state.videoURL);
    state.videoURL = URL.createObjectURL(this.files[0]);
    const v = document.getElementById('mainVideo');
    v.src = state.videoURL; v.load();
    document.getElementById('vidDrop').style.display = 'none';
    document.getElementById('playerWrap').style.display = 'block';

    v.addEventListener('timeupdate', () => {
      document.getElementById('timerOv').textContent = new Date(v.currentTime * 1000).toISOString().substr(11, 8);
      document.getElementById('progFill').style.width = (v.currentTime / v.duration * 100) + '%';
      document.getElementById('progThumb').style.left = (v.currentTime / v.duration * 100) + '%';

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
        highlightAndScrollRow(active.id);
      } else {
        subDom.textContent = '';
        subDom.style.display = 'none';
      }
    });
  });
}

export function togglePlay(){ const v = document.getElementById('mainVideo'); v.paused ? v.play() : v.pause(); }

export function skipVid(s){ const v = document.getElementById('mainVideo'); if(!v || !v.src) return; v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + s)); }

export function removeVideo(){
  const v = document.getElementById('mainVideo'); v.pause(); v.src = '';
  document.getElementById('vidDrop').style.display = 'flex';
  document.getElementById('playerWrap').style.display = 'none';
}

export function showVidSec(){
  document.getElementById('vidUploadBar').style.display = 'none';
  document.getElementById('vidSec').style.display = 'block';
}

/**
 * يقفز بالفيديو إلى بداية سطر محدد ويشغّله.
 * @param {number} id معرّف السطر
 */
export function jumpToBlock(id){
  const b = state.blocks.find(x => x.id === id);
  if(!b) return;
  const v = document.getElementById('mainVideo');
  const sec = parseTimeStringToMs(b.start) / 1000;
  if(v && v.src) {
    v.currentTime = sec;
    v.play();
  }
  highlightAndScrollRow(id, true);
  document.querySelectorAll('.row-dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

/**
 * يفعّل السطر المحدد ويمرره إلى داخل نطاق الرؤية في المحرر.
 * @param {number} id معرّف السطر
 * @param {boolean} forced تجاوز فحص "السطر النشط حالياً"
 */
export function highlightAndScrollRow(id, forced=false){
  if(state.activeRowId === id && !forced) return;
  state.activeRowId = id;
  document.querySelectorAll('.srt-card').forEach(r => r.classList.remove('active-row'));
  const row = document.getElementById('row-' + id);
  if(row) {
    row.classList.add('active-row');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
