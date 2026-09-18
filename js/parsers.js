/**
 * parsers.js — محرك تحليل شامل لكل صيغ الترجمة (Universal Subtitle Parser)
 *
 * المسؤولية:
 *  - التعرف تلقائياً على صيغة الملف/النص الملصق (SRT / VTT / ASS / SSA /
 *    SBV / SUB / LRC / نص عادي) وتحويلها جميعاً لمصفوفة موحدة واحدة:
 *    [{ start: "00:00:01,000", end: "00:00:04,000", text: "..." }]
 *  - هذه المصفوفة الموحدة هي ما يستهلكه core.js لبناء state.blocks —
 *    باقي التطبيق (المحرر/الترجمة/التصدير) لا يرى أي فرق بين الصيغ.
 *
 * دوال نقية بلا DOM — قابلة للاختبار مباشرة.
 */

import { formatMs } from './time.js';

/* ════════════════════════════════════════════════════════════════
   تحويل التوقيت: أي صيغة نصية معروفة (SRT/VTT/ASS/SBV/LRC) → مللي ثانية
════════════════════════════════════════════════════════════════ */
export function timeToMs(str){
  if(!str) return 0;
  const s = String(str).trim().replace(',', '.');
  const parts = s.split(':');
  let h = 0, m = 0, sec = 0;
  if(parts.length === 3){ h = parseInt(parts[0], 10) || 0; m = parseInt(parts[1], 10) || 0; sec = parseFloat(parts[2]) || 0; }
  else if(parts.length === 2){ m = parseInt(parts[0], 10) || 0; sec = parseFloat(parts[1]) || 0; }
  else { sec = parseFloat(parts[0]) || 0; }
  return Math.max(0, Math.round((h * 3600 + m * 60 + sec) * 1000));
}

/* ════════════════════════════════════════════════════════════════
   اكتشاف الصيغة: من امتداد الملف أولاً، ثم من محتوى النص (Sniffing)
════════════════════════════════════════════════════════════════ */
export function detectFormat(filename, raw){
  const name = (filename || '').toLowerCase();
  if(name.endsWith('.vtt')) return 'vtt';
  if(name.endsWith('.ass')) return 'ass';
  if(name.endsWith('.ssa')) return 'ssa';
  if(name.endsWith('.sbv')) return 'sbv';
  if(name.endsWith('.sub')) return 'sub';
  if(name.endsWith('.lrc')) return 'lrc';
  if(name.endsWith('.srt')) return 'srt';
  if(name.endsWith('.txt')) return 'plain';

  const head = (raw || '').slice(0, 800);
  if(/^\uFEFF?WEBVTT/i.test(head)) return 'vtt';
  if(/^\[Script Info\]/im.test(head) || /^Dialogue:\s*/m.test(raw)) return 'ass';
  if(/^\{\d+\}\{\d+\}/m.test(head)) return 'sub';
  if(/^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/m.test(head)) return 'lrc';
  if(/^\d{1,2}:\d{2}:\d{2}\.\d{3},\d{1,2}:\d{2}:\d{2}\.\d{3}/m.test(head)) return 'sbv';
  if(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(head)) return 'srt';
  return 'plain';
}

/* ════════════════════════════════════════════════════════════════
   SRT / VTT: كليهما يعتمدان على سطر توقيت "--> " (نفس المنطق الأصلي
   المستخدم في processInput حرفياً، مع خيار تجاوز Cue Settings لـVTT)
════════════════════════════════════════════════════════════════ */
function parseSrtLike(raw, opts = {}){
  const blocks = [];
  // يدعم الصيغ الكاملة (HH:MM:SS,mmm / HH:MM:SS.mmm) والمختصرة (MM:SS.mmm / MM:SS,mmm)
  const regex = /(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})/g;
  let match;
  const matches = [];
  while((match = regex.exec(raw)) !== null){
    let length = match[0].length;
    if(opts.skipLineTrailer){
      // VTT: قد يتبع التوقيت على نفس السطر إعدادات Cue مثل "align:middle line:84%"
      const lineEnd = raw.indexOf('\n', match.index + length);
      length = (lineEnd === -1 ? raw.length : lineEnd) - match.index;
    }
    matches.push({ startMs: timeToMs(match[1]), endMs: timeToMs(match[2]), index: match.index, length });
  }
  for(let i = 0; i < matches.length; i++){
    const textStart = matches[i].index + matches[i].length;
    const textEnd = (i + 1 < matches.length) ? matches[i + 1].index : raw.length;
    const chunk = raw.substring(textStart, textEnd);
    const lines = chunk.trim().split('\n');
    const cleanLines = [];
    for(let j = 0; j < lines.length; j++){
      const l = lines[j].trim();
      // آخر سطر رقمي بحت = مُعرّف الكيو التالي المتسرب داخل نطاق القطعة الحالية
      if(j === lines.length - 1 && /^\d+$/.test(l)) continue;
      if(l) cleanLines.push(l);
    }
    blocks.push({ startMs: matches[i].startMs, endMs: matches[i].endMs, text: cleanLines.join('\n') });
  }
  return blocks;
}

