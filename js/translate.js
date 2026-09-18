/**
 * translate.js — محرك الترجمة وتحسين النصوص (OpenRouter / Kie.ai)
 *
 * المسؤولية:
 *  - بناء برومبتات الترجمة والتحسين حاللهجة المختارة
 *  - تقسيم الأسطر إلى دفعات (BATCH_SIZE) ومعالجتها
 *  - استدعاءات OpenRouter و Kie.ai (مع fallback عبر corsproxy لـ Kie)
 *  - تحليل الاستجابات (JSON / SSE / نص خام) واستخراج النتائج
 *  - إيقاف العملية، اختبار اتصال Kie.ai
 *
 * كل الاستدعاءات الآن عبر apiRequest() الموحدة في apiClient.js
 * (نفس الهيدرات، نفس الجسم، نفس معالجة الأخطاء، وcorsproxy كما هو).
 * المفاتيح تُقرأ من أماكنها الأصلية ولم تُلمس.
 */

import { state } from './state.js';
import { toast } from './ui.js';
import { renderCards } from './editor.js';
import { apiRequest, API_ENDPOINTS } from './apiClient.js';
import { getGlossaryPromptBlock } from './glossary.js';

// روابط OpenRouter/Kie أصبحت مركزية في apiClient.js
// (المفاتيح: OPENROUTER_CHAT / KIE_RESPONSES / KIE_CORS_PROXY)
const BATCH_SIZE = 40;

export function checkTrReady(){
  const btnTr = document.getElementById('trRunBtn');
  const btnRef = document.getElementById('refineRunBtn');
  const hasKey = (state.trProvider === 'kie')
    ? !!document.getElementById('kieKeyIn').value.trim()
    : !!document.getElementById('orKeyIn').value.trim();
  const hasBlocks = state.blocks.length > 0;

  if(btnTr) btnTr.disabled = !(hasKey && hasBlocks && !state.currentTask);
  if(btnRef) btnRef.disabled = !(hasKey && hasBlocks && !state.currentTask);
}

function setTrStatus(msg){ document.getElementById('trProgStatus').innerHTML = msg; }

function switchTaskUI(isRunning){
  document.getElementById('trStartBox').style.display = isRunning ? 'none' : 'flex';
  document.getElementById('trStopBox').style.display  = isRunning ? 'flex' : 'none';
}

export function cancelAiTask(){
  if(!state.currentTask) return;
  state.cancelRequested = true;
  setTrStatus('⏳ جاري إيقاف العملية بعد الدفعة الحالية...');
}

/* ════════════════════════════════════════════════════════════════
   تحليل الاستجابات (JSON / SSE / نص خام)
══════════════════════════════════════════════════════════════ */

function extractTextFromDataObj(data) {
  if (!data) return '';
  let str = '';
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.text) str += c.text;
          else if (c.delta) str += c.delta;
        }
      } else if (typeof item.text === 'string') {
        str += item.text;
      }
    }
  }
  if (data.delta) {
    if (typeof data.delta === 'string') str += data.delta;
    else if (data.delta.text) str += data.delta.text;
  }
  if (Array.isArray(data.choices)) {
    for (const ch of data.choices) {
      if (ch.message && ch.message.content) str += ch.message.content;
      if (ch.delta && ch.delta.content) str += ch.delta.content;
    }
  }
  if (typeof data.text === 'string') str += data.text;
  if (typeof data.response === 'string') str += data.response;
  return str;
}

function extractTranslationText(rawText) {
  if (!rawText) return '';
  rawText = rawText.trim();
  try {
    const data = JSON.parse(rawText);
    const ext = extractTextFromDataObj(data);
    if (ext) return ext;
  } catch(e) {}

  const lines = rawText.split('\n');
  let accumulated = '';
  let hasSse = false;
  for (let l of lines) {
    l = l.trim();
    if (l.startsWith('data:')) {
      hasSse = true;
      const jsonStr = l.slice(5).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(jsonStr);
        accumulated += extractTextFromDataObj(chunk);
      } catch(e) {}
    }
  }
  if (hasSse && accumulated) return accumulated;
  return rawText;
}

