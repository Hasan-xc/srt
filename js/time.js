/**
 * time.js — دوال مساعدة للتوقيتات (Time Helpers)
 *
 * المسؤولية: التحويل بين الصيغ الزمنية المختلفة المستخدمة في ملفات SRT
 * وواجهة المحرر. لا تعتمد على أي DOM أو حالة — دوال نقية قابلة لإعادة الاستخدام.
 */

/**
 * يحوّل المللي ثانية إلى صيغة SRT القياسية: HH:MM:SS,mmm
 */
export const formatMs = (ms) => {
  ms = Math.max(0, Math.round(ms));
  const h = String(Math.floor(ms/3600000)).padStart(2,'0');
  const m = String(Math.floor(ms%3600000/60000)).padStart(2,'0');
  const s = String(Math.floor(ms%60000/1000)).padStart(2,'0');
  const mm = String(Math.floor(ms%1000)).padStart(3,'0');
  return `${h}:${m}:${s},${mm}`;
};

/**
 * يحوّل نص توقيت (مثل "01:23,5" أو "1:02:03.456") إلى مللي ثانية
 */
export function parseTimeStringToMs(timeStr) {
  if(!timeStr) return 0;
  let str = String(timeStr).replace(',', '.');
  let parts = str.split(':');
  let ms = 0;
  if (parts.length === 2) ms = (parseInt(parts[0]) * 60 + parseFloat(parts[1])) * 1000;
  else if (parts.length === 3) ms = (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])) * 1000;
  return Math.round(ms);
}

/**
 * صيغة مختصرة للعرض داخل بطاقات المحرر: MM:SS.s
 */
export function fmtTimeShort(tc){
  if(!tc) return '00:00.0';
  const p = tc.split(':');
  if(p.length === 3){
    const m = parseInt(p[1], 10);
    const s_ms = p[2].replace(',', '.');
    return `${String(m).padStart(2,'0')}:${s_ms.substring(0,4)}`;
  }
  return tc;
}

/**
 * يحوّل أي صيغة توقيت مدخلة يدوياً إلى الصيغة القياسية HH:MM:SS,mmm
 */
export function toStandardTime(tc){
  if(!tc) return "00:00:00,000";
  let p = String(tc).replace('.', ',').split(':');
  let h=0, m=0, s_ms="00,000";
  if (p.length === 3) { h = parseInt(p[0])||0; m = parseInt(p[1])||0; s_ms = p[2]; }
  else if (p.length === 2) { m = parseInt(p[0])||0; s_ms = p[1]; }
  else { s_ms = p[0]; }
  let s_parts = s_ms.split(',');
  let s = parseInt(s_parts[0])||0;
  let ms = (s_parts[1]||"000").padEnd(3, '0').substring(0,3);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${ms}`;
}
