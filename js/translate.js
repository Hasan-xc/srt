/**
 * translate.js — محرك الترجمة (OpenRouter / Kie.ai)
 *
 * المحاور الأساسية:
 *  - دفعات بسقفين: BATCH_SIZE=50 سطراً، MAX_BATCH_CHARS=6000 حرفاً (سقف صارم)
 *  - Worker pool (CONCURRENCY=3) بجدولة ديناميكية: أي دفعة تنتهي تبدأ التالية فوراً
 *  - تكيّف تلقائي عند 429: نزّل الحد الفعلي للتزامن، وارتفع تدريجياً بعد النجاحات
 *  - إرسال الأسطر ككائن مرقّم محلي {"1":"..","2":".."} لمنع انزلاق الأسطر
 *  - إيقاف فوري عبر AbortController مشترك يقطع كل الطلبات الجارية
 *  - معالجة الناقص: إعادة إرسال (حتى جولتين) + تقسيم الدفعة نصفين عند الفشل الكامل
 *  - زر «🔁 أعد ترجمة الناقص» للأسطر الفاشلة نهائياً (تبقى بنصها الأصلي)
 *
 * لا يحتوي على أي مفاتيح — كل الاستدعاءات عبر apiRequest() في apiClient.js.
 */

import { state } from './state.js';
import { toast } from './ui.js';
import { renderCards } from './editor.js';
import { captureHistory } from './history.js';
import { apiRequest, API_ENDPOINTS } from './apiClient.js';
import { getGlossaryPromptBlock } from './glossary.js';

/* ═══════════════════════════════════════
   الثوابت وضبط الدفعات
═══════════════════════════════════════ */
const BATCH_SIZE = 50;           // سقف صارم لعدد أسطر الدفعة — لا يزداد
const MAX_BATCH_CHARS = 6000;    // سقف احتياطي للأحرف — يُقطع قبل بلوغ 50 إذا تجاوز
const CONCURRENCY = 3;           // الحد الأقصى للتزامن
const MIN_CONCURRENCY = 1;       // أدنى حد بعد انخفاض 429
const RECOVERY_HIT = 5;          // كل هذا العدد من النجاحات المتتالية → +1 تزامن
const RETRY_ROUNDS = 2;          // جولات إضافية لإعادة إرسال الناقص فقط
const SPLIT_DEPTH = 2;           // أعمق تقسيم للدفعة الفاشلة كاملة
const REQUEST_TIMEOUT = 60000;   // مهلة كل محاولة شبكة (ثواني → 60)
const RETRY_DELAYS = [1000, 2000, 4000];  // تأخيرات الإعادة + jitter صغير

/* ═══════════════════════════════════════
   حالة تشغيل المهمة (مشتركة بين الدفعات)
═══════════════════════════════════════ */
let runAbort = null;      // AbortController مشترك — يقطع كل الطلبات الجارية دفعة واحدة
let failedIds = [];       // معرّفات الأسطر التي فشلت نهائياً (زر إعادة الناقص)

let adapt = { limit: CONCURRENCY, active: 0, okStreak: 0, saw429: false };
let doneCount = 0;
let totalCount = 0;
let fatalMsg = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ═══════════════════════════════════════
   أدوات الشبكة (مهلة + إجهاض + أخطاء)
═══════════════════════════════════════ */
function cancelledError(){
  const e = new Error('cancelled');
  e.cancelled = true;
  return e;
}

/** إشارة طلب واحدة: مهلة 60s + ربط بالإجهاض المركزي (runAbort) */
function requestSignal(){
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch(_){} }, REQUEST_TIMEOUT);
  const onCancel = () => { try { ctrl.abort(); } catch(_){} };
  if (runAbort && runAbort.signal) {
    if (runAbort.signal.aborted) { try { ctrl.abort(); } catch(_){} }
    else runAbort.signal.addEventListener('abort', onCancel);
  }
  return {
    ctrl,
    isTimeout: () => timedOut,
    cleanup(){
      clearTimeout(timer);
      if (runAbort && runAbort.signal) runAbort.signal.removeEventListener('abort', onCancel);
    }
  };
}