function parseVtt(raw){
  const blocks = parseSrtLike(raw, { skipLineTrailer: true });
  // إزالة وسوم VTT الشائعة داخل النص: <b> <i> <c.colorname> <00:00:01.000> ...
  return blocks.map(b => ({ ...b, text: b.text.replace(/<\/?[^>]+>/g, '') }));
}

/* ════════════════════════════════════════════════════════════════
   ASS / SSA: أسطر Dialogue: مع استخراج التوقيت وتنظيف وسوم التنسيق
════════════════════════════════════════════════════════════════ */
function parseAssSsa(raw){
  const blocks = [];
  const lines = raw.split(/\r?\n/);
  let fieldNames = null;

  for(const rawLine of lines){
    const line = rawLine.trim();
    if(/^Format:\s*/i.test(line) && /start/i.test(line) && /end/i.test(line)){
      fieldNames = line.replace(/^Format:\s*/i, '').split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    if(!/^Dialogue:\s*/i.test(line)) continue;

    const fields = line.replace(/^Dialogue:\s*/i, '').split(',');
    let startIdx = 1, endIdx = 2, textIdx = 9;
    if(fieldNames){
      const si = fieldNames.indexOf('start'), ei = fieldNames.indexOf('end'), ti = fieldNames.indexOf('text');
      if(si >= 0) startIdx = si;
      if(ei >= 0) endIdx = ei;
      if(ti >= 0) textIdx = ti;
    }
    const startStr = fields[startIdx], endStr = fields[endIdx];
    if(!startStr || !endStr) continue;

    // النص هو كل الحقول من textIdx للنهاية (لأن النص قد يحتوي فواصل داخلية)
    let text = fields.slice(Math.min(textIdx, fields.length - 1)).join(',');
    text = text
      .replace(/\{[^}]*\}/g, '')   // وسوم الأنماط: {\an8} {\b1} {\c&Hxxxxxx&} ...
      .replace(/\\N/gi, '\n')      // فاصل الأسطر الصريح في ASS/SSA
      .replace(/\\n/gi, '\n')
      .replace(/\\h/gi, ' ')       // مسافة غير قابلة للكسر
      .trim();
    if(!text) continue;

    blocks.push({ startMs: timeToMs(startStr.trim()), endMs: timeToMs(endStr.trim()), text });
  }
  return blocks;
}

/* ════════════════════════════════════════════════════════════════
   YouTube SBV: "0:00:00.000,0:00:00.000" في سطر، ثم سطر/أسطر النص
════════════════════════════════════════════════════════════════ */
function parseSbv(raw){
  const blocks = [];
  const chunks = raw.split(/\r?\n\r?\n+/);
  const timeRe = /^(\d{1,2}:\d{2}:\d{2}\.\d{3}),(\d{1,2}:\d{2}:\d{2}\.\d{3})/;
  for(const chunk of chunks){
    const lines = chunk.split(/\r?\n/).filter(l => l.trim() !== '');
    if(!lines.length) continue;
    const m = lines[0].trim().match(timeRe);
    if(!m) continue;
    const text = lines.slice(1).join('\n').trim();
    if(!text) continue;
    blocks.push({ startMs: timeToMs(m[1]), endMs: timeToMs(m[2]), text });
  }
  return blocks;
}

