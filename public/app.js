/* Hearings Recording Splitter – test build
 * - Portal-agnostic
 * - Default max size 20MB (configurable)
 * - Append "(part X of Y)" to filenames
 * - Default encoding: same as source when possible (stream-copy AAC/M4A)
 * - Dropdown for AAC bitrates
 * - Immediate deletion of temporary files once files are handed to the browser
 */

/* app.js */
const { createFFmpeg, fetchFile } = FFmpeg;

const els = {
  file: document.getElementById('file'),
  fileInfo: document.getElementById('fileInfo'),
  maxMB: document.getElementById('maxMB'),
  encoding: document.getElementById('encoding'),
  planBtn: document.getElementById('planBtn'),
  runBtn: document.getElementById('runBtn'),
  clearBtn: document.getElementById('clearBtn'),
  status: document.getElementById('status'),
  segmentsTblBody: document.querySelector('#segments tbody'),
  alerts: document.getElementById('alerts'),
};

let ffmpeg;
let inputFile = null;
let inputUrl = null;
let durationSec = 0;
let planned = [];

function setStatus(msg) { els.status.textContent = msg; }
function alertWarn(msg) {
  const div = document.createElement('div'); div.className = 'warn'; div.textContent = msg;
  els.alerts.appendChild(div);
}
function clearAlerts(){ els.alerts.innerHTML=''; }
function clearTable(){ els.segmentsTblBody.innerHTML=''; }
function enable(el, yes) { el.disabled = !yes; }
function formatHMS(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60);
  return [h,m,sc].map(v => String(v).padStart(2,'0')).join(':');
}
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/(1024*1024)).toFixed(1)} MB`;
}
function baseName(fileName) {
  const idx = fileName.lastIndexOf('.'); return idx < 0 ? fileName : fileName.slice(0, idx);
}
function withPartSuffix(fileName, i, total) {
  const base = baseName(fileName); return `${base} (part ${String(i)} of ${String(total)})` + '.m4a';
}

async function probeDuration(file) {
  // Don’t rely on play(); just preload metadata
  inputUrl = URL.createObjectURL(file);
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = inputUrl;
  setStatus('Loading audio metadata...');
  await new Promise((resolve) => {
    audio.onloadedmetadata = resolve;
    audio.onerror = resolve;  // resolve even on error to avoid hang
  });
  durationSec = Number.isFinite(audio.duration) ? audio.duration : 0;
  els.fileInfo.textContent =
    `File: ${file.name} | Size: ${humanBytes(file.size)} | Duration: ${durationSec ? formatHMS(durationSec) : 'unknown'}`;
  setStatus(durationSec ? 'Metadata loaded.' : 'Metadata failed to load (continuing).');
}

function planSegments(fileSizeBytes, durationSec, maxMB) {
  const S = maxMB * 1024 * 1024;
  const avgBps = durationSec > 0 ? (fileSizeBytes / durationSec) : (128000/8);
  const targetSec = Math.max(1, Math.floor(S / avgBps));
  const num = Math.max(1, Math.ceil(durationSec / targetSec));
  const segs = [];
  for (let i = 0; i < num; i++) {
    const start = i * targetSec;
    const end = Math.min(durationSec || targetSec, (i+1) * targetSec);
    const length = Math.max(0.1, end - start); // avoid zero-length
    const estBytes = Math.floor(length * avgBps);
    segs.push({ index: i+1, start, length, estBytes });
  }
  return segs;
}

async function initFFmpeg() {
  if (ffmpeg) return;
  setStatus('Loading FFmpeg core (~15–20 MB)...');
  ffmpeg = createFFmpeg({
    log: false,
    corePath: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js'
  });
  try { await ffmpeg.load(); }
  catch (e) {
    alertWarn('FFmpeg core failed to load. Are you serving via HTTP/HTTPS and online?');
    setStatus('FFmpeg load error: ' + (e?.message || e));
    throw e;
  }
}

async function detectIsAacM4a(inputName) {
  let isAac = false;
  ffmpeg.setLogger(({ message }) => {
    if (/Audio:\s*aac/i.test(message)) isAac = true;
  });
  try { await ffmpeg.run('-hide_banner', '-i', inputName, '-f', 'null', '-'); } catch {}
  ffmpeg.setLogger(() => {});
  return isAac;
}

function argsForSegment(encMode, start, length, inputName, outName, canCopyAac) {
  if (encMode === 'auto' && canCopyAac) return ['-ss', String(start), '-t', String(length), '-i', inputName, '-c', 'copy', outName];
  const bitrate = encMode === 'aac96' ? '96k' : encMode === 'aac192' ? '192k' : '128k';
  return ['-ss', String(start), '-t', String(length), '-i', inputName, '-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', outName];
}

function addRow(seg){
  const tr = document.createElement('tr');
  const cells = [
    seg.index, formatHMS(seg.start), formatHMS(seg.length), humanBytes(seg.estBytes), '—', '—'
  ].map(text => { const td = document.createElement('td'); td.textContent = text; return td; });
  cells.forEach(td => tr.appendChild(td));
  els.segmentsTblBody.appendChild(tr);
}

async function purgeWorkspace() {
  clearAlerts(); clearTable();
  try {
    const files = ffmpeg?.FS && ffmpeg.FS('readdir', '.') || [];
    files?.forEach(name => { if (name !== '.' && name !== '..') { try { ffmpeg.FS('unlink', name); } catch {} }});
    ffmpeg?.exit();
  } catch {}
  if (inputUrl) { URL.revokeObjectURL(inputUrl); inputUrl = null; }
  inputFile = null; planned = [];
  setStatus('Workspace cleared.');
  enable(els.runBtn, false); enable(els.clearBtn, false);
}

els.file.addEventListener('change', async () => {
  await purgeWorkspace();
  inputFile = els.file.files[0];
  if (!inputFile) return;
  await probeDuration(inputFile);
  enable(els.planBtn, true);
});

els.planBtn.addEventListener('click', () => {
  if (!inputFile) return;
  clearAlerts(); clearTable();
  const maxMB = Number(els.maxMB.value || 20);
  planned = planSegments(inputFile.size, durationSec, maxMB);
  planned.forEach(addRow);
  setStatus(`Planned ${planned.length} segments (target ≤ ${maxMB} MB).`);
  enable(els.runBtn, true); enable(els.clearBtn, true);
});

els.runBtn.addEventListener('click', async () => {
  if (!inputFile || planned.length === 0) return;
  await initFFmpeg();

  setStatus('Preparing input...');
  const inputExt = (inputFile.name.split('.').pop() || 'm4a').toLowerCase();
  const inputPath = 'input.' + inputExt;
  try {
    ffmpeg.FS('writeFile', inputPath, await fetchFile(inputFile));
  } catch (e) {
    alertWarn('Could not write input to FFmpeg. Try a different browser or local server.');
    setStatus('Write error: ' + (e?.message || e)); return;
  }

  setStatus('Detecting codec...');
  const canCopyAac = await detectIsAacM4a(inputPath);
  const encMode = els.encoding.value;

  const maxBytes = Number(els.maxMB.value || 20) * 1024 * 1024;
  const total = planned.length;
  let anyTooLarge = false;

  setStatus('Splitting...');
  for (let i = 0; i < planned.length; i++) {
    const seg = planned[i];
    const out = `part_${String(i+1).padStart(2,'0')}.m4a`;
    try {
      await ffmpeg.run(...argsForSegment(encMode, seg.start, seg.length, inputPath, out, canCopyAac));
      const data = ffmpeg.FS('readFile', out);
      const blob = new Blob([data.buffer], { type: 'audio/mp4' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = withPartSuffix(inputFile.name, i+1, total);
      a.textContent = 'Download';
      a.className = 'download';
      a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 250));

      const row = els.segmentsTblBody.querySelectorAll('tr')[i];
      const cells = row.querySelectorAll('td');
      cells[4].textContent = humanBytes(blob.size);
      cells[5].innerHTML = ''; cells[5].appendChild(a);

      try { ffmpeg.FS('unlink', out); } catch {}
      if (blob.size > maxBytes) anyTooLarge = true;
    } catch (e) {
      alertWarn(`Segment ${i+1} failed: ${(e?.message || e)}`);
    }
  }

  try { ffmpeg.FS('unlink', inputPath); } catch {}
  setStatus('Done. Download each part above.');
  if (anyTooLarge) alertWarn('One or more segments exceed the configured size. Consider lowering the MB limit or re-planning with more segments.');
});

els.clearBtn.addEventListener('click', purgeWorkspace);