/** توحيد أخطاء الشبكة: إجهاض / مهلة / خطأ شبكة قابل للإعادة */
function normalizeRequestError(err, sig){
  if (err && (err.cancelled || err.fatal || err.status)) return err;
  if (runAbort && runAbort.signal && runAbort.signal.aborted) return cancelledError();
  if (sig && sig.isTimeout()){
    const e = new Error('انتهت مهلة الاستجابة (' + Math.round(REQUEST_TIMEOUT/1000) + ' ثانية)');
    e.status = 408; e.timeout = true; e.retryable = true;
    return e;
  }
  const msg = (err && err.message) ? err.message : 'فشل الاتصال بالشبكة';
  const e = new Error(msg);
  e.retryable = true;
  return e;
}

function isRetryable(err){
  if (!err) return false;
  if (err.timeout || err.retryable) return true;
  if (!err.status) return true;
  return err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504;
}

async function buildHttpError(res){
  let msg = 'HTTP ' + res.status;
  try {
    const d = await res.json();
    const cand = d?.error?.message || d?.error || d?.message || d?.detail || msg;
    msg = (typeof cand === 'string') ? cand : JSON.stringify(cand);
  } catch(_){}
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

function onStatus(status){
  if (status === 429) adapt.saw429 = true;
}

function backoff(baseMs){
  return sleep(baseMs + Math.floor(Math.random() * 150));
}

function kieFatalMessage(status, msg){
  if (status === 401) return 'مفتاح Kie.ai غير صحيح (401)';
  if (status === 402) return 'رصيد Kie.ai منتهٍ (402) — عبّئ رصيدك في لوحة Kie';
  if (status === 403) return 'غير مصرح بالوصول إلى Kie.ai (403)';
  if (status === 400) return 'طلب غير مقبول لدى Kie.ai (400): ' + (msg || '');
  return msg || ('فشل الاستدعاء من Kie.ai (' + status + ')');
}

/* ═══════════════════════════════════════
   واجهة التقدم والتحكم
═══════════════════════════════════════ */
export function checkTrReady(){
  const btnTr = document.getElementById('trRunBtn');
  const hasKey = (state.trProvider === 'kie')
    ? !!document.getElementById('kieKeyIn').value.trim()
    : !!document.getElementById('orKeyIn').value.trim();
  const hasBlocks = state.blocks.length > 0;
  if (btnTr) btnTr.disabled = !(hasKey && hasBlocks && !state.currentTask);
}

function setTrStatus(msg){
  const el = document.getElementById('trProgStatus');
  if (el) el.innerHTML = msg;
}

function switchTaskUI(isRunning){
  const sb = document.getElementById('trStartBox');
  const ob = document.getElementById('trStopBox');
  if (sb) sb.style.display = isRunning ? 'none' : 'flex';
  if (ob) ob.style.display  = isRunning ? 'flex' : 'none';
}

function updateRetryButton(){
  const btn = document.getElementById('trRetryBtn');
  if (!btn) return;
  btn.style.display = (!state.currentTask && failedIds.length > 0) ? 'flex' : 'none';
}

function updateProgress(){
  const bar = document.getElementById('trProgBar');
  const pct = totalCount ? Math.min(100, Math.round((doneCount / totalCount) * 100)) : 0;
  if (bar) bar.style.width = pct + '%';
  setTrStatus(`🌍 جارٍ الترجمة... <b>${doneCount}</b> / ${totalCount} سطراً &nbsp;•&nbsp; الحد الفعلي للتزامن: ${adapt.limit}`);
}

export function cancelAiTask(){
  if (!state.currentTask) return;
  state.cancelRequested = true;
  if (runAbort) runAbort.abort();
  setTrStatus('⏳ جاري إيقاف العملية... (تُقطع الطلبات الجارية الآن)');
  toast('جاري الإيقاف','⏹️');
}

/* ═══════════════════════════════════════
   بناء البرومبتات (كائن مرقّم لمنع انزلاق الأسطر)
═══════════════════════════════════════ */
const TARGET_LANGS = {
  'Arabic':   'Modern Standard Arabic (العربية الفصحى المعاصرة)',
  'English':  'natural, fluent English (English)',
  'Turkish':  'natural, fluent Turkish (Türkçe)',
  'Spanish':  'natural, fluent Spanish (Español)',
  'French':   'natural, fluent French (Français)',
  'German':   'natural, fluent German (Deutsch)',
  'Russian':  'natural, fluent Russian (Русский)'
};

function targetLangDesc(lang){
  return TARGET_LANGS[lang] || TARGET_LANGS['Arabic'];
}

function buildTranslationPrompt(linesObj, srcLang, targetLang){
  const sourceLabel = (srcLang === 'auto') ? 'the source language (auto-detect)' : srcLang;
  const targetDesc = targetLangDesc(targetLang);
  const count = Object.keys(linesObj).length;

  // قاموس المصطلحات: قاعدة إضافية رقم 6 فقط عند وجود أزواج محفوظة (كما كانت).
  const glossaryBlock = getGlossaryPromptBlock();
  const glossaryRule = glossaryBlock
    ? `\n6. GLOSSARY (fixed terminology) — التزم بهذه المصطلحات الثابتة واستخدم الترجمة المحددة لها حرفياً كلما ظهر المصطلح:\n${glossaryBlock}`
    : '';

  const systemPrompt =
`You are a world-class subtitle translator. Translate the source text into ${targetDesc} with high linguistic accuracy, fluency and naturalness (not literal).
Source language: ${sourceLabel}. Target language: ${targetLang}.

STRICT RULES:
1. Translate each subtitle line into ${targetDesc} naturally and contextually.
2. Keep personal/brand names in their recognizable form.
3. Return the EXACT SAME keys as the input object, with EXACTLY ONE translation per key. Do NOT merge, split, delete, reorder, or add any key.
4. For empty strings, return "".
5. Output ONLY a valid JSON object with a key "translations" that maps each input key (as a string) to its translated string.
${glossaryRule}
OUTPUT FORMAT:
{"translations": {"1": "line 1", "2": "line 2"}}`;

  const userPrompt =
`Translate the following ${count} subtitle lines from ${sourceLabel} to ${targetDesc}. Return exactly the same numbered keys, one translation per key:
${JSON.stringify(linesObj, null, 2)}`;

  return { systemPrompt, userPrompt };
}

/** تحويل الأسطر المرسلة إلى كائن مرقّم محلي — الأسطر الفارغة لا تُرسل أبداً */
function numberedObject(entries){
  const obj = {};
  for (const e of entries) obj[e.key] = (e.block.text || '').trim();
  return obj;
}

/** تقسيم الأسطر إلى دفعات وفق السقفين (50 سطراً / 6000 حرف) */
function buildBatches(blocks){
  const batches = [];
  let cur = [], curChars = 0;
  for (const block of blocks) {
    const text = (block.text || '').trim();
    if (!text) continue;
    const len = text.length;
    if (cur.length >= BATCH_SIZE || (cur.length > 0 && curChars + len > MAX_BATCH_CHARS)) {
      batches.push(cur);
      cur = []; curChars = 0;
    }
    cur.push({ key: String(cur.length + 1), block });
    curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/* ═══════════════════════════════════════
   تحليل الاستجابات (JSON / SSE / نص خام)
═══════════════════════════════════════ */
function extractTextFromDataObj(data){
  if (!data) return '';
  let str = '';

  // 1) مسار Kie responses API: output → item من نوع message → content من نوع output_text
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.type === 'output_text' && typeof c.text === 'string') str += c.text;
        }
      }
    }
    if (str) return str;

    // 2) احتياط عام: أي نص في عناصر output
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && typeof c.text === 'string') str += c.text;
          else if (c && typeof c.delta === 'string') str += c.delta;
        }
      } else if (item && typeof item.text === 'string') {
        str += item.text;
      }
    }
  }
  if (str) return str;

  if (data.delta) {
    if (typeof data.delta === 'string') str += data.delta;
    else if (data.delta.text) str += data.delta.text;
  }
  if (Array.isArray(data.choices)) {
    for (const ch of data.choices) {
      if (ch.message && ch.message.content) {
        if (Array.isArray(ch.message.content)) {
          for (const part of ch.message.content) {
            if (typeof part === 'string') str += part;
            else if (part && typeof part === 'object' && part.text) str += part.text;
          }
        } else {
          str += ch.message.content;
        }
      }
      if (ch.delta && ch.delta.content) str += ch.delta.content;
    }
  }
  if (typeof data.text === 'string') str += data.text;
  if (typeof data.response === 'string') str += data.response;
  return str;
}