/* ════════════════════════════════════════════════════════════════
   SUB: يدعم الصيغتين الشائعتين — MicroDVD {start}{end}text (بالفريمات)
   وSubViewer "00:00:00.00,00:00:02.50" + سطر نص (يدعم [br] كفاصل)
════════════════════════════════════════════════════════════════ */
function parseSub(raw){
  const lines = raw.split(/\r?\n/);
  const microRe = /^\{(\d+)\}\{(\d+)\}(.*)$/;
  const firstNonEmpty = lines.find(l => l.trim() !== '') || '';

  if(microRe.test(firstNonEmpty)){
    const FPS = 25; // تقدير قياسي شائع عند غياب معلومة الفريم ريت في الملف
    const blocks = [];
    for(const line of lines){
      const m = line.match(microRe);
      if(!m) continue;
      const text = m[3].replace(/\|/g, '\n').replace(/\{[^}]*\}/g, '').trim();
      if(!text) continue;
      blocks.push({
        startMs: Math.round(parseInt(m[1], 10) / FPS * 1000),
        endMs: Math.round(parseInt(m[2], 10) / FPS * 1000),
        text
      });
    }
    if(blocks.length) return blocks;
  }

  // SubViewer
  const svRe = /^(\d{2}:\d{2}:\d{2}\.\d{2,3}),(\d{2}:\d{2}:\d{2}\.\d{2,3})$/;
  const blocks = [];
  for(let i = 0; i < lines.length; i++){
    const m = lines[i].trim().match(svRe);
    if(!m) continue;
    const text = (lines[i + 1] || '').replace(/\[br\]/gi, '\n').trim();
    if(!text) continue;
    blocks.push({ startMs: timeToMs(m[1]), endMs: timeToMs(m[2]), text });
  }
  return blocks;
}

/* ════════════════════════════════════════════════════════════════
   LRC: كلمات مؤقتة [mm:ss.xx]نص → كتل متتالية (نهاية كل كتلة = بداية التالية)
════════════════════════════════════════════════════════════════ */
function parseLrc(raw){
  const lines = raw.split(/\r?\n/);
  const tagRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const items = [];
  for(const line of lines){
    const tags = [...line.matchAll(tagRe)];
    if(!tags.length) continue;
    const text = line.replace(tagRe, '').trim();
    if(!text) continue;
    for(const t of tags){
      const m = parseInt(t[1], 10) || 0, s = parseInt(t[2], 10) || 0;
      const frac = t[3] ? parseInt(t[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      items.push({ ms: (m * 60 + s) * 1000 + frac, text });
    }
  }
  items.sort((a, b) => a.ms - b.ms);
  const blocks = [];
  for(let i = 0; i < items.length; i++){
    const startMs = items[i].ms;
    const nextMs = (i + 1 < items.length) ? items[i + 1].ms : startMs + 4000;
    blocks.push({ startMs, endMs: Math.max(nextMs, startMs + 300), text: items[i].text });
  }
  return blocks;
}

/* ════════════════════════════════════════════════════════════════
   نص عادي بلا أي توقيت: سطر كل 3 ثوانٍ (نفس سلوك processInput الأصلي)
════════════════════════════════════════════════════════════════ */
function parsePlainText(raw){
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  return lines.map((l, i) => ({ startMs: i * 3000, endMs: (i + 1) * 3000, text: l.trim() }));
}

/* ════════════════════════════════════════════════════════════════
   الدالة الموحدة: تكتشف الصيغة وتُرجع كتلاً موحدة {start,end,text}
   بصيغة SRT القياسية (HH:MM:SS,mmm) — جاهزة مباشرة لـ state.blocks
════════════════════════════════════════════════════════════════ */
export function parseSubtitlesAnyFormat(raw, filename = ''){
  if(!raw || !raw.trim()) return [];
  const fmt = detectFormat(filename, raw);

  let items;
  switch(fmt){
    case 'vtt': items = parseVtt(raw); break;
    case 'ass':
    case 'ssa': items = parseAssSsa(raw); break;
    case 'sbv': items = parseSbv(raw); break;
    case 'sub': items = parseSub(raw); break;
    case 'lrc': items = parseLrc(raw); break;
    case 'srt': items = parseSrtLike(raw); break;
    case 'plain': {
      // .txt أو نص بلا رأس معروف: قد يحتوي فعلياً توقيتات SRT/VTT ملصقة
      items = parseSrtLike(raw);
      if(!items.length) items = parsePlainText(raw);
      break;
    }
    default: items = null;
  }
  if(!items || !items.length){
    // fallback عام: جرّب نمط SRT/VTT (يغطي أيضاً VTT بلا رأس أو صيغ غير متوقعة)
    items = parseSrtLike(raw);
    if(!items.length) items = parsePlainText(raw);
  }

  return items
    .filter(b => b.text && b.text.trim() !== '')
    .map(b => ({
      start: formatMs(b.startMs),
      end: formatMs(Math.max(b.endMs, b.startMs + 100)),
      text: b.text
    }));
}
