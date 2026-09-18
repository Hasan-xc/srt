/**
 * apiClient.js — البوابة المركزية الوحيدة لكل استدعاءات الشبكة الخارجية
 *
 * المسؤولية:
 *  - تجميع كل روابط الـ API (Groq / OpenRouter / Kie.ai / corsproxy) في مكان واحد
 *  - توفير دالة موحدة apiRequest() تستدعيها كل الوحدات بدلاً من fetch() المباشر
 *  - الحفاظ على سلوك المرحلة السابقة بالضبط: نفس الهيدرات، نفس الجسم،
 *    نفس معالجة الأخطاء، وبدائل corsproxy لـ Kie.ai
 *
 * ملاحظة أمنية (تحضير للمرحلة القادمة):
 *  هذه المرحلة تنظيمية فقط — المفاتيح ما زالت تُقرأ من أماكنها الأصلية
 *  (localStorage / حقول الإدخال) ولا يلمس هذا الملف أي منطق مفاتيح.
 *  كل رابط جاهز لاحقاً للتحويل إلى مسار Backend وسيط.
 */

/* ═══════════════════════════════════════
   إعدادات نقاط الاتصال
   (القيم منقولة كما هي بالضبط من المرحلة السابقة — لا تغيير)
═════════════════════════════════════ */
export const API_ENDPOINTS = {
  // TODO: استبدال هذا لاحقاً بمسار Backend خاص
  GROQ_TRANSCRIBE: 'https://api.groq.com/openai/v1/audio/transcriptions',

  // TODO: استبدال هذا لاحقاً بمسار Backend خاص
  OPENROUTER_CHAT: 'https://openrouter.ai/api/v1/chat/completions',

  // TODO: استبدال هذا لاحقاً بمسار Backend خاص
  // (الرابط الافتراضي لـ Kie — قابل للتعديل من الواجهة عبر حقل endpoint)
  KIE_RESPONSES: 'https://api.kie.ai/codex/v1/responses',

  // TODO: استبدال هذا لاحقاً بمسار Backend خاص
  // (وكيل تجاوز CORS — يُستخدم داخلياً فقط عند فشل الاتصال المباشر بـ Kie)
  KIE_CORS_PROXY: 'https://corsproxy.io/?'
};

/**
 * الاستدعاء الموحد لكل طلبات الشبكة الخارجية.
 *
 * @param {string} endpointKey مفتاح من API_ENDPOINTS أعلاه
 * @param {object} options نفس خيارات fetch تماماً (method/headers/body...)
 *   - خاصية اختيارية إضافية: options.url — رابط ديناميكي بدل الافتراضي
 *     (تستخدمه واجهة Kie.ai لأن نقطة الاتصال قابلة للتعديل من الإعدادات)
 * @returns {Promise<Response>} استجابة fetch الأصلية بدون أي تغليف،
 *   تماماً كما كانت تستقبلها الوحدات قبل المركزية.
 */
export async function apiRequest(endpointKey, options = {}) {
  const defaultUrl = API_ENDPOINTS[endpointKey];
  if (!defaultUrl) throw new Error('نقطة اتصال غير معروفة: ' + endpointKey);

  // نفصل options.url حتى لا تُمرر لـ fetch (لا تؤثر، لكن أنظف هكذا)
  const { url: dynamicUrl, ...fetchOptions } = options;
  const targetUrl = (typeof dynamicUrl === 'string' && dynamicUrl.trim())
    ? dynamicUrl.trim()
    : defaultUrl;

  // ── مسار Kie: نفس سلوك executeKieRequest الأصلي حرفياً ──
  // محاولة مباشرة أولاً، وعند فشل الشبكة فقط (وليس عند رد غير ناجح)
  // تتم إعادة المحاولة عبر corsproxy. لو فشل الوكيل أيضاً → نفس رسالة الخطأ.
  if (endpointKey === 'KIE_RESPONSES') {
    let res;
    try {
      res = await fetch(targetUrl, fetchOptions);
    } catch (netErr) {
      const proxyUrl = API_ENDPOINTS.KIE_CORS_PROXY + encodeURIComponent(targetUrl);
      try {
        res = await fetch(proxyUrl, fetchOptions);
      } catch (proxyErr) {
        throw new Error('تعذر الاتصال بـ Kie.ai.');
      }
    }
    return res;
  }

  // ── بقية النقاط: fetch مباشر كما في الأصل تماماً (بدون أي وكيل) ──
  return fetch(targetUrl, fetchOptions);
}