function extractTranslationText(rawText){
  if (!rawText) return '';
  const text = rawText.trim();
  try {
    const data = JSON.parse(text);
    const ext = extractTextFromDataObj(data);
    if (ext) return ext;
  } catch(e){}

  const lines = text.split('\n');
  let accumulated = '';
  let hasSse = false;
  for (const l of lines) {
    const ll = l.trim();
    if (!ll.startsWith('data:')) continue;
    hasSse = true;
    const jsonStr = ll.slice(5).trim();
    if (jsonStr === '[DONE]') continue;
    try {
      const chunk = JSON.parse(jsonStr);
      accumulated += extractTextFromDataObj(chunk);
    } catch(_){}
  }
  if (hasSse && accumulated) return accumulated;
  return text;
}

/**
 * تحويل رد الموديل إلى خريطة {مفتاح: نص} بأرقام الأسطر المحلية.
 *
 * - يقبل الكائن المرقّم مباشرة: {"1":".."} أو {"translations":{"1":".."}}
 * - يقبل المصفوفة كاحتياط (متحذات OpenRouter) فقط إذا كان طولها يساوي
 *   عدد الأسطر المرسلة تماماً — وإلا تُرفض كلها (ترجع null).
 * - المفاتيح الزائدة تُتجاهل عند التطبيق (لا نقرأ إلا مفاتيح أُرسلت).
 * - @param {number|null} expectedCount عدد المفاتيح المرسلة (لضبط شرط المصفوفة)
 */