function parseResponseJSON(content) {
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
    const matchObj = clean.match(/\{[\s\S]*\}/);
    if (matchObj) {
      try { parsed = JSON.parse(matchObj[0]); } catch(e2){}
    }
    if (!parsed) {
      const matchArr = clean.match(/\[[\s\S]*\]/);
      if (matchArr) {
        try { parsed = JSON.parse(matchArr[0]); } catch(e3){}
      }
    }
  }
  if (!parsed) return null;

  let arr = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (typeof parsed === 'object' && parsed !== null) {
    arr = parsed.translations || parsed.refined || parsed.cleaned || parsed.result || parsed.data || parsed.output || parsed.lines || null;
    if (!arr) {
      const firstArr = Object.values(parsed).find(v => Array.isArray(v));
      if (firstArr) arr = firstArr;
    }
  }
  if (!Array.isArray(arr)) return null;

  return arr.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.text || item.translation || item.ar || String(item);
    return String(item ?? '');
  });
}

/* ════════════════════════════════════════════════════════════════
   بناء البرومبتات
══════════════════════════════════════════════════════════════ */

function buildTranslationPrompt(texts, srcLang, dialect) {
  const sourceLabel = (srcLang === 'auto') ? 'the source language (auto-detect)' : srcLang;

  let styleDesc = 'Modern Standard Arabic (اللغة العربية الفصحى المعاصرة) - fluent, clean, and grammatically precise';
  if(dialect === 'shami') {
    styleDesc = 'Natural spontaneous Levantine / Syrian spoken Arabic (اللهجة الشامية / السورية المحكية العفوية). Use natural colloquial Syrian phrasing naturally';
  } else if(dialect === 'masri') {
    styleDesc = 'Natural spontaneous Egyptian spoken Arabic (اللهجة المصرية العامية الدارجة). Use authentic Egyptian phrasing naturally';
  }

  // قاموس المصطلحات: قاعدة إضافية رقم 6 فقط عند وجود أزواج محفوظة.
  // القاموس فارغ؟ البرومبت يبقى مطابقاً للأصل حرفياً (صفر تغيير سلوكي).
  const glossaryBlock = getGlossaryPromptBlock();
  const glossaryRule = glossaryBlock
    ? `\n6. GLOSSARY (fixed terminology) — التزم بهذه المصطلحات الثابتة واستخدم الترجمة المحددة لها حرفياً كلما ظهر المصطلح:\n${glossaryBlock}`
    : '';

  const systemPrompt =
`You are an expert subtitle translator specialized in translating to ${styleDesc}.

STRICT RULES:
1. Translate each subtitle line into the specified Arabic dialect/style naturally and contextually.
2. Keep personal/brand names in their recognizable form.
3. Keep the EXACT SAME number of items (${texts.length}), in the SAME order. Do NOT merge, split, or reorder.
4. For empty strings, return "".
5. Output ONLY a valid JSON object with key "translations" as an array of strings.
${glossaryRule}
OUTPUT FORMAT:
{"translations": ["line 1", "line 2", ...]}`;

  const userPrompt =
`Translate the following ${texts.length} subtitle lines from ${sourceLabel} to ${styleDesc}:
${JSON.stringify(texts, null, 2)}`;

  return { systemPrompt, userPrompt };
}

function buildRefinementPrompt(texts) {
  const systemPrompt =
`You are an expert subtitle editor and proofreader.
Your task is to refine and clean speech-to-text transcriptions WITHOUT changing the meaning or deleting essential information.

STRICT RULES:
1. Correct spelling, typo, and punctuation errors.
2. Remove unintentional stuttering, false starts, and speech repetitions.
3. Smooth out broken sentences with minimal edits.
4. Standardize numbers and named entities.
5. Keep the EXACT SAME number of items (${texts.length}), in the EXACT SAME order.
6. Output ONLY a valid JSON object with key "refined" as an array of strings.

OUTPUT FORMAT:
{"refined": ["clean line 1", "clean line 2", ...]}`;

  const userPrompt =
`Refine and clean the following ${texts.length} subtitle lines:
${JSON.stringify(texts, null, 2)}`;

  return { systemPrompt, userPrompt };
}

/* ════════════════════════════════════════════════════════════════
   تشغيل المهمة (ترجمة أو تحسين) على دفعات
══════════════════════════════════════════════════════════════ */

