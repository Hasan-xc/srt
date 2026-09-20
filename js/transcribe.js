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
   🎙️ GROQ WHISPER (20-Min Time Chunks + Direct Fast Path + Auto-Retry)
══════════════════════════════════════════════════════════════ */
// رابط Groq أصبح مركزياً في apiClient.js (المفتاح: GROQ_TRANSCRIBE)
const TARGET_SR      = 16000;

// ── الموديل ثابت واحد لأجل التفريغ كله (whisper-large-v3 المتوازن، كشف لغة تلقائي) ──
const WHISPER_MODEL  = 'whisper-large-v3';

// ── التقطيع زمني ثابت: 20 دقيقة لكل جزء (كما تعلن الواجهة) ──
// كل جزء يُضغط MP3 48kbps → ≈7.2MB لكل 20 دقيقة (أقل بكثير من حد الخادم 25MB)
const CHUNK_SECONDS  = 20 * 60;
const CHUNK_SECONDS_WAV_FALLBACK = 18 * 1024 * 1024 / (TARGET_SR * 2); // ≈585ث إذا فشل lamejs (WAV خام ≤18MB)

// حجم WAV الخام للمدة (ثابت رياضي: المدة × 32000 بايت/ثانية)
const BYTES_PER_SEC_16K_MONO = TARGET_SR * 2;