export function parseResponseJSON(content, expectedCount){
  if (!content || typeof content !== 'string') return null;
  let clean = content.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed = null;
  try {
    parsed = JSON.parse(clean);
  } catch(e) {
    const mObj = clean.match(/\{[\s\S]*\}/);
    if (mObj) { try { parsed = JSON.parse(mObj[0]); } catch(e2){} }
    if (!parsed) {
      const mArr = clean.match(/\[[\s\S]*\]/);
      if (mArr) { try { parsed = JSON.parse(mArr[0]); } catch(e3){} }
    }
  }
  if (!parsed) return null;

  function fromArray(arr){
    if (typeof expectedCount === 'number' && arr.length !== expectedCount) return null;
    const map = {};
    arr.forEach((v, i) => { map[String(i + 1)] = toStringVal(v); });
    return map;
  }

  if (Array.isArray(parsed)) return fromArray(parsed);
  if (parsed === null || typeof parsed !== 'object') return null;

  const wrapper = (parsed.translations !== undefined) ? parsed.translations
    : (parsed.result !== undefined) ? parsed.result
    : (parsed.data !== undefined) ? parsed.data
    : (parsed.output !== undefined) ? parsed.output
    : (parsed.lines !== undefined) ? parsed.lines
    : undefined;

  if (wrapper !== undefined) {
    if (Array.isArray(wrapper)) return fromArray(wrapper);
    if (wrapper && typeof wrapper === 'object') {
      const map = {};
      for (const key of Object.keys(wrapper)) map[key] = toStringVal(wrapper[key]);
      return map;
    }
    return null;
  }

  // الكائن نفسه هو الخريطة: {"1":"..","2":".."}
  const map = {};
  for (const key of Object.keys(parsed)) map[key] = toStringVal(parsed[key]);
  return map;
}