async function runBatchAiTask(taskType) {
  const isKie = (state.trProvider === 'kie');
  const apiKey = isKie
    ? document.getElementById('kieKeyIn').value.trim()
    : document.getElementById('orKeyIn').value.trim();
  if(!apiKey) return toast(isKie ? 'أدخل Kie.ai API Key' : 'أدخل OpenRouter API Key', '⚠️');
  if(state.blocks.length === 0) return toast('لا يوجد نص للمعالجة', '⚠️');

  state.currentTask = taskType;
  state.cancelRequested = false;
  switchTaskUI(true); checkTrReady();
  document.getElementById('trProgress').style.display = 'block';
  document.getElementById('trProgBar').style.width = '0%';

  const srcLang = document.getElementById('trSrcLang').value;
  const dialect = document.getElementById('trDialect').value;
  const model   = isKie ? document.getElementById('trModelKie').value : document.getElementById('trModel').value;
  // نقطة اتصال Kie ثابتة داخلياً (API_ENDPOINTS.KIE_RESPONSES) — الحقل حُذف من الواجهة

  const total = state.blocks.length;
  let doneCount = 0;
  let failedBatches = 0;

  const taskLabel = taskType === 'refine' ? '✨ تحسين وتدقيق' : '🌍 ترجمة';

  try {
    for(let i = 0; i < total; i += BATCH_SIZE){
      if(state.cancelRequested) break;

      const batchEnd = Math.min(i + BATCH_SIZE, total);
      const batchBlocks = state.blocks.slice(i, batchEnd);
      const batchTexts = batchBlocks.map(b => b.text || '');

      setTrStatus(`${taskLabel} الدفعة ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(total/BATCH_SIZE)} &nbsp;•&nbsp; <span style="font-family:var(--mono);color:var(--yw)">${i+1} → ${batchEnd} من ${total}</span>`);

      const promptData = (taskType === 'refine')
        ? buildRefinementPrompt(batchTexts)
        : buildTranslationPrompt(batchTexts, srcLang, dialect);

      let translated = null;
      for(let attempt = 1; attempt <= 2; attempt++){
        try {
          if (isKie) {
            const raw = await executeKieRequest(promptData, model, apiKey);
            translated = parseResponseJSON(raw);
          } else {
            translated = await executeOpenRouterRequest(promptData, model, apiKey);
          }
          if (translated && Array.isArray(translated)) break;
        } catch(err){
          console.warn(`[AI Task] محاولة ${attempt} فشلت:`, err.message);
          if(attempt === 2){
            failedBatches++;
            toast(`فشلت الدفعة ${Math.floor(i/BATCH_SIZE)+1}: ${err.message}`, '⚠️');
          } else {
            await new Promise(r => setTimeout(r, 1200));
          }
        }
      }

      if(translated && Array.isArray(translated)){
        for(let j = 0; j < batchBlocks.length; j++){
          const t = translated[j];
          if(typeof t === 'string' && t.trim()){
            batchBlocks[j].text = t.trim();
          }
        }
        renderCards();
      }

      doneCount = batchEnd;
      document.getElementById('trProgBar').style.width = ((doneCount / total) * 100) + '%';
      await new Promise(r => setTimeout(r, 180));
    }

    if(state.cancelRequested){
      setTrStatus(`⏹️ تم إيقاف العملية عند السطر ${doneCount}/${total}`);
      toast('تم إيقاف العملية','⏹️');
    } else if(failedBatches > 0){
      setTrStatus(`⚠️ اكتملت مع ${failedBatches} دفعة فاشلة`);
      toast(`اكتملت العملية (${failedBatches} دفعة فشلت)`,'⚠️');
    } else {
      setTrStatus(`✅ اكتملت العملية بنجاح! (${total} سطر)`);
      toast(taskType === 'refine' ? 'تم تحسين وتدقيق النصوص بنجاح!' : 'تمت الترجمة بنجاح!','🎉');
    }
  } catch(err){
    console.error('AI Task Error:', err);
    setTrStatus('❌ خطأ: ' + (err.message || err));
    toast('حدث خطأ أثناء المعالجة','❌');
  } finally {
    state.currentTask = null;
    switchTaskUI(false);
    checkTrReady();
  }
}

export function startTranslation(){ runBatchAiTask('translate'); }
export function startTextRefinement(){ runBatchAiTask('refine'); }