let aiFile            = null;
let aiAudioBuffer     = null;
let aiTotalDurationMs = 0;
let aiTotalChunks     = 0;
let aiCurrentChunk    = 0;
let aiIsRunning       = false;
let aiIsPaused        = false;
let aiChunkSeconds    = CHUNK_SECONDS; // يُعاد حسابه لكل ملف حسب حجمه الفعلي
let aiDirectSend      = false; // ⚡ إرسال الملف الأصلي كما هو (صوت ≤24MB و≤20د) بلا ضغط
let aiGroqWaitUntil   = 0;     // ⏳ تبريد بعد 429 — يكافئ انخفاض التزامن إلى 1 خلال النافذة
let aiInflight        = 0;     // عدد الطلبات الجارية فعلياً (لأجل الاستئناف الآمن)
let aiActiveCtrls     = new Set(); // متحكمات الطلبات الحية — الإلغاء يجهضها
let aiRunGen          = 0;     // جيل الجولة — الإلغاء يزيده فتموت عمال الجولات القديمة (لا يعيدون الإرسال بعد جولة جديدة)

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
let aiAudioQualityKbps  = 48;  // مطابق للراديو الافتراضي (48 checked) في الواجهة
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
  aiRunGen++; aiIsPaused = false; aiGroqWaitUntil = 0; // جيل جديد — أي عمال قدامى يموتون
  await prepareAndRunAi();
}
export function pauseAi() {
  aiIsPaused = true; aiIsRunning = false;
  switchAiUI('paused');
  setStatus('⏸️ تم الإيقاف المؤقت');
}
export async function resumeAi() {
  // انتظار استقرار الطلبات الطائرة من الجولة المتوقفة (تُلحق نتائجها وتُحدَّث المؤشرات أولاً)
  // — بدون هذا كانت الاستئناف يعيد إرسال أجزاء جارية/يكرر النتائج
  while (aiInflight > 0) await new Promise(r => setTimeout(r, 40));
  aiIsPaused = false;
  await prepareAndRunAi();
}
export function cancelAi() {
  aiIsPaused = true; aiIsRunning = false; aiCurrentChunk = 0; aiAudioBuffer = null; aiChunkSeconds = CHUNK_SECONDS;
  aiRunGen++; // جيل جديد — عمال الجولة الملغاة يموتون فور استيقاظهم (لا يعيدون الإرسال)
  // ⏹️ إجهاض كل الطلبات الحية فعلياً (الخادم يرى الاتصالات مقطوعة)
  for (const c of aiActiveCtrls) { try { c.abort(); } catch(_){} }
  aiActiveCtrls.clear();
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
    // نحتاج المدة دائماً → فك تشفير مرة واحدة (يقرر المسار المباشر والتقطيع)
    if(!aiAudioBuffer) {
      aiAudioBuffer     = await decodeAudioFile(aiFile, setStatus);
      aiTotalDurationMs = aiAudioBuffer.duration * 1000;

      // التقطيع زمني ثابت 20 دقيقة؛ وإذا تعذر lamejs → أجزاء WAV أصغر (≈585ث ≤18MB)
      let lameOk = true;
      try { await loadLamejs(); } catch(_) { lameOk = false; }
      aiChunkSeconds = lameOk ? CHUNK_SECONDS : Math.floor(CHUNK_SECONDS_WAV_FALLBACK);

      if (aiAudioBuffer.duration <= aiChunkSeconds) {
        aiChunkSeconds = aiAudioBuffer.duration || 1;
        // ⚡ المسار السريع: أصل صوتي ≤24MB يُرسل كما هو — بلا ضغط إطلاقاً
        aiDirectSend = !isVideoFile(aiFile) && aiFile.size <= 24 * 1024 * 1024;
        toast(`📦 المدة ${Math.round(aiAudioBuffer.duration/60)} دقيقة — إرسال دفعة واحدة${aiDirectSend ? ' مباشرة (بلا ضغط)' : ''}`, '✅');
      } else {
        aiDirectSend = false;
        const estChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
        toast(`📦 المدة ${Math.round(aiAudioBuffer.duration/60)} دقيقة — سيُقسَّم إلى ${estChunks} أجزاء (~${Math.round(aiChunkSeconds/60)} دقيقة لكل جزء)`, 'ℹ️');
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
  const myGen = aiRunGen; // جيل هذه الجولة — إن تغيّر (إلغاء/جولة جديدة) نموت فورًا

  const POOL = 3;                 // إرسال متوازٍ: 3 أجزاء في آنٍ واحد
  const MAX_ATTEMPTS = 3;         // إعادة محاولة عند ضعف الاتصال/الوقت الكامل
  const kbps = (typeof aiAudioQualityKbps === 'number' && aiAudioQualityKbps > 0) ? aiAudioQualityKbps : 48;

  // تجهيز قائمة الأجزاء — أو المسار المباشر (جزء واحد = الملف الأصلي)
  let jobs;
  if(aiDirectSend){
    aiTotalChunks = 1;
    jobs = [{ index: 0, start: 0, end: aiAudioBuffer ? aiAudioBuffer.duration : 0, offsetMs: 0, direct: true }];
  } else {
    aiTotalChunks = Math.max(1, Math.ceil(aiAudioBuffer.duration / aiChunkSeconds));
    jobs = [];
    for(let i = 0; i < aiTotalChunks; i++){
      const startSec0 = i * aiChunkSeconds;
      const endSec0   = Math.min(startSec0 + aiChunkSeconds, aiAudioBuffer.duration);
      jobs.push({ index: i, start: startSec0, end: endSec0, offsetMs: Math.round(startSec0 * 1000) });
    }
  }

  // سجل تقدمي توضيحي (console.table)
  const chunkLog = [];

  // ترميز جزء إلى MP3 (الافتراضي مع lamejs) مع الاحتياطي WAV
  async function encodeChunk(job){
    if(job.direct) return { blob: aiFile, usedMp3: true }; // ⚡ الملف الأصلي كما هو — صفر معالجة
    let { samples, sampleRate } = extractMonoChunk(aiAudioBuffer, job.start, job.end);
    if(sampleRate !== TARGET_SR) { samples = resampleTo16k(samples, sampleRate); sampleRate = TARGET_SR; }
    let blob = null, usedMp3 = true;
    try { blob = await encodeMonoToMp3(samples, sampleRate, kbps, null); }
    catch(_) {
      usedMp3 = false;
      blob = audioBufferToWav(samples, sampleRate);
    }
    samples = null;
    return { blob, usedMp3 };
  }

  // إرسال جزء مع إعادة محاولة (Backoff) ومعالجة رموز الحالة المعروفة
  async function sendChunk(job){
    const { blob, usedMp3 } = await encodeChunk(job);
    let res = null, lastErr = '', attemptTimeMs = 0;
    // ⏱️ مهلة ديناميكية: 45 ثانية لكل ميغابايت (حد أدنى 3 دقائق)
    // رفع ~12MB من شبكة الجوال + معالجة Whisper قد يتجاوز 180s بسهولة
    const sizeMB = Math.max(1, Math.ceil(blob.size / 1048576));
    const baseTimeoutMs = Math.max(180000, sizeMB * 45000);
    let attemptTimeoutMs = baseTimeoutMs;
    ADD: for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
      if(aiIsPaused || myGen !== aiRunGen) break;
      const startedAt = Date.now();
      const ctrl = new AbortController();
      aiActiveCtrls.add(ctrl); // يُجهض تلقائياً عند cancelAi
      attemptTimeoutMs = baseTimeoutMs * (1 + (attempt - 1) * 0.5); // كل محاولة أطول 50%
      const tid  = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        // ⏳ نافذة تبريد بعد 429 — كل الأجزاء تنتظر (= تزامن فعلي 1 خلال النافذة)
        const cooldownMs = aiGroqWaitUntil - Date.now();
        if (cooldownMs > 0) await new Promise(r => setTimeout(r, cooldownMs));
        if (myGen !== aiRunGen) break;

        const fd = new FormData();
        // ⚠️ الامتداد بنقطة إلزامية — Groq يستنتج النوع من الامتداد (chunk_001_mp3 كان يُرفض!)
        const fname = job.direct ? (aiFile.name || 'audio.mp3')
                                 : `chunk_${String(job.index+1).padStart(3,'0')}.${usedMp3 ? 'mp3' : 'wav'}`;
        fd.append('file', blob, fname);
        fd.append('model', WHISPER_MODEL);
        fd.append('response_format', 'verbose_json');
        fd.append('temperature', '0');
        // ملاحظة: لا نرسل language — حذف الحقل = كشف تلقائي للغة (قيمة 'auto' غير صالحة وتسبب 400)

        res = await apiRequest('GROQ_TRANSCRIBE', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: fd,
          signal: ctrl.signal
        });
        attemptTimeMs = Date.now() - startedAt;
        if(res.ok) break ADD;

        const status = res.status;
        if(status === 429 || status === 486) {
          // ضغط الخادم — ننتظر قبل إعادة المحاولة ونفتح نافذة تبريد لكل الأجزاء
          const retryAfter = Number(res.headers?.get?.('retry-after') || 0);
          const waitMs = (retryAfter || 2) * 1000 * attempt;
          aiGroqWaitUntil = Math.max(aiGroqWaitUntil, Date.now() + waitMs);
          lastErr = `ضغط الخادم (HTTP ${status})`;
          await new Promise(r => setTimeout(r, waitMs));
          if (myGen !== aiRunGen) break;
        } else if(status === 401 || status === 403) {
          // رفض مرتبط بالموديل يفحص أولاً (قد يأتي بصيغة 403 أيضاً)
          let dm = null; try { dm = await res.json(); } catch(_){}
          const mMsg = dm?.error?.message || '';
          if (/model/i.test(mMsg)) {
            lastErr = 'الموديل غير مفعّل في حساب Groq — أضفه من Settings > Limits > Allowed Models';
            break;
          }
          lastErr = 'مفتاح API غير صالح أو منتهي';
          break; // لا فائدة من الإعادة
        } else {
          let d = null; try { d = await res.json(); } catch(_){}
          lastErr = d?.error?.message || `HTTP ${status}`;
          // رفض مرتبط بالموديل (400/404 ونصه يذكر model) → رسالة واضحة بلا إعادة
          if ((status === 400 || status === 404) && /model/i.test(lastErr)) {
            lastErr = 'الموديل غير مفعّل في حساب Groq — أضفه من Settings > Limits > Allowed Models';
            break;
          }
          await new Promise(r => setTimeout(r, 800 * attempt));
          if (myGen !== aiRunGen) break;
        }
      } catch(err) {
        lastErr = err?.name === 'AbortError'
          ? `انتهت المهلة (${Math.round(attemptTimeoutMs/1000)}s) — ${sizeMB}MB على سرعة شبكتك، المحاولة التالية ستكون أطول`
          : (err.message || 'خطأ في الاتصال');
        await new Promise(r => setTimeout(r, 1000 * attempt));
        if (myGen !== aiRunGen) throw new Error('أُلغيت');
        attemptTimeMs = Date.now() - startedAt
      } finally {
        clearTimeout(tid);
        aiActiveCtrls.delete(ctrl);
      }
    }

    chunkLog.push({ 'الجزء': job.index+1, 'النطاق': formatMs(job.offsetMs).substring(0,8)+'→'+formatMs(Math.round(job.end*1000)).substring(0,8), 'الحالة': res?.ok ? '✅' : '❌', 'الحجم': (blob.size/1024).toFixed(0)+'KB', 'المحاولات': Math.min(MAX_ATTEMPTS, 3), 'الزمن': (attemptTimeMs/1000).toFixed(1)+'s', 'المدة': job.direct ? 'مباشر' : 'جزء' });
    try { console.table([chunkLog[chunkLog.length - 1]]); } catch(_){}

    if(!res || !res.ok) throw new Error(lastErr || 'فشل إرسال الجزء');

    const data = await res.json();
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const out = [];
    if(segments.length > 0){
      segments.forEach(seg => {
        if(!seg) return;
        const sMs = Math.round((Number(seg.start) || 0) * 1000) + job.offsetMs;
        const eMs = Math.round((Number(seg.end) || seg.start || 0) * 1000) + job.offsetMs;
        const text = (seg.text || '').trim();
        if(!text) return;
        out.push({ sMs, eMs, text });
      });
    } else if(data.text && data.text.trim()){
      out.push({ sMs: job.offsetMs, eMs: Math.round(job.end*1000), text: data.text.trim() });
    }
    return out;
  }

  // تنفيذ متوازٍ مع ترتيب الإلحاق النهائي (يُحفظ بالترتيب مهما اختلفت سرعة الردود)
  // ملاحظة الاستئناف: نكمل من aiCurrentChunk المحفوظ — الأجزاء المكتملة لا تُعاد
  const ordered = new Array(aiTotalChunks);
  let cursor = Math.min(aiCurrentChunk, aiTotalChunks);   // أول جزء غير ملحق بعد
  let nextJob = cursor;
  let lastChunkErr = '';   // آخر رسالة خطأ لجزء فاشل (كانت مسببة ReferenceError)

  async function pump(){
    while(nextJob < jobs.length){
      if(myGen !== aiRunGen) return;
      if(aiIsPaused) return;
      const job = jobs[nextJob++];
      if(job.index < cursor) continue; // مكتمل سابقاً (استئناف) — لا يعاد
      aiInflight++;
      try {
        const segs = await sendChunk(job);
        ordered[job.index] = segs || [];
      } catch(err) {
        ordered[job.index] = null; // علامة فشل
        lastChunkErr = err.message || 'فشل';
      } finally {
        aiInflight--;
      }
      // إلحاق متسلسل (ordered): نلحق كل الأجزاء المكتملة المتتالية
      while(cursor < aiTotalChunks){
        const v = ordered[cursor];
        if(v === undefined) break; // لا يزال قيد التنفيذ
        if(v === null){
          throw new Error(`فشل تفريغ الجزء ${cursor+1}: ${lastChunkErr}`);
        }
        v.forEach(o => {
          state.blocks.push({ id: ++state.uid, start: formatMs(o.sMs), end: formatMs(o.eMs), text: o.text });
        });
        cursor++;
      }
      aiCurrentChunk = cursor;
      const pct = cursor / aiTotalChunks * 100;
      document.getElementById('aiProgBar').style.width = pct + '%';
      // نطاق زمن آخر جزء أُلحق — داخل span باتجاه ltr كي تظهر الأرقام صحيحة في RTL
      const doneJob = jobs[cursor - 1];
      const oS = doneJob ? formatMs(doneJob.offsetMs).substring(0,8) : '';
      const oE = doneJob ? formatMs(Math.round(doneJob.end * 1000)).substring(0,8) : '';
      setStatus(`🔄 تفريغ ${cursor}/${aiTotalChunks} — ${Math.round(pct)}% &nbsp;•&nbsp; <span dir="ltr" style="font-family:var(--mono);color:var(--yw)">${oS} → ${oE}</span>`);
      renderCards();
    }
  }

  const workers = [];
  for(let w = 0; w < POOL; w++) workers.push(pump());
  await Promise.all(workers);

  // إيقاف حقيقي (ما زالت أجزاء ناقصة) → يُكمل عند الاستئناف
  if(aiIsPaused && aiCurrentChunk < aiTotalChunks) return;

  renderCards();
  if(aiCurrentChunk >= aiTotalChunks){
    aiIsPaused = false; // اكتمل حتى لو صدر أمر إيقاف عند آخر جزء
    setStatus(`✅ اكتمل التفريغ الصوتي! (${state.blocks.length} مقطع)`);
    aiAudioBuffer = null;
    switchAiUI('start');
    aiIsRunning = false;
    // ⚠️ لا نصفر aiCurrentChunk هنا — الاستئناف بعد اكتمال أثناء الإيقاف يعتمد عليه
    // (startAi يصفّره عند بدء تفريغ جديد على أي حال)
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
      aiExtractCancelled = false; // كان true من resetExtractUI — كان يجعل كل ترميز MP3 يرمي CANCELLED ويسقط إلى WAV!
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