function toStringVal(v){
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.text || v.translation || v.value || String(v);
  return v == null ? '' : String(v);
}

/* ═══════════════════════════════════════
   الاستدعاءات الفعلية (OpenRouter + Kie.ai)
═══════════════════════════════════════ */

/**
 * OpenRouter chat/completions — يعيد النص المستخرج خاماً.
 * مهلة 60 ثانية + ربط بالإيقاف، والخطأ مربوط بالحالة (err.status).
 * لا نعيد المحاولة بدون response_format إلا إذا كان الخطأ 400 حصراً.
 */
export async function chatCompletion(promptData, model, apiKey){
  const doRequest = async (withJsonMode) => {
    const sig = requestSignal();
    try {
      const res = await apiRequest('OPENROUTER_CHAT', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': window.location.href,
          'X-Title': 'SRT AI Tool'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: promptData.systemPrompt },
            { role: 'user',   content: promptData.userPrompt }
          ],
          response_format: withJsonMode ? { type: 'json_object' } : undefined,
          temperature: 0.3,
          max_tokens: 8192
        }),
        signal: sig.ctrl.signal
      });
      if (!res.ok) {
        const err = await buildHttpError(res);
        onStatus(err.status);
        throw err;
      }
      return extractTranslationText(await res.text());
    } catch(err){
      if (err.status || err.cancelled || err.fatal) throw err;
      throw normalizeRequestError(err, sig);
    } finally {
      sig.cleanup();
    }
  };

  try {
    return await doRequest(true);
  } catch(err){
    if (err.status === 400) {
      console.warn('[OpenRouter] retry without response_format:', err.message);
      return await doRequest(false);
    }
    throw err;
  }
}

/**
 * Kie.ai — يعيد النص المستخرج خاماً (يُحلَّل لاحقاً بـ parseResponseJSON).
 *
 * - مهلة 60 ثانية لكل محاولة + إجهاض فوري عند الإيقاف (إشارة مشتركة)
 * - حتى 3 إعادات (1ث/2ث/4ث + jitter) لـ 429 و500 و502 و503 و504 والـ Timeout
 *   وخطأ الشبكة — لا إعادة أبداً عند 400/401/402/403 (الخطأ فادح يوقف المهمة)
 * - الخطأ مربوط بالحالة (err.status) ليستخدمه منطق 429 التكيّفي
 * - لا نجدد الرصيد ولا نضيف reasoning — الجسم كما كان (stream:false + input_text)
 */
