/**
 * kie-proxy.js — Cloudflare Worker (اختياري) لتفادي خطأ CORS في Kie.ai
 *
 * طريقة الاستخدام:
 *  1) أنشئ Worker جديداً في Cloudflare Worker والصق كل هذا الملف.
 *  2) ضع متغير البيئة ALLOWED_ORIGIN = رابط تطبيقك (مثل https://example.com)
 *  3) انشره وانقل رابطه إلى KIE_PROXY_URL في js/apiClient.js
 *
 * الأمان:
 *  - لا يُخزَّن أي مفتاح — يُمرر طلب POST للمتصفح إلى وكيل Kie كما هو
 *    (body + ترويسة Authorization) مع إعادة الرد كما هو.
 *  - يُرفض كل طلب مصدره غير المصرَّح به أو غير أصل البوابة (باستثناء OPTIONS).
 */

if (!globalThis.__kieProxyFetchedBodies) {
  // عداد اختياري للمساعدة في تصحيح الأخطاء داخل Logs الخاص بـ Cloudflare
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const origin = (request.headers.get('Origin') || '').trim();
  const allowedOrigin = (typeof ALLOWED_ORIGIN === 'string' && ALLOWED_ORIGIN.trim())
    ? ALLOWED_ORIGIN.trim()
    : '';

  // منع إعدادات fetch من السماح بالمصدر المفتوح
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Kie-Request-Id',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };

  if (allowedOrigin && origin && origin !== allowedOrigin) {
    if (origin !== allowedOrigin) {
      if (request.method === 'OPTIONS') {
        return new Response('', { status: 403, headers: corsHeaders });
      }
      return new Response('Forbidden origin', { status: 403, headers: corsHeaders });
    }
  }

  // OPTIONS: معالجة preflight الخاصة بالمتصفح
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 403, headers: corsHeaders });
  }

  const target = 'https://api.kie.ai/codex/v1/responses';

  const upstream = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': request.headers.get('Content-Type') || 'application/json',
      'Authorization': request.headers.get('Authorization') || ''
    },
    body: request.body,
    redirect: 'follow'
  });

  const responseHeaders = new Headers(upstream.headers);
  for (const key of Object.keys(corsHeaders)) {
    responseHeaders.set(key, corsHeaders[key]);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export default {
  fetch: handleRequest
};