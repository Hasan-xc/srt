/**
 * apiClient.js — البوابة المركزية الوحيدة لكل استدعاءات الشبكة الخارجية
 *
 * المسؤولية:
 *  - تجميع كل روابط الـ API (Groq / OpenRouter / Kie.ai) في مكان واحد
 *  - توفير دالة موحدة apiRequest() تستدعيها كل الوحدات بدلاً من fetch() المباشر
 *  - دعم وكيل CORS اختياري لـ Kie.ai عبر KIE_PROXY_URL (Worker خاص)
 *
 * ملاحظة أمنية:
 *  لا يحتوي هذا الملف على أي مفاتيح — المفاتيح تُقرأ من حقول الإدخال
 *  و localStorage في أماكنها الأصلية، ولا تُمرر إلا في ترويسة Authorization
 *  كالمعتاد.
 */

/* ═══════════════════════════════════════
   إعدادات نقاط الاتصال
═══════════════════════════════════════ */
export const API_ENDPOINTS = {
  GROQ_TRANSCRIBE: 'https://api.groq.com/openai/v1/audio/transcriptions',

  OPENROUTER_CHAT: 'https://openrouter.ai/api/v1/chat/completions',

  KIE_RESPONSES: 'https://api.kie.ai/codex/v1/responses'
};

/**
 * وكيل CORS اختياري لـ Kie.ai.
 * فارغ = اتصال مباشر. عند تعبئته برابط وكيل خاص يعاد توجيه الطلب إلى
 * نفس الواجهة مع تمرير ترويسة Authorization كما هي.
 * اتركه فارغاً ما لم تواجه أخطاء CORS في المتصفح.
 */
export const KIE_PROXY_URL = '';

const KIE_NET_ERROR =
  'تعذر الاتصال بـ Kie.ai. تحقق من الإنترنت أو من المفتاح ثم أعد المحاولة.';

/**
 * الاستدعاء الموحد لكل طلبات الشبكة الخارجية.
 *
 * @param {string} endpointKey مفتاح من API_ENDPOINTS أعلاه
 * @param {object} options نفس خيارات fetch تماماً (method/headers/body/signal...)
 *   - خاصية اختيارية إضافية: options.url — رابط ديناميكي بدل الافتراضي
 * @returns {Promise<Response>} استجابة fetch الأصلية بدون أي تغليف
 */
export async function apiRequest(endpointKey, options = {}) {
  const defaultUrl = API_ENDPOINTS[endpointKey];
  if (!defaultUrl) throw new Error('نقطة اتصال غير معروفة: ' + endpointKey);

  const { url: dynamicUrl, ...fetchOptions } = options;
  const dyn = (typeof dynamicUrl === 'string' && dynamicUrl.trim()) ? dynamicUrl.trim() : '';

  // ── مسار Kie: رابط الوكيل يسبق الاتصال المباشر إذا كان مضبوطاً ──
  // عند فشل الشبكة (CORS) نرمي خطأً واضحاً يشير إلى إعداد الوكيل،
  // لكن أخطاء الإجهاض/المهلة (AbortError) تمر للمتصل كما هي.
  if (endpointKey === 'KIE_RESPONSES') {
    const proxy = (typeof KIE_PROXY_URL === 'string' && KIE_PROXY_URL.trim()) ? KIE_PROXY_URL.trim() : '';
    const target = proxy || dyn || API_ENDPOINTS.KIE_RESPONSES;
    try {
      return await fetch(target, fetchOptions);
    } catch (netErr) {
      if (netErr && netErr.name === 'AbortError') throw netErr; // إيقاف/مهلة — يعالجه المتصل
      throw new Error(KIE_NET_ERROR);
    }
  }

  // ── بقية النقاط: fetch مباشر (بدون أي وكيل) ──
  return fetch(dyn || defaultUrl, fetchOptions);
}