export async function executeKieRequest(promptData, model, apiKey, baseUrl){
  const combinedPrompt = `${promptData.systemPrompt}\n\n${promptData.userPrompt}`;
  const targetUrl = baseUrl || API_ENDPOINTS.KIE_RESPONSES;
  const isChatCompletions = targetUrl.includes('/chat/completions');

  const bodyData = isChatCompletions
    ? {
        model: model || 'gpt-5-6-luna',
        stream: false,
        messages: [
          { role: 'system', content: promptData.systemPrompt },
          { role: 'user', content: promptData.userPrompt }
        ]
      }
    : {
        model: model || 'gpt-5-6-luna',
        stream: false,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: combinedPrompt }] }
        ]
      };

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (runAbort && runAbort.signal.aborted) throw cancelledError();

    const sig = requestSignal();
    let res;
    try {
      res = await apiRequest('KIE_RESPONSES', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(bodyData),
        url: targetUrl,
        signal: sig.ctrl.signal
      });
    } catch(err){
      sig.cleanup();
      if (err.cancelled) throw err;
      const norm = normalizeRequestError(err, sig);
      onStatus(norm.status);
      if (isRetryable(norm) && attempt < RETRY_DELAYS.length) {
        await backoff(RETRY_DELAYS[attempt]);
        continue;
      }
      throw norm;
    }
    sig.cleanup();

    if (!res.ok) {
      const err = await buildHttpError(res);
      err.status = res.status;
      onStatus(err.status);
      if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504) {
        if (attempt < RETRY_DELAYS.length) {
          await backoff(RETRY_DELAYS[attempt]);
          continue;
        }
        throw err;
      }
      // 400/401/402/403 وغيرها: خطأ فادح — يوقف المهمة كلها
      err.fatal = true;
      err.fatalMessage = kieFatalMessage(err.status, err.message);
      throw err;
    }

    const rawText = await res.text();

    // حالة الرد (responses API): إن وُجدت ولم تكن completed فهي فشل قابل للإعادة
    const dataStatus = peekResponseStatus(rawText);
    if (dataStatus && dataStatus !== 'completed') {
      const err = new Error('حالة رد Kie.ai: ' + dataStatus);
      err.status = 502;
      err.retryable = true;
      if (attempt < RETRY_DELAYS.length) {
        await backoff(RETRY_DELAYS[attempt]);
        continue;
      }
      throw err;
    }

    return extractTranslationText(rawText);
  }
}

function peekResponseStatus(rawText){
  try {
    const j = JSON.parse(rawText);
    if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.status === 'string') return j.status;
  } catch(_){}
  return null;
}

/* ═══════════════════════════════════════
   تنفيذ الترجمة (دفعات + تجمّع عامل + تكيّف 429)
═══════════════════════════════════════ */
async function sendBatchRequest(ctx, payload){
  const promptData = buildTranslationPrompt(payload, ctx.srcLang, ctx.targetLang);
  if (ctx.isKie) return await executeKieRequest(promptData, ctx.model, ctx.apiKey);
  return await chatCompletion(promptData, ctx.model, ctx.apiKey);
}

/**
 * ترجمة مجموعة أسطر مع جولات الناقص (نفس أرقامها الأصلية) وتقسيم النصف عند الفشل الكامل.
 * @param {Array<{key:string, block:object}>} pending أسطر الدفعة
 * @param {object} ctx سياق الطلب
 * @param {number} depth عمق التقسيم الحالي
 * @returns {Promise<{applied:Array, failed:Array}>}
 */
async function translateGroup(pending, ctx, depth){
  let current = pending.filter(e => (e.block.text || '').trim() !== '');
  if (!current.length) return { applied: [], failed: [] };
  const applied = [];

  for (let round = 0; round <= RETRY_ROUNDS; round++) {
    if (runAbort && runAbort.signal.aborted) return { applied, failed: [] };

    const payload = numberedObject(current);
    const keysCount = Object.keys(payload).length;
    if (!keysCount) return { applied, failed: [] };

    let raw = null;
    let hardError = null;
    try {
      raw = await sendBatchRequest(ctx, payload);
    } catch(err){
      if (err && err.cancelled) return { applied, failed: [] };
      if (err && err.fatal) throw err;
      hardError = err;
    }

    const got = (!hardError && raw) ? (parseResponseJSON(raw, keysCount) || {}) : {};

    if (runAbort && runAbort.signal.aborted) return { applied, failed: [] };

    // نحقق فقط في المفاتيح المرسلة — التطبيق بالربط عبر المفتاح على كائن block نفسه
    const appliedKeys = new Set();
    for (const e of current) {
      const t = got[e.key];
      if (typeof t === 'string' && t.trim()) {
        e.block.text = t.trim();
        applied.push(e);
        appliedKeys.add(e.key);
      }
    }
    const missing = current.filter(e => !appliedKeys.has(e.key));

    // فشل كامل أو صفر نتائج → تقسيم النصفين (عمق أقصى 2) لكل نصف مستقل
    if (hardError || missing.length === current.length) {
      if (missing.length > 10 && depth < SPLIT_DEPTH) {
        const mid = Math.ceil(missing.length / 2);
        const [a, b] = await Promise.all([
          translateGroup(missing.slice(0, mid), ctx, depth + 1),
          translateGroup(missing.slice(mid), ctx, depth + 1)
        ]);
        return { applied: applied.concat(a.applied, b.applied), failed: a.failed.concat(b.failed) };
      }
      return { applied, failed: missing };
    }

    if (!missing.length) return { applied, failed: [] };

    // إعادة إرسال الناقص فقط بنفس أرقامه الأصلية (جولة إضافية)
    current = missing;
    if (round < RETRY_ROUNDS) await sleep(150 + Math.round(Math.random() * 100));
  }

  return { applied, failed: current };
}

