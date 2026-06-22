/* Hearings Recording Splitter – test build
 * - Portal-agnostic
 * - Default max size 20MB (configurable)
 * - Append "(part X of Y)" to filenames
 * - Default encoding: same as source when possible (stream-copy AAC/M4A)
 * - Dropdown for AAC bitrates
 * - Immediate deletion of temporary files once files are handed to the browser
 */

const { createFFmpeg, fetchFile } = FFmpeg; // UMD global from ffmpeg.min.js

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

function formatHMS(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  return [h,m,sc].map(v => String(v).padStart(2,'0')).join(':');
}
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/(1024*1024)).toFixed(1)} MB`;
}

function baseName(fileName) {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) return fileName;
  return fileName.slice(0, idx);
}
function extName(fileName) {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx) : '';
}
function withPartSuffix(fileName, i, total) {
  const base = baseName(fileName);
  const ext = '.m4a'; // always produce M4A
  return `${base} (part ${String(i)} of ${String(total)})${ext}`;
}

async function probeDuration(file) {
  // Use HTMLAudioElement for reliable duration
  inputUrl = URL.createObjectURL(file);
  const audio = new Audio(inputUrl);
  await new Promise(resolve => {
    audio.addEventListener('loadedmetadata', resolve, { once: true });
    audio.addEventListener('error', resolve, { once: true });
  });
  durationSec = Number.isFinite(audio.duration) ? audio.duration : 0;
  els.fileInfo.textContent =
    `File: ${file.name}
     | Size: ${humanBytes(file.size)}
     | Duration: ${durationSec ? formatHMS(durationSec) : 'unknown'}`;
}

function planSegments(fileSizeBytes, durationSec, maxMB) {
  const S = maxMB * 1024 * 1024;
  // avg bytes per second heuristic
  const avgBps = durationSec > 0 ? (fileSizeBytes / durationSec) : (128000/8); // fallback ~16KB/s for 128kbps
  const targetSec = Math.max(1, Math.floor(S / avgBps));
  const num = Math.ceil(durationSec / targetSec) || 1;

  const segs = [];
  for (let i = 0; i < num; i++) {
    const start = i * targetSec;
    const end = Math.min(durationSec, (i+1) * targetSec);
    const length = Math.max(0, end - start);
    const estBytes = Math.floor(length * avgBps);
    segs.push({ index: i+1, start, length, estBytes });
  }
  return segs;
}

async function initFFmpeg() {
  if (ffmpeg) return;
  ffmpeg = createFFmpeg({
    log: true,
    corePath: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/ffmpeg-core.js'
  });
  els.status.textContent = 'Loading FFmpeg core...';
  await ffmpeg.load();
}

async function detectIsAacM4a(inputName) {
  // Attempt to detect codec (best-effort). If logs mention "Audio: aac",
  // treat as AAC-in-M4A (eligible for -c copy). Otherwise, default to transcode.
  let isAac = false;
  ffmpeg.setLogger(({ message }) => {
    if (/Audio:\s*aac/i.test(message)) isAac = true;
  });
  try {
    await ffmpeg.run('-hide_banner', '-i', inputName, '-f', 'null', '-');
  } catch {}
  ffmpeg.setLogger(() => {}); // reset logger
  return isAac;
}

function makeArgsForSegment(encMode, start, length, inputName, outName, canCopyAac) {
  if (encMode === 'auto' && canCopyAac) {
    return ['-ss', String(start), '-t', String(length), '-i', inputName, '-c', 'copy', outName];
  }
  const bitrate = (
    encMode === 'aac96' ? '96k' :
    encMode === 'aac192' ? '192k' : '128k'
  );
  return ['-ss', String(start), '-t', String(length), '-i', inputName,
          '-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart', outName];
}

function rowForSegment(seg) {
  const tr = document.createElement('tr');
  const tds = [
    seg.index,
    formatHMS(seg.start),
    formatHMS(seg.length),
    humanBytes(seg.estBytes),
    '—',
    '—'
  ].map(text => {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  });
  tds.forEach(td => tr.appendChild(td));
  return { tr, tds };
}

function clearTable() {
  els.segmentsTblBody.innerHTML = '';
  els.alerts.innerHTML = '';
}

function warn(msg) {
  const div = document.createElement('div');
  div.className = 'warn';
  div.textContent = msg;
  els.alerts.appendChild(div);
}

function enable(el, yes) { el.disabled = !yes; }

async function purgeWorkspace() {
  // Immediate deletion of any temporary files from FFmpeg FS and browser URLs
  try {
    const files = ffmpeg?.FS && ffmpeg.FS('readdir', '.') || [];
    files.forEach(name => { if (name !== '.' && name !== '..') {
      try { ffmpeg.FS('unlink', name); } catch {}
    }});
    ffmpeg?.exit(); // release WASM memory
  } catch {}
  if (inputUrl) { URL.revokeObjectURL(inputUrl); inputUrl = null; }
  inputFile = null;
  planned = [];
  clearTable();
  els.status.textContent = 'Workspace cleared.';
  enable(els.clearBtn, false);
  enable(els.runBtn, false);
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
  clearTable();
  const maxMB = Number(els.maxMB.value || 20);
  planned = planSegments(inputFile.size, durationSec, maxMB);
  planned.forEach(seg => {
    const { tr } = rowForSegment(seg);
    els.segmentsTblBody.appendChild(tr);
  });
  els.status.textContent = `Planned ${planned.length} segments (target ≤ ${maxMB} MB).`;
  enable(els.runBtn, true);
  enable(els.clearBtn, true);
});

els.runBtn.addEventListener('click', async () => {
  if (!inputFile || planned.length === 0) return;
  await initFFmpeg();
  els.status.textContent = 'Preparing input...';
  const inputName = 'input';
  const inputExt = (extName(inputFile.name) || '.m4a').toLowerCase();
  const inputPath = inputName + inputExt;

  ffmpeg.FS('writeFile', inputPath, await fetchFile(inputFile));
  els.status.textContent = 'Detecting codec...';
  const canCopyAac = await detectIsAacM4a(inputPath);
  const encMode = els.encoding.value;

  const maxBytes = Number(els.maxMB.value || 20) * 1024 * 1024;
  const total = planned.length;

  els.status.textContent = 'Splitting...';
  let anyTooLarge = false;

  for (let i = 0; i < planned.length; i++) {
    const seg = planned[i];
    const partOut = `part_${String(i+1).padStart(2,'0')}.m4a`;
    const args = makeArgsForSegment(encMode, seg.start, seg.length, inputPath, partOut, canCopyAac);
    await ffmpeg.run(...args);
    const data = ffmpeg.FS('readFile', partOut);

    const blob = new Blob([data.buffer], { type: 'audio/mp4' });
    const sizeOK = blob.size <= maxBytes;
    if (!sizeOK) anyTooLarge = true;

    // create a one-time download link, then revoke & delete temp file
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = withPartSuffix(inputFile.name, i+1, total);
    a.textContent = 'Download';
    a.className = 'download';
    a.addEventListener('click', () => {
      setTimeout(() => URL.revokeObjectURL(url), 250);
    });

    // update row
    const row = els.segmentsTblBody.querySelectorAll('tr')[i];
    const tds = row.querySelectorAll('td');
    tds[4].textContent = humanBytes(blob.size);
    const downloadCell = tds[5];
    downloadCell.innerHTML = '';
    downloadCell.appendChild(a);

    // delete FFmpeg temp for this part immediately
    try { ffmpeg.FS('unlink', partOut); } catch {}
  }

  // delete input from FFmpeg FS
  try { ffmpeg.FS('unlink', inputPath); } catch {}

  els.status.textContent = 'Done. You can download each part above.';
  if (anyTooLarge) {
    warn('One or more segments exceed the configured size. Consider increasing the number of segments (lower MB limit or re-plan).');
  }
});

els.clearBtn.addEventListener('click', purgeWorkspace);

// PWA install/offline, registered in sw.js; nothing else here