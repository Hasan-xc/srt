/**
 * transcribe.js — التفريغ الصوتي (Groq Whisper) + استخراج الصوت من الفيديو
 *
 * المسؤولية:
 *  - استخراج المسار الصوتي من ملفات الفيديو (مسار أصلي سريع + بديل FFmpeg.wasm)
 *  - فك تشفير الصوت، تحويله إلى WAV أحادي 16kHz، وتقسيمه لأجزاء حسب الحجم
 *  - استدعاءات Groq Whisper لتفريغ كل جزء ودمج النتائج في blocks
 *  - التحكم في التفريغ: بدء/إيقاف مؤقت/إكمال/إلغاء
 *
 * كل الاستدعاءات الآن عبر apiRequest() الموحدة في apiClient.js
 * (نفس الهيدرات، نفس الجسم، نفس معالجة الأخطاء — صفر تغيير سلوكي).
 */

import { state } from './state.js';
import { formatMs } from './time.js';
import { toast } from './ui.js';
import { showEditor } from './core.js';
import { renderCards } from './editor.js';
import { apiRequest } from './apiClient.js';

/* ════════════════════════════════════════════════════════════════
   🎙️ GROQ WHISPER (Optimized 3-Min Chunks + Mobile Auto-Retry)
══════════════════════════════════════════════════════════════ */
// رابط Groq أصبح مركزياً في apiClient.js (المفتاح: GROQ_TRANSCRIBE)
const TARGET_SR      = 16000;
const CHUNK_SECONDS  = 3 * 60; // احتياطي: يُستخدم فقط إذا تعذر حساب الحجم

// ── تقسيم حسب حجم الملف (ميغابايت) بدل الوقت الثابت ──
// الصوت يُحوَّل دائماً إلى WAV خام أحادي 16kHz/16-bit قبل الإرسال،
// وحجمه = المدة (ثانية) × 32000 بايت/ثانية بالضبط (ثابت رياضياً).
const BYTES_PER_SEC_16K_MONO = TARGET_SR * 2; // 32000 بايت/ثانية
const SINGLE_SEND_LIMIT_MB   = 19; // لو الصوت كله أقل/يساوي هذا → إرسال دفعة واحدة
const CHUNK_TARGET_MB        = 18; // حجم كل جزء عند التقسيم

let aiFile            = null;
let aiAudioBuffer     = null;
let aiTotalDurationMs = 0;
let aiTotalChunks     = 0;
let aiCurrentChunk    = 0;
let aiIsRunning       = false;
let aiIsPaused        = false;
let aiChunkSeconds    = CHUNK_SECONDS; // يُعاد حسابه لكل ملف حسب حجمه الفعلي

export function checkAiReady(){
  document.getElementById('aiRunBtn').disabled =
    !(document.getElementById('aiKeyIn').value.trim() && aiFile);
}
function setStatus(msg){ document.getElementById('aiProgStatus').innerHTML = msg; }

// ملاحظة: المعامل اسمه st وليس state حتى لا يحجب استيراد state المشترك
function switchAiUI(st) {
  document.getElementById('ctrlStartBox').style.display  = (st==='start')  ? 'flex' : 'none';
  document.getElementById('ctrlPauseBox').style.display  = (st==='running')? 'flex' : 'none';
  document.getElementById('ctrlResumeBox').style.display = (st==='paused') ? 'flex' : 'none';
}

async function decodeAudioFile(file, onProgress) {
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtxClass) throw new Error('المتصفح لا يدعم Web Audio API');
  if(onProgress) onProgress('⏳ جاري قراءة الملف في الذاكرة...');
  let arrayBuffer = await file.arrayBuffer();
  let ctx;
  try { ctx = new AudioCtxClass({ sampleRate: TARGET_SR }); }
  catch(_) { ctx = new AudioCtxClass(); }
  if(onProgress) onProgress('🔧 جاري فك تشفير الصوت...');
  const decoded = await new Promise((resolve, reject) => {
    try { ctx.decodeAudioData(arrayBuffer, resolve, reject); }
    catch(e) { reject(e); }
  });
  arrayBuffer = null;
  try { ctx.close(); } catch(_){}
  return decoded;
}

function extractMonoChunk(audioBuffer, startSec, endSec) {
  const sr          = audioBuffer.sampleRate;
  const startSample = Math.floor(startSec * sr);
  const endSample   = Math.min(Math.floor(endSec * sr), audioBuffer.length);
  const length      = Math.max(0, endSample - startSample);
  if(length === 0) return { samples: new Float32Array(0), sampleRate: sr };
  const numCh = audioBuffer.numberOfChannels;
  const mono  = new Float32Array(length);
  if(numCh === 1) {
    mono.set(audioBuffer.getChannelData(0).subarray(startSample, endSample));
  } else {
    for(let ch = 0; ch < numCh; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for(let i = 0; i < length; i++) mono[i] += data[startSample + i] / numCh;
    }
  }
  return { samples: mono, sampleRate: sr };
}

function resampleTo16k(samples, inputRate) {
  if(inputRate === TARGET_SR) return samples;
  const ratio  = inputRate / TARGET_SR;
  const outLen = Math.round(samples.length / ratio);
  const out    = new Float32Array(outLen);
  for(let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0  = Math.floor(idx);
    const i1  = Math.min(i0 + 1, samples.length - 1);
    const t   = idx - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

function audioBufferToWav(samples, sampleRate) {
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = samples.length * 2;
  const buffer        = new ArrayBuffer(44 + dataSize);
  const view          = new DataView(buffer);
  const writeStr = (off, s) => { for(let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true); writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for(let i = 0; i < samples.length; i++, off += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/* ════════════════════════════════════════════════════════════════
   VIDEO → AUDIO EXTRACTION LAYER (Layer مستقلة، لا تلمس نظام الترجمة)
   المسار 1: فك تشفير أصلي بالمتصفح (سريع وخفيف)
   المسار 2 (fallback): FFmpeg.wasm عند فشل المسار الأول فقط
══════════════════════════════════════════════════════════════ */
let aiOriginalVideoFile = null;
let aiAudioQualityKbps  = 128;
let aiExtractRunning    = false;
let aiExtractCancelled  = false;
let aiExtractGen        = 0;
let aiExtractedBlob     = null;
let aiExtractObjectURL  = null;
let ffmpegInstance      = null;
let ffmpegLoadPromise   = null;
let lamejsLoadPromise   = null;

const VIDEO_EXTS = ['mp4','mov','mkv','webm','avi','m4v','wmv','flv','3gp','ts','mts'];

function isVideoFile(file){
  if(file.type && file.type.startsWith('video/')) return true;
  if(file.type && file.type.startsWith('audio/')) return false;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

function setExtractStatus(msg){ const el = document.getElementById('aiExtractStatus'); if(el) el.innerHTML = msg; }
function setExtractProgress(pct){ const el = document.getElementById('aiExtractBar'); if(el) el.style.width = Math.max(0,Math.min(100,pct)) + '%'; }

function resetExtractUI(){
  aiExtractCancelled = true; // يوقف أي عملية سابقة قيد التنفيذ
  aiExtractGen++; // يُبطل أي نتيجة متأخرة من عملية سابقة (حتى لو تحول المستخدم لملف صوتي)
  document.getElementById('aiExtractBox').style.display = 'none';
  document.getElementById('aiExtractActions').style.display = 'none';
  document.getElementById('aiExtractCancelBtn').style.display = 'inline-flex';
  document.getElementById('aiQualityBox').style.display = 'none';
  const player = document.getElementById('aiExtractAudioPlayer');
  if(player){ try{ player.pause(); }catch(_){} player.remove(); }
  if(aiExtractObjectURL){ URL.revokeObjectURL(aiExtractObjectURL); aiExtractObjectURL = null; }
  aiExtractedBlob = null;
}

export function onAudioQualityChange(kbps){
  aiAudioQualityKbps = kbps;
  if(aiOriginalVideoFile && !aiExtractRunning) startVideoExtraction(aiOriginalVideoFile);
}

async function startVideoExtraction(file){
  const myGen = ++aiExtractGen;
  aiExtractCancelled = false;
  aiExtractRunning = true;
  aiExtractedBlob = null;
  if(aiExtractObjectURL){ URL.revokeObjectURL(aiExtractObjectURL); aiExtractObjectURL = null; }
  const player = document.getElementById('aiExtractAudioPlayer');
  if(player) player.remove();

  document.getElementById('aiExtractBox').style.display = 'block';
  document.getElementById('aiExtractActions').style.display = 'none';
  document.getElementById('aiExtractCancelBtn').style.display = 'inline-flex';
  document.getElementById('aiExtractSizeInfo').textContent = '';
  setExtractProgress(0);
  setExtractStatus('🎬 جاري استخراج الصوت...');
  document.getElementById('aiRunBtn').disabled = true;

  try {
    let mp3Blob;
    try {
      mp3Blob = await extractAudioNative(file, aiAudioQualityKbps);
    } catch(nativeErr) {
      if(aiExtractCancelled) throw new Error('CANCELLED');
      console.warn('فشل المسار السريع، الانتقال إلى المحرك البديل:', nativeErr);
      setExtractStatus('📦 جاري تجهيز محرك معالجة بديل...');
      mp3Blob = await extractAudioFFmpeg(file, aiAudioQualityKbps);
    }
    if(aiExtractCancelled) throw new Error('CANCELLED');
    if(myGen !== aiExtractGen) return; // تم استبدال هذه العملية بعملية أحدث، لا تلمس الواجهة

    aiExtractedBlob = mp3Blob;
    const outName = file.name.replace(/\.[^.]+$/, '') + '.mp3';
    aiFile = new File([mp3Blob], outName, { type: 'audio/mp3' });
    aiAudioBuffer = null;

    setExtractStatus('✓ تم تجهيز الصوت');
    setExtractProgress(100);
    const sizeMB = (aiFile.size / 1048576).toFixed(2);
    document.getElementById('aiExtractSizeInfo').textContent = `Audio: ${outName}  —  ${sizeMB} MB`;
    document.getElementById('aiExtractActions').style.display = 'flex';
    document.getElementById('aiExtractCancelBtn').style.display = 'none';
    document.getElementById('aiDropTxt').innerHTML =
      `<span style="color:var(--gr)">✅ تم استخراج الصوت:</span><br>${outName}<br><small style="color:var(--t2)">${sizeMB} MB</small>`;
    toast('تم تجهيز الصوت من الفيديو','🎧');
  } catch(err) {
    if(myGen !== aiExtractGen) return; // نتيجة عملية قديمة مُستبدَلة، تجاهلها بصمت
    if(err && err.message === 'CANCELLED'){
      setExtractStatus('⏹️ تم الإلغاء');
      toast('تم إلغاء استخراج الصوت','⏹️');
    } else {
      console.error('Extraction error:', err);
      setExtractStatus('❌ تعذر معالجة هذا الفيديو على جهازك. جرّب فيديو أصغر أو صيغة MP4.');
      toast('تعذر استخراج الصوت من الفيديو','⚠️');
    }
    document.getElementById('aiExtractCancelBtn').style.display = 'none';
    aiFile = null;
  } finally {
    if(myGen === aiExtractGen){ aiExtractRunning = false; checkAiReady(); }
  }
}

export function cancelExtraction(){
  aiExtractCancelled = true;
  if(ffmpegInstance){
    try{ ffmpegInstance.terminate(); }catch(_){}
    ffmpegInstance = null; ffmpegLoadPromise = null;
  }
  setExtractStatus('⏹️ جاري الإلغاء...');
}

/* ── المسار السريع: فك تشفير أصلي بالمتصفح + ضغط MP3 بمكتبة JS خفيفة ── */
async function extractAudioNative(file, kbps){
  const audioBuffer = await decodeAudioFile(file, setExtractStatus);
  if(aiExtractCancelled) throw new Error('CANCELLED');
  setExtractStatus('⚙️ جاري ضغط الصوت...');
  const { samples, sampleRate } = extractMonoChunk(audioBuffer, 0, audioBuffer.duration);
  return await encodeMonoToMp3(samples, sampleRate, kbps, setExtractProgress);
}

function loadLamejs(){
  if(window.lamejs) return Promise.resolve(window.lamejs);
  if(!lamejsLoadPromise){
    lamejsLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
      s.onload = () => resolve(window.lamejs);
      s.onerror = () => reject(new Error('تعذر تحميل مكتبة ضغط الصوت'));
      document.head.appendChild(s);
    });
  }
  return lamejsLoadPromise;
}

async function encodeMonoToMp3(samplesFloat32, sampleRate, kbps, onProgress){
  const lamejs = await loadLamejs();
  if(aiExtractCancelled) throw new Error('CANCELLED');
  const validRates = [8000,11025,12000,16000,22050,24000,32000,44100,48000];
  const sr = validRates.includes(sampleRate) ? sampleRate : 16000;
  const encoder = new lamejs.Mp3Encoder(1, sr, kbps);
  const blockSize = 1152;
  const total = samplesFloat32.length;
  const int16 = new Int16Array(total);
  for(let i = 0; i < total; i++){
    const s = Math.max(-1, Math.min(1, samplesFloat32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const chunks = [];
  let i = 0, lastYield = Date.now();
  while(i < total){
    if(aiExtractCancelled) throw new Error('CANCELLED');
    const chunk = int16.subarray(i, i + blockSize);
    const buf = encoder.encodeBuffer(chunk);
    if(buf.length > 0) chunks.push(new Int8Array(buf));
    i += blockSize;
    if(onProgress) onProgress(Math.min(99, Math.round(i / total * 100)));
    if(Date.now() - lastYield > 16){ await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
  }
  const endBuf = encoder.flush();
  if(endBuf.length > 0) chunks.push(new Int8Array(endBuf));
  if(onProgress) onProgress(100);
  return new Blob(chunks, { type: 'audio/mp3' });
}

/* ── المسار البديل (Fallback): FFmpeg.wasm — يُحمَّل فقط عند فشل المسار السريع ──
   نسخة single-thread، لا تحتاج SharedArrayBuffer أو هيدرز COOP/COEP خاصة بالسيرفر */
async function loadFFmpegEngine(){
  if(ffmpegInstance) return ffmpegInstance;
  if(!ffmpegLoadPromise){
    ffmpegLoadPromise = (async () => {
      const ffmpegMod = await import('https://esm.sh/@ffmpeg/ffmpeg@0.12.10');
      const utilMod   = await import('https://esm.sh/@ffmpeg/util@0.12.1');
      const ffmpeg = new ffmpegMod.FFmpeg();
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await utilMod.toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await utilMod.toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      window.__ffmpegUtil = utilMod;
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }
  return ffmpegLoadPromise;
}

async function extractAudioFFmpeg(file, kbps){
  const ffmpeg = await loadFFmpegEngine();
  if(aiExtractCancelled) throw new Error('CANCELLED');
  const util = window.__ffmpegUtil;
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inName  = 'input.' + ext;
  const outName = 'output.mp3';

  const progressHandler = ({ progress }) => {
    if(progress >= 0 && progress <= 1) setExtractProgress(Math.round(progress * 100));
  };
  ffmpeg.on('progress', progressHandler);

  try {
    setExtractStatus('🎬 جاري استخراج الصوت...');
    await ffmpeg.writeFile(inName, await util.fetchFile(file));
    if(aiExtractCancelled) throw new Error('CANCELLED');
    setExtractStatus('⚙️ جاري ضغط الصوت...');
    await ffmpeg.exec(['-i', inName, '-vn', '-ac', '1', '-ar', '16000', '-b:a', kbps + 'k', outName]);
    if(aiExtractCancelled) throw new Error('CANCELLED');
    const data = await ffmpeg.readFile(outName);
    return new Blob([data.buffer], { type: 'audio/mp3' });
  } finally {
    ffmpeg.off('progress', progressHandler);
    try{ await ffmpeg.deleteFile(inName); }catch(_){}
    try{ await ffmpeg.deleteFile(outName); }catch(_){}
  }
}

export function aiPlayExtracted(){
  if(!aiExtractedBlob) return;
  if(!aiExtractObjectURL) aiExtractObjectURL = URL.createObjectURL(aiExtractedBlob);
  let player = document.getElementById('aiExtractAudioPlayer');
  if(!player){
    player = document.createElement('audio');
    player.id = 'aiExtractAudioPlayer';
    player.controls = true;
    player.style.width = '100%';
    player.style.marginTop = '8px';
    document.getElementById('aiExtractBox').appendChild(player);
  }
  player.src = aiExtractObjectURL;
  player.play();
}

export function aiDownloadExtracted(){
  if(!aiExtractedBlob) return;
  if(!aiExtractObjectURL) aiExtractObjectURL = URL.createObjectURL(aiExtractedBlob);
  const a = document.createElement('a');
  a.href = aiExtractObjectURL;
  a.download = (aiFile && aiFile.name) || 'audio.mp3';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ════════════════════════════════════════════════════════════════
   تدفّق التفريغ الصوتي (بدء/إيقاف/إكمال/إلغاء)
══════════════════════════════════════════════════════════════ */

export async function startAi() {
  state.blocks = []; state.uid = 0; renderCards(); showEditor();
  aiCurrentChunk = 0; aiTotalDurationMs = 0; aiTotalChunks = 0; aiAudioBuffer = null;
  await prepareAndRunAi();
}
export function pauseAi() {
  aiIsPaused = true; aiIsRunning = false;
  switchAiUI('paused');
  setStatus('⏸️ تم الإيقاف المؤقت');
}
export async function resumeAi() { await prepareAndRunAi(); }
export function cancelAi() {
  aiIsPaused = true; aiIsRunning = false; aiCurrentChunk = 0; aiAudioBuffer = null; aiChunkSeconds = CHUNK_SECONDS;
  switchAiUI('start');
  document.getElementById('aiProgress').style.display = 'none';
  toast('تم الإلغاء','⏹️');
}

async function prepareAndRunAi() {
  const apiKey = document.getElementById('aiKeyIn').value.trim();
  if(!apiKey){ toast('أدخل Groq API Key','⚠️'); return; }
  if(!aiFile){ toast('اختر ملفاً أولاً','⚠️'); return; }

  aiIsRunning = true; aiIsPaused = false;
  switchAiUI('running');
  document.getElementById('aiProgress').style.display = 'block';

  try {
    if(!aiAudioBuffer) {
      aiAudioBuffer     = await decodeAudioFile(aiFile, setStatus);
      aiTotalDurationMs = aiAudioBuffer.duration * 1000;

      // حساب الحجم المتوقع للصوت الكامل بعد التحويل لـ WAV 16kHz أحادي
      const estTotalMB = (aiAudioBuffer.duration * BYTES_PER_SEC_16K_MONO) / (1024 * 1024);

      if (estTotalMB <= SINGLE_SEND_LIMIT_MB) {
        // الصوت صغير بما يكفي → إرسال دفعة واحدة بدون تقسيم
        aiChunkSeconds = aiAudioBuffer.duration || 1;
        toast(`📦 الحجم ${estTotalMB.toFixed(1)}MB — إرسال دفعة واحدة بدون تقسيم`, '✅');
      } else {
        // تقسيم بحيث كل جزء ≈ 18MB
        aiChunkSeconds = (CHUNK_TARGET_MB * 1024 * 1024) / BYTES_PER_SEC_16K_MONO;
        const estChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
        toast(`📦 الحجم ${estTotalMB.toFixed(1)}MB — سيُقسَّم إلى ${estChunks} أجزاء (~${CHUNK_TARGET_MB}MB لكل جزء)`, 'ℹ️');
      }

      aiTotalChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
      document.getElementById('fnIn').value = aiFile.name.replace(/\.[^.]+$/,'');
    }
    await executeChunksLoop(apiKey);
  } catch (err) {
    console.error('AI Error:', err);
    setStatus('❌ خطأ: ' + (err.message || err));
    aiIsRunning = false;
    switchAiUI('paused');
    toast('حدث خطأ — يمكنك الإكمال مجدداً','❌');
  }
}

async function executeChunksLoop(apiKey) {
  // التفريغ يعمل دائماً بموديل Whisper Large V3 الأصلي (المتوازن) مع
  // كشف تلقائي للغة — بلا أي خيارات من الواجهة (أُزيلت القوائم).
  const model = 'whisper-large-v3';

  while (aiCurrentChunk < aiTotalChunks) {
    if(aiIsPaused) break;
    const startSec = aiCurrentChunk * aiChunkSeconds;
    const endSec   = Math.min(startSec + aiChunkSeconds, aiAudioBuffer.duration);
    const offsetMs = Math.round(startSec * 1000);
    const oS = formatMs(offsetMs).substring(0,8);
    const oE = formatMs(Math.round(endSec * 1000)).substring(0,8);
    setStatus(`🔄 تفريغ الجزء ${aiCurrentChunk+1}/${aiTotalChunks} &nbsp;•&nbsp; <span style="font-family:var(--mono);color:var(--yw)">${oS} → ${oE}</span>`);

    let { samples, sampleRate } = extractMonoChunk(aiAudioBuffer, startSec, endSec);
    if(sampleRate !== TARGET_SR) { samples = resampleTo16k(samples, sampleRate); sampleRate = TARGET_SR; }
    let wavBlob = audioBufferToWav(samples, sampleRate);
    samples = null;

    let res = null;
    let lastErrMsg = '';

    // محاولتان في حال ضعف الاتصال
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const fd = new FormData();
        fd.append('file', wavBlob, `chunk_${String(aiCurrentChunk+1).padStart(3,'0')}.wav`);
        fd.append('model', model);
        fd.append('response_format', 'verbose_json');
        fd.append('temperature', '0');

        res = await apiRequest('GROQ_TRANSCRIBE', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: fd
        });

        if (res.ok) break;
        else {
          let d = null;
          try { d = await res.json(); } catch(_){}
          lastErrMsg = d?.error?.message || `HTTP ${res.status}`;
          throw new Error(lastErrMsg);
        }
      } catch (err) {
        lastErrMsg = err.message || 'فشل الاتصال بـ Groq';
        if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
      }
    }

    wavBlob = null;
    if(!res || !res.ok) throw new Error(lastErrMsg || 'فشل الاتصال بخادم Groq');

    const data = await res.json();
    const segments = Array.isArray(data.segments) ? data.segments : [];
    if(segments.length > 0) {
      segments.forEach(seg => {
        if(!seg) return;
        const sMs  = Math.round((Number(seg.start) || 0) * 1000) + offsetMs;
        const eMs  = Math.round((Number(seg.end) || seg.start || 0) * 1000) + offsetMs;
        const text = (seg.text || '').trim();
        if(!text) return;
        state.blocks.push({ id: ++state.uid, start: formatMs(sMs), end: formatMs(eMs), text });
      });
    } else if(data.text && data.text.trim()) {
      state.blocks.push({ id: ++state.uid, start: formatMs(offsetMs), end: formatMs(Math.round(endSec * 1000)), text: data.text.trim() });
    }

    renderCards();
    aiCurrentChunk++;
    document.getElementById('aiProgBar').style.width = ((aiCurrentChunk / aiTotalChunks) * 100) + '%';
    await new Promise(r => setTimeout(r, 120));
  }

  if(aiCurrentChunk >= aiTotalChunks && !aiIsPaused) {
    setStatus(`✅ اكتمل التفريغ الصوتي! (${state.blocks.length} مقطع)`);
    aiAudioBuffer = null;
    switchAiUI('start');
    aiIsRunning = false; aiCurrentChunk = 0;
    toast('SRT جاهز! يمكنك الآن مراجعته أو ترجمته','🎉');
  }
}

/* ════════════════════════════════════════════════════════════════
   مستمع رفع ملفات الصوت/الفيديو للتفريغ
══════════════════════════════════════════════════════════════ */

/**
 * يربط مستمع change لحقل رفع الوسائط (aiFileIn).
 * يُستدعى مرة واحدة من main.js عند بدء التشغيل.
 */
export function initTranscribeEvents(){
  document.getElementById('aiFileIn').addEventListener('change', function(){
    const f = this.files[0];
    if(!f) return;
    aiCurrentChunk = 0; aiTotalChunks = 0; aiTotalDurationMs = 0; aiAudioBuffer = null;
    document.getElementById('aiProgress').style.display='none';
    resetExtractUI();

    if(isVideoFile(f)){
      // ── مسار الفيديو: استخراج الصوت تلقائيًا ──
      aiOriginalVideoFile = f;
      aiFile = null;
      checkAiReady();
      document.getElementById('aiQualityBox').style.display = 'flex';
      document.getElementById('aiDropTxt').innerHTML =
        `<span style="color:var(--pu)">🎬 فيديو:</span><br>${f.name}`;
      switchAiUI('start');
      startVideoExtraction(f);
    } else {
      // ── مسار الصوت: يعمل تمامًا كما كان ──
      aiOriginalVideoFile = null;
      document.getElementById('aiQualityBox').style.display = 'none';
      aiFile = f;
      checkAiReady();
      const sizeMB = (aiFile.size / 1048576).toFixed(2);
      document.getElementById('aiDropTxt').innerHTML =
        `<span style="color:var(--gr)">✅ تم الاختيار:</span><br>${aiFile.name}<br><small style="color:var(--t2)">${sizeMB} MB</small>`;
      toast('تم اختيار الملف','🎵');
      switchAiUI('start');
    }
  });
}