/* ── تجمّع العامل (worker pool) بجدولة ديناميكية ── */
async function acquireSlot(){
  while (adapt.active >= adapt.limit) {
    if (runAbort && runAbort.signal.aborted) throw cancelledError();
    await sleep(30);
  }
  adapt.active++;
}

function releaseSlot(){
  adapt.active = Math.max(0, adapt.active - 1);
  if (adapt.saw429) {
    adapt.limit = Math.max(MIN_CONCURRENCY, adapt.limit - 1);
    adapt.okStreak = 0;
  } else {
    adapt.okStreak++;
    if (adapt.okStreak >= RECOVERY_HIT && adapt.limit < CONCURRENCY) {
      adapt.limit++;
      adapt.okStreak = 0;
    }
  }
  adapt.saw429 = false;
}

async function runTask(targetIds){
  const isKie = (state.trProvider === 'kie');
  const apiKey = isKie
    ? document.getElementById('kieKeyIn').value.trim()
    : document.getElementById('orKeyIn').value.trim();
  if (!apiKey) return toast(isKie ? 'أدخل Kie.ai API Key' : 'أدخل OpenRouter API Key', '⚠️');

  let candidates = state.blocks.filter(b => (b.text || '').trim() !== '');
  if (targetIds) {
    const wanted = new Set(targetIds);
    candidates = candidates.filter(b => wanted.has(b.id)); // الموجودة فعلاً فقط
  }
  if (!candidates.length) return toast(targetIds ? 'لا توجد أسطر ناقصة متبقية' : 'لا يوجد نص للمعالجة', '⚠️');

  // إعادة ضبط سياق التشغيل
  failedIds = [];
  doneCount = 0;
  totalCount = 0;
  fatalMsg = null;
  adapt = { limit: CONCURRENCY, active: 0, okStreak: 0, saw429: false };
  runAbort = new AbortController();
  state.currentTask = 'translate';
  state.cancelRequested = false;

  switchTaskUI(true);
  updateRetryButton();
  checkTrReady();
  document.getElementById('trProgress').style.display = 'block';
  updateProgress();

  // لقطة واحدة قبل كل الترجمة → التراجع يعيد كل الأسطر بخطوة واحدة (لا لقطات للدفعات)
  captureHistory();

  const srcLang    = document.getElementById('trSrcLang').value;
  const targetLang = document.getElementById('trTargetLang').value;
  const model      = isKie ? document.getElementById('trModelKie').value : document.getElementById('trModel').value;
  const ctx = { isKie, apiKey, model, srcLang, targetLang };

  const batches = buildBatches(candidates);
  totalCount = batches.reduce((s, b) => s + b.length, 0);
  let nextIdx = 0;

  async function worker(){
    while (true) {
      if (runAbort && runAbort.signal.aborted) return;
      if (fatalMsg) return;
      const idx = nextIdx++;
      if (idx >= batches.length) return;

      try { await acquireSlot(); } catch(_) { return; }
      if ((runAbort && runAbort.signal.aborted) || fatalMsg) { releaseSlot(); return; }

      try {
        const res = await translateGroup(batches[idx], ctx, 0);
        doneCount += res.applied.length;
        for (const e of res.failed) {
          if (!failedIds.includes(e.block.id)) failedIds.push(e.block.id);
        }
      } catch(err){
        if (err && err.fatal) {
          fatalMsg = err.fatalMessage || err.message;
          if (runAbort && !runAbort.signal.aborted) runAbort.abort();
        } else {
          console.warn('[translate] batch error:', (err && err.message) || err);
        }
      } finally {
        releaseSlot();
        updateProgress();
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, batches.length);
  const workers = [];
  for (let k = 0; k < workerCount; k++) workers.push(worker());
  await Promise.all(workers);

  // عرض النتائج مرة واحدة فقط بعد انتهاء كل الدفعات (لتجنب إغراق سجل التراجع)
  if (fatalMsg) {
    setTrStatus('❌ ' + fatalMsg);
    toast(fatalMsg, '❌');
  } else if (runAbort && runAbort.signal.aborted) {
    setTrStatus(`⏹️ توقفت العملية — تُرجم فعلياً <b>${doneCount}</b> / ${totalCount} سطراً`);
    toast('تم إيقاف العملية','⏹️');
  } else if (failedIds.length) {
    setTrStatus(`✅ اكتملت — تُرجم <b>${doneCount}</b> / ${totalCount} سطراً • <b style="color:var(--rd)">${failedIds.length}</b> خط ناقص 🔁`);
    toast(`اكتملت الترجمة (${failedIds.length} سطراً ناقصاً — أعد ترجمتها)`, '⚠️');
  } else {
    setTrStatus(`✅ اكتملت الترجمة بنجاح! (${doneCount} سطر)`);
    toast('تمت الترجمة بنجاح!','🎉');
  }

  renderCards();

  state.currentTask = null;
  state.cancelRequested = false;
  runAbort = null;
  switchTaskUI(false);
  updateRetryButton();
  checkTrReady();
}

export function startTranslation(){
  if (state.currentTask) return;
  return runTask(null);
}

export async function retryMissingTranslation(){
  if (state.currentTask) return;
  if (!failedIds.length) return toast('لا توجد أسطر ناقصة','ℹ️');
  await runTask(failedIds.slice());
}

/* ═══════════════════════════════════════
   اختبار اتصال Kie.ai (متوافق مع صيغة الكائن المرقّم)
═══════════════════════════════════════ */
export async function testKieConnection() {
  const apiKey = document.getElementById('kieKeyIn').value.trim();
  const url = API_ENDPOINTS.KIE_RESPONSES;
  const model = document.getElementById('trModelKie').value;

  if (!apiKey) return toast('أدخل مفتاح Kie.ai أولاً', '⚠️');

  const btn = document.getElementById('kieTestBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري الاختبار...'; }

  try {
    const t0 = performance.now();
    const promptData = {
      systemPrompt: 'You are a translator.',
      userPrompt: 'Translate the object {"1": "Hello"} to Arabic. Output ONLY JSON: {"translations": {"1": "مرحبا"}}'
    };
    const raw = await executeKieRequest(promptData, model, apiKey, url);
    const ms = Math.round(performance.now() - t0);
    const parsed = parseResponseJSON(raw, 1);
    const first = parsed ? Object.values(parsed)[0] : null;

    if (typeof first === 'string' && first.trim()) {
      toast(`✅ نجح الاتصال (${ms}ms)`,'🎉');
      alert(`✅ الاتصال بـ Kie.ai يعمل بنجاح!\n\n• زمن الاستجابة: ${ms}ms\n• النموذج: ${model}\n• النتيجة: ${first}`);
    } else {
      toast('وصل رد بصيغة غير متوقعة', '⚠️');
    }
  } catch(err) {
    alert('❌ فشل الاتصال بـ Kie.ai:\n\n' + (err.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ اختبار الاتصال بـ Kie.ai'; }
  }
}