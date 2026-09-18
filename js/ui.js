/**
 * ui.js — عناصر واجهة الاستخدام العامة (Generic UI Helpers)
 *
 * المسؤولية: دوال مساعدة صغيرة عامة لا تنتمي لوحدة منطقية محددة،
 * تستخدمها عدة وحدات (إشعارات toast، فتح/إغلاق لوحة الذكاء الاصطناعي).
 */

import { state } from './state.js';

/**
 * إظهار إشعار toast مؤقت في أسفل الشاشة.
 * @param {string} msg نص الرسالة
 * @param {string} ico الأيقونة (افتراضي ✅)
 */
export function toast(msg, ico='✅'){
  const el = document.getElementById('toast');
  document.getElementById('tMsg').textContent = msg;
  document.getElementById('tIco').textContent = ico;
  el.classList.add('on'); clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 2600);
}

/**
 * فتح/إغلاق لوحة محركات الذكاء الاصطناعي القابلة للطي
 */
export function toggleAiBody() {
  const b = document.getElementById('aiBody');
  const arrow = document.getElementById('aiHeadArrow');
  const isHide = (b.style.display === 'none');
  b.style.display = isHide ? 'block' : 'none';
  arrow.textContent = isHide ? '▲' : '▼';
}

// إغلاق أي قائمة منسدلة مفتوحة عند النقر في أي مكان خارجها
// (مستمع عام مسجّل مرة واحدة عند تحميل الوحدة)
document.addEventListener('click', (e) => {
  if (!e.target.closest('.row-menu-wrap')) {
    document.querySelectorAll('.row-dropdown-menu.show').forEach(m => m.classList.remove('show'));
  }
});

// ملاحظة: state مستوردة هنا للحفاظ على توافق الاستيراد عبر الوحدات،
// حتى لو لم تستخدمها ui.js مباشرةً في كل الدوال.
export { state };
