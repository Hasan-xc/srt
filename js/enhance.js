/**
 * enhance.js — «تحسين بـ AI»: إعادة صياغة ترجمة الـSRT باحترافية كاملة
 *
 * المسؤولية:
 *  - زر «🤖 تحسين بـ AI» في شريط أدوات المحرر (بجانب سطر/تراجع/إعادة)
 *  - يرسل ملف الـSRT كامل إلى الموديل (نفس مزوّد الترجمة: OpenRouter أو Kie.ai)
 *    على دفعات ذكية مع سياق قبل/بعد كل دفعة حتى لا يُقطع المعنى
 *  - الموديل يعمل كمترجم/محرر ترجمة محترف: ترجمة طبيعية + تقسيم معنوي
 *    للجمل الطويلة + إعادة توزيع التوقيت داخل نافذة كل سطر
 *  - تحقق صارم محلياً من كل ناتج: أزمنة صالحة، لا تداخل، تسلسل زمني،
 *    وfallback للتوزيع النسبي بطول النص عند ردود غير صالحة
 *  - لا يفقد أي سطر أبداً: السطر الذي لا يعود له ناتج يبقى كما هو
 *  - التراجع/الإعادة يعملان على العملية كاملة (لقطة قبل البدء عبر renderCards)
 *
 * لا يضيف أي API جديد: يستخدم نفس نقاط apiClient (OPENROUTER_CHAT /
 * KIE_RESPONSES) ودوال translate.js المُصدَّرة (chatCompletion / executeKieRequest)
 * ونفس المفاتيح من حقول الواجهة (localStorage) — لا مفتاح في الكود إطلاقاً.
 */

import { state } from './state.js';
import { toast } from './ui.js';
import { renderCards } from './editor.js';
import { captureHistory } from './history.js';
import { getGlossaryPromptBlock } from './glossary.js';
import { parseTimeStringToMs, formatMs } from './time.js';
import { chatCompletion, executeKieRequest } from './translate.js';

const ENH_BATCH_SIZE   = 14;  // عدد عناصر SRT في الدفعة الواحدة (صغير = JSON سليم وردود أسرع)
const ENH_CONTEXT_LINES = 3;  // أسطر السياق (قبل/بعد) المرفقة مع كل دفعة
const ENH_MIN_DUR      = 500; // أقل مدة عرض مريحة للقراءة (ms)
const ENH_MIN_DUR_HARD = 200; // أقل مدة مقبولة مطلقاً عند تضييق النافذة (ms)
const ENH_GAP_MARGIN   = 50;  // هامش أمان قبل بداية السطر التالي (ms)

/* ════════════════════════════════════════════════════════════════
   الزر: بدء التحسين / إيقافه أثناء العمل
════════════════════════════════════════════════════════════════ */