/* ════════════════════════════════════════════════════════════════
   الاستدعاءات الفعلية (OpenRouter + Kie.ai)
══════════════════════════════════════════════════════════════ */

/**
 * استدعاء OpenRouter chat/completions — يعيد النص المستخرج خاماً.
 * (مُصدَّرة كي تعيد الوحدات الأخرى استخدامها، مثل enhance.js — تحسين AI.
 *  executeOpenRouterRequest تغلّفها بتحليل JSON كما كان تماماً — سلوك مطابق).
 */
export async function chatCompletion(promptData, model, apiKey){
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
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 8192
    })
  });

  if(!res.ok){
    let errMsg = `HTTP ${res.status}`;
    try { const d = await res.json(); errMsg = d?.error?.message || d?.error || errMsg; } catch(_){}
    throw new Error(errMsg);
  }

  const rawText = await res.text();
  return extractTranslationText(rawText);
}

async function executeOpenRouterRequest(promptData, model, apiKey){
  const extracted = await chatCompletion(promptData, model, apiKey);
  return parseResponseJSON(extracted);
}

export async function executeKieRequest(promptData, model, apiKey, baseUrl) {
  const combinedPrompt = `${promptData.systemPrompt}\n\n${promptData.userPrompt}`;
  let targetUrl = baseUrl || API_ENDPOINTS.KIE_RESPONSES; // الافتراضي من apiClient (نفس القيمة السابقة)
  const isChatCompletions = targetUrl.includes('/chat/completions');

  let bodyData;
  if (isChatCompletions) {
    bodyData = {
      model: model || 'gpt-5-6-luna',
      stream: false,
      messages: [
        { role: 'system', content: promptData.systemPrompt },
        { role: 'user', content: promptData.userPrompt }
      ]
    };
  } else {
    bodyData = {
      model: model || 'gpt-5-6-luna',
      stream: false,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: combinedPrompt }]
        }
      ]
    };
  }

  // المحاولة المباشرة + بدائل corsproxy عند فشل الشبكة — انتقلت كلها إلى
  // apiRequest('KIE_RESPONSES') داخل apiClient.js بنفس السلوك تماماً
  const res = await apiRequest('KIE_RESPONSES', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(bodyData),
    url: targetUrl
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const errText = await res.text();
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.message || errJson.error?.message || errJson.error || errMsg;
      } catch(_) {
        if (errText && errText.length < 200) errMsg += `: ${errText}`;
      }
    } catch(_) {}
    throw new Error(errMsg);
  }

  const rawText = await res.text();
  return extractTranslationText(rawText);
}

export async function testKieConnection() {
  const apiKey = document.getElementById('kieKeyIn').value.trim();
  // نقطة الاتصال ثابتة داخلياً الآن (الحقل حُذف من الواجهة)
  const url = API_ENDPOINTS.KIE_RESPONSES;
  const model = document.getElementById('trModelKie').value;

  if(!apiKey) return toast('أدخل مفتاح Kie.ai أولاً', '⚠️');

  const btn = document.getElementById('kieTestBtn');
  if(!btn) return toast('أداة الاختبار حُذفت من الواجهة','⚠️');
  btn.disabled = true;
  btn.textContent = '⏳ جاري الاختبار...';

  try {
    const t0 = performance.now();
    const promptData = {
      systemPrompt: 'You are a translator.',
      userPrompt: 'Translate ["Hello"] to Arabic. Output ONLY JSON: {"translations": ["مرحبا"]}'
    };
    const raw = await executeKieRequest(promptData, model, apiKey, url);
    const ms = Math.round(performance.now() - t0);
    const parsed = parseResponseJSON(raw);

    if(parsed && parsed.length > 0) {
      toast(`✅ نجح الاتصال (${ms}ms)`,'🎉');
      alert(`✅ الاتصال بـ Kie.ai يعمل بنجاح!\n\n• زمن الاستجابة: ${ms}ms\n• النموذج: ${model}\n• النتيجة: ${parsed[0]}`);
    } else {
      toast('وصل رد بصيغة غير متوقعة', '⚠️');
    }
  } catch(err) {
    alert('❌ فشل الاتصال بـ Kie.ai:\n\n' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ اختبار الاتصال بـ Kie.ai';
  }
}