function setEnhBtn(txt){
  const b = document.getElementById('aiEnhanceBtn');
  if(b) b.textContent = txt;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function startAiEnhance(){
  // أثناء التشغيل: الزر يتحول إلى زر إيقاف
  if(state.currentTask === 'enhance'){
    state.cancelRequested = true;
    setEnhBtn('⏳ جاري الإيقاف...');
    return;
  }
  if(state.currentTask) return toast('هناك مهمة أخرى قيد التنفيذ حالياً','⚠️');

  const isKie = (state.trProvider === 'kie');
  const apiKey = isKie
    ? document.getElementById('kieKeyIn').value.trim()
    : document.getElementById('orKeyIn').value.trim();
  if(!apiKey) return toast(isKie ? 'أدخل Kie.ai API Key أولاً' : 'أدخل OpenRouter API Key أولاً','⚠️');
  if(state.blocks.length === 0) return toast('لا يوجد ملف ترجمة لتحسينه','⚠️');

  // عناصر صالحة للتحسين فقط (الأسطر الفارغة/ذات التوقيت الخاطئ تبقى كما هي)
  const items = state.blocks
    .map((b, idx) => ({
      idx, i: idx + 1,
      s: parseTimeStringToMs(b.start),
      e: parseTimeStringToMs(b.end),
      t: (b.text || '').trim()
    }))
    .filter(it => it.t !== '' && it.e > it.s);
  if(!items.length) return toast('لا يوجد نص صالح للتحسين','⚠️');

  // خريطة ثابتة: رقم السطر الأصلي (1-based) → معرّف البلوك
  // (تبقى صالحة حتى بعد إدراج أسطر جديدة أثناء معالجة الدفعات)
  const numToId = state.blocks.map(b => b.id);

  const btn = document.getElementById('aiEnhanceBtn');
  const label = btn ? btn.textContent : '🤖 تحسين بـ AI';

  state.currentTask = 'enhance';
  state.cancelRequested = false;
  try { captureHistory(); } catch(_){} // لقطة كاملة قبل أي تغيير (للتراجع)
  setEnhBtn('🤖 جاري تحليل ملف الترجمة...');
  toast('جاري تحليل ملف الترجمة...','🤖');

  const dialect  = document.getElementById('trDialect').value;
  const srcLang  = document.getElementById('trSrcLang').value;
  const model    = isKie ? document.getElementById('trModelKie').value : document.getElementById('trModel').value;
  // نقطة اتصال Kie ثابتة داخلياً (API_ENDPOINTS.KIE_RESPONSES) — الحقل حُذف من الواجهة

  // بناء الدفعات: نواة + سياق قبل/بعد (لل فهم فقط، لا تُعاد)
  const batches = [];
  for(let x = 0; x < items.length; x += ENH_BATCH_SIZE){
    const core = items.slice(x, x + ENH_BATCH_SIZE);
    const firstIdx = core[0].idx, lastIdx = core[core.length - 1].idx;
    const before = items.filter(it => it.idx < firstIdx).slice(-ENH_CONTEXT_LINES);
    const after  = items.filter(it => it.idx > lastIdx).slice(0, ENH_CONTEXT_LINES);
    batches.push({ core, before, after });
  }

  let doneBatches = 0, failedBatches = 0, addedLines = 0;

  try {
    for(const { core, before, after } of batches){
      if(state.cancelRequested) break;
      const pct = Math.round((doneBatches / batches.length) * 100);
      setEnhBtn(`🤖 ${pct}% — جاري تحسين الترجمة والتقسيم والتوقيت...`);

      const promptData = buildEnhancePrompt(core, before, after, srcLang, dialect);
      let segs = null;
      for(let attempt = 1; attempt <= 2; attempt++){
        try {
          const raw = isKie
            ? await executeKieRequest(promptData, model, apiKey)
            : await chatCompletion(promptData, model, apiKey);
          const parsed = parseEnhanceResponse(raw);
          if(parsed){ segs = parsed; break; }
          console.warn('[AI Enhance] رد غير قابل للتحليل في المحاولة', attempt);
        } catch(err){
          console.warn(`[AI Enhance] محاولة ${attempt} فشلت:`, err.message);
          if(attempt < 2) await sleep(1200);
        }
      }

      if(segs && segs.length){
        addedLines += applySegments(segs, core, numToId);
        renderCards(); // عرض تدريجي + لقطة تاريخ + حفظ تلقائي
      } else {
        failedBatches++;
        toast(`فشلت دفعة ${doneBatches + 1} — ستبقى أسطرها كما هي`,'⚠️');
      }

      doneBatches++;
      await sleep(180);
    }

    if(state.cancelRequested){
      toast('تم إيقاف التحسين — يمكنك التراجع أو المتابعة لاحقاً','⏹️');
    } else if(failedBatches === 0){
      const before_ = numToId.length, after_ = state.blocks.length;
      toast(`تم تحسين الملف: ${before_} سطر → ${after_} سطر`,'🎉');
    } else if(failedBatches < batches.length){
      toast(`اكتمل التحسين (${failedBatches} دفعة فشلت وبقيت كما هي)`,'⚠️');
    } else {
      toast('فشل كل الدفعات — لم يتغير الملف. تحقق من المفتاح/الموديل','❌');
    }
  } catch(err){
    console.error('[AI Enhance] error:', err);
    toast('حدث خطأ أثناء التحسين: ' + (err.message || err),'❌');
  } finally {
    state.currentTask = null;
    state.cancelRequested = false;
    setEnhBtn(label);
    renderCards();
  }
}

/* ════════════════════════════════════════════════════════════════
   البرومبت: مترجم SRT محترف (ترجمة + تقسيم معنوي + توقيت)
════════════════════════════════════════════════════════════════ */

function buildEnhancePrompt(core, before, after, srcLang, dialect){
  let styleDesc = 'Modern Standard Arabic — fluent, clean, contemporary (فصحى معاصرة سليمة وطليقة، ليست حرفية)';
  if(dialect === 'shami'){
    styleDesc = 'Natural spontaneous Levantine/Syrian spoken Arabic (اللهجة الشامية المحكية الطبيعية)';
  } else if(dialect === 'masri'){
    styleDesc = 'Natural spontaneous Egyptian spoken Arabic (اللهجة المصرية العامية الطبيعية)';
  }
  const srcHint = (srcLang && srcLang !== 'auto')
    ? `The video's source language is ${srcLang}; if a text is still in that language, translate it.`
    : 'Auto-detect the source language; if a text is not Arabic yet, translate it.';
  const glossaryBlock = getGlossaryPromptBlock();
  const glossaryRule = glossaryBlock
    ? `\n8. GLOSSARY (fixed terminology) — use these EXACT translations whenever these terms appear:\n${glossaryBlock}`
    : '';

  const systemPrompt =
`You are a world-class professional subtitle editor and Arabic subtitle translator with 20 years of experience in broadcast/film subtitles.

You receive the CURRENT subtitles of one video as JSON items: "i" = original subtitle number, "s"/"e" = start/end time in MILLISECONDS, "t" = current text. The text may already be an Arabic translation (possibly literal, robotic, or written as long unreadable paragraphs), or may still be in its original source language.

YOUR MISSION — return subtitles as if a professional human subtitle specialist had fully re-edited the file:

1. CONTEXT FIRST: dialogue often continues across consecutive items. Use CONTEXT BEFORE/AFTER to understand the complete idea (they are for understanding ONLY — never return segments for them).

2. NATURAL ARABIC: rewrite as a professional translator for a series/film — ${styleDesc}. ${srcHint} Never literal/Google-style.

3. MEANING RULES:
   - Keep names of people/places/brands correct and recognizable.
   - Do NOT add information that is not in the original speech.
   - Do NOT delete important meaning just to make it shorter.
   - Do NOT change the speaker's meaning or tone.
   - Remove only obvious transcription noise (stutters/false starts) if present.

4. SEGMENTATION (very important):
   - A subtitle must be instantly readable while watching — NEVER a long paragraph.
   - If a subtitle contains two or more independent sentences, split them into separate subtitles at natural, meaningful boundaries.
   - Split based on MEANING, sentence structure and reading speed — never randomly, never mid-phrase, never between connected words.
   - Result: short, comfortable, natural subtitles.

5. TIMING (very important):
   - When you split item i into N parts, redistribute its time window [s..e] logically across the parts, proportional to text length and reading speed.
   - Return ABSOLUTE milliseconds, same clock as the input.
   - For every part: start < end. Parts of the same item must not overlap. Keep chronological order.
   - You may slightly extend the last part into the free gap after the item (if the next item starts later), but never beyond (next item start - 50ms).

6. STRUCTURE: every output segment must reference the ORIGINAL item number in "i". Do NOT merge two different original items into one segment. Do NOT reorder. Items with empty text are skipped (no segments).

7. COVERAGE: the result must cover ALL items listed under CURRENT SUBTITLES (each item gets one or more segments, in order).${glossaryRule}

OUTPUT FORMAT — ONLY a valid JSON object, no markdown, no comments:
{"subs":[{"i":12,"s":10000,"e":12500,"t":"مرحباً يا أصدقاء."},{"i":12,"s":12500,"e":16000,"t":"اليوم سنتحدث عن التسجيل."}]}`;

  const userPrompt =
`Improve, split and re-time the CURRENT SUBTITLES of this batch:

CURRENT SUBTITLES:
${JSON.stringify(core.map(c => ({ i: c.i, s: c.s, e: c.e, t: c.t })))}

CONTEXT BEFORE (understanding only — do NOT return):
${JSON.stringify(before.map(c => ({ i: c.i, s: c.s, e: c.e, t: c.t })))}

CONTEXT AFTER (understanding only — do NOT return):
${JSON.stringify(after.map(c => ({ i: c.i, s: c.s, e: c.e, t: c.t })))}`;

  return { systemPrompt, userPrompt };
}

/* ════════════════════════════════════════════════════════════════
   تحليل الرد: استخراج مصفوفة المقاطع {i, s, e, t}
════════════════════════════════════════════════════════════════ */

/**
 * يبحث في النص عن أول كائن JSON متوازن الأقواس ويستخرجه
 * (يتجاهل الأقواس داخل النصوص المقتبسة) — مقاوم للردود الزائدة.
 */
function extractBalancedObject(str){
  const start = str.indexOf('{');
  if(start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for(let i = start; i < str.length; i++){
    const ch = str[i];
    if(esc){ esc = false; continue; }
    if(ch === '\\'){ esc = true; continue; }
    if(ch === '"'){ inStr = !inStr; continue; }
    if(inStr) continue;
    if(ch === '{') depth++;
    else if(ch === '}'){
      depth--;
      if(depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

export function parseEnhanceResponse(raw){
  try {
    if(!raw || typeof raw !== 'string') return null;
    // تنظيف شامل: BOM + ماركداون (أسوار الكود، backticks) + أحرف تحكم
    let clean = raw
      .replace(/^\uFEFF/, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/`/g, '')
      .trim();
    let parsed = null;
    // 1) النص كله JSON مباشرة
    try { parsed = JSON.parse(clean); } catch(_){}
    // 2) أول كائن {...} متوازن (يتسامح مع أي كلام زائد قبل/بعد الرد)
    if(!parsed){
      const obj = extractBalancedObject(clean);
      if(obj){ try { parsed = JSON.parse(obj); } catch(_){} }
    }
    if(!parsed || typeof parsed !== 'object') return null;

    let arr = Array.isArray(parsed) ? parsed
      : (parsed.subs || parsed.segments || parsed.output || parsed.result || parsed.data
        || Object.values(parsed).find(v => Array.isArray(v)));
    if(!Array.isArray(arr)) return null;

    const segs = arr
      .filter(o => o && typeof o === 'object' && typeof o.t === 'string' && o.t.trim())
      .map(o => ({ i: parseInt(o.i, 10), s: Number(o.s), e: Number(o.e), t: o.t.trim() }))
      .filter(o => Number.isFinite(o.i) && Number.isFinite(o.s) && Number.isFinite(o.e) && o.i >= 1);
    return segs.length ? segs : null;
  } catch(_){ return null; }
}

/* ════════════════════════════════════════════════════════════════
   تطبيق النتائج على state.blocks (بدون فقدان أي سطر أبداً)
════════════════════════════════════════════════════════════════ */

/**
 * يوزّع مقاطع الرد على أسطر الدفعة. يعيد عدد الأسطر المضافة (التقسيمات).
 * @param {Array} segs    مقاطع الرد [{i,s,e,t}] — i هو الرقم الأصلي العام
 * @param {Array} core    عناصر الدفعة [{idx,i,s,e,t}]
 * @param {Array} numToId خريطة ثابتة: رقم السطر الأصلي → id البلوك
 */
export function applySegments(segs, core, numToId){
  const coreNums = new Set(core.map(c => c.i));
  const byNum = new Map();
  for(const sg of segs){
    if(!coreNums.has(sg.i)) continue; // سياق أو رقم غير معروف → تجاهل
    const arr = byNum.get(sg.i) || [];
    arr.push(sg);
    byNum.set(sg.i, arr);
  }
  if(!byNum.size) return 0;

  let added = 0;
  for(const [num, arr] of byNum){
    const id = numToId[num - 1];
    const block = state.blocks.find(b => b.id === id);
    if(!block) continue; // حُذف يدوياً أثناء التشغيل → نتجاهل بأمان
    added += layoutParts(block, arr, num - 1, numToId);
  }
  return added;
}

/**
 * يحدد أزمنة أجزاء السطر الواحد:
 *  1) أزمنة الـAI إن كانت صالحة (بعد التنقية والإسناد للنافذة)
 *  2) وإلا توزيع نسبي بطول النص (نفس منطق splitBlock المعتمد)
 * النافذة المسموحة: [بداية السطر .. نهايته، ويمكن مدّها للفراغ التالي]
 */
export function layoutParts(block, segs, blockIdx, numToId){
  const S = parseTimeStringToMs(block.start);
  const E = parseTimeStringToMs(block.end);
  const nextId = (blockIdx + 1 < numToId.length) ? numToId[blockIdx + 1] : null;
  const nextBlock = nextId != null ? state.blocks.find(b => b.id === nextId) : null;
  const nextS = nextBlock ? parseTimeStringToMs(nextBlock.start) : null;
  const gapOk = (nextS != null) && (nextS - E >= 200); // فراغ زمني يستحق الاستخدام
  const endCap = gapOk ? Math.max(E, nextS - ENH_GAP_MARGIN) : E;

  const ordered = segs.slice().sort((a, b) => a.s - b.s);
  const texts = ordered.map(x => x.t);
  if(!texts.length) return 0;

  // 1) تنقية أزمنة الـAI: إسناد للنافذة + منع التداخل + حد أدنى
  let prevEnd = S;
  const cleaned = [];
  for(const sg of ordered){
    let s = Math.max(S, Math.min(Math.round(sg.s), endCap));
    let e = Math.max(S + ENH_MIN_DUR_HARD, Math.min(Math.round(sg.e), endCap));
    if(s < prevEnd) s = prevEnd;
    if(e - s < ENH_MIN_DUR_HARD){
      e = Math.min(endCap, s + ENH_MIN_DUR_HARD);
      if(e - s < 150) continue; // جزء مستحيل في هذه النافذة — تجاهل
    }
    cleaned.push({ s, e, t: sg.t });
    prevEnd = e;
  }

  // 2) قبول أزمنة AI فقط إذا غطّت نافذة السطر الأصلي بشكل معقول
  if(cleaned.length && cleaned[cleaned.length - 1].e >= E - 250){
    cleaned[cleaned.length - 1].e = endCap; // ختم النهاية عند حافة النافذة
    return writeParts(block, cleaned);
  }

  // 3) fallback: توزيع نسبي بطول النص + حد أدنى للقراءة
  const parts = proportionalLayout(S, endCap, texts);
  return writeParts(block, parts.map((p, k) => ({ s: p.s, e: p.e, t: texts[k] })));
}

/**
 * توزيع نسبي: مدة كل جزء بحسب طول نصه، بحد أدنى للقراءة،
 * والأخير يُختم عند حافة النافذة — لا تداخل ولا تجاوز مطلقاً.
 */
export function proportionalLayout(S, endCap, texts){
  const n = texts.length;
  const window = Math.max(1, endCap - S);
  const weights = texts.map(t => Math.max(4, String(t).length));
  const totalW = weights.reduce((a, b) => a + b, 0);
  let durs = weights.map(w => Math.max(ENH_MIN_DUR, Math.round(window * w / totalW)));
  let sum = durs.reduce((a, b) => a + b, 0);
  if(sum > window && sum > 0){
    const minDur = Math.max(150, Math.floor(window / n));
    durs = durs.map(d => Math.max(minDur, Math.floor(d * window / sum)));
  }
  const out = [];
  let cur = S;
  for(let k = 0; k < n; k++){
    const s = cur;
    const e = (k === n - 1) ? endCap : Math.min(endCap, cur + durs[k]);
    out.push({ s, e: Math.max(e, s + 150) });
    cur = out[out.length - 1].e;
  }
  return out;
}

/**
 * يكتب أجزاء السطر: الجزء الأول في البلوك نفسه، والباقي أسطراً جديدة
 * تُدرج بعده مباشرة (ترقيم العرض والتصدير يتجدد تلقائياً).
 */
function writeParts(block, parts){
  block.text = parts[0].t;
  block.start = formatMs(parts[0].s);
  block.end = formatMs(parts[0].e);
  let added = 0;
  for(let k = 1; k < parts.length; k++){
    const pos = state.blocks.indexOf(block);
    state.blocks.splice(pos + k, 0, {
      id: ++state.uid,
      start: formatMs(parts[k].s),
      end: formatMs(parts[k].e),
      text: parts[k].t
    });
    added++;
  }
  return added;
}
