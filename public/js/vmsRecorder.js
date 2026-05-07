// VMS Recorder client — ERP version.
// - Records via canvas-overlay capture so the watermark is burned into pixels.
// - Watermark uses *server* time (no trust on local clock).
// - 2-minute hard cap.
// - Uploads directly to S3 via presigned PUT.

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    video: $('vmsVideo'),
    canvas: $('vmsCanvas'),
    awb: $('vmsAwb'),
    packer: $('vmsPacker'),
    marketplace: $('vmsMarketplace'),
    start: $('vmsStart'),
    stop: $('vmsStop'),
    switch: $('vmsSwitch'),
    status: $('vmsStatus'),
    awbInfo: $('vmsAwbInfo'),
    progress: $('vmsProgress'),
    uploadMsg: $('vmsUploadMsg'),
    awbTable: $('vmsAwbTable'),
    pendingCount: $('vmsPendingCount'),
    recentTable: $('vmsRecentTable'),
    refresh: $('vmsRefresh'),
  };

  const state = {
    stream: null,
    cameras: [],
    cameraIndex: 0,
    recorder: null,
    chunks: [],
    recording: false,
    serverOffsetMs: 0, // serverNow - clientNow
    currentAwb: null,
    autoStopTimer: null,
    startedAt: null,
    mimeType: null,
    queuedAwb: null, // next AWB scanned while a recording is still active
  };

  const MAX_DURATION_MS = 2 * 60 * 1000;

  // ---------- helpers ----------
  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.classList.remove('connected', 'recording');
    if (cls) els.status.classList.add(cls);
  }

  function setProgress(pct, msg) {
    els.progress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (msg !== undefined) els.uploadMsg.textContent = msg;
  }

  function fmtBytes(n) {
    if (!n) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n > 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${u[i]}`;
  }

  function serverNow() {
    return new Date(Date.now() + state.serverOffsetMs);
  }

  function fmtServerTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  async function syncServerTime() {
    try {
      const t0 = Date.now();
      const res = await fetch('/vms/api/server-time', { credentials: 'same-origin' });
      const data = await res.json();
      const t1 = Date.now();
      const rtt = t1 - t0;
      const serverMs = new Date(data.now).getTime();
      // best-effort: assume request and response symmetric
      state.serverOffsetMs = serverMs - (t0 + rtt / 2);
    } catch (err) {
      console.warn('server-time sync failed', err);
    }
  }

  // ---------- camera ----------
  async function listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.cameras = devices.filter((d) => d.kind === 'videoinput');
    } catch (err) { console.warn(err); }
  }

  async function startCamera(deviceId) {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
        audio: false, // explicit: no audio (per requirement)
      });
      els.video.srcObject = state.stream;
      await new Promise((res) => {
        if (els.video.readyState >= 1) return res();
        els.video.onloadedmetadata = () => res();
      });
      els.canvas.width = els.video.videoWidth || 640;
      els.canvas.height = els.video.videoHeight || 480;
      setStatus('Camera connected', 'connected');
    } catch (err) {
      setStatus('Camera unavailable: ' + err.message);
      throw err;
    }
  }

  async function switchCamera() {
    if (state.cameras.length < 2) return;
    state.cameraIndex = (state.cameraIndex + 1) % state.cameras.length;
    await startCamera(state.cameras[state.cameraIndex].deviceId);
  }

  // ---------- watermark ----------
  function drawWatermark() {
    if (!state.recording) return;
    const ctx = els.canvas.getContext('2d');
    ctx.drawImage(els.video, 0, 0, els.canvas.width, els.canvas.height);

    const lines = [
      `Server Time: ${fmtServerTime(serverNow())}`,
      `Packer: ${els.packer.value || '-'}`,
      `AWB: ${state.currentAwb || ''}`,
      `Marketplace: ${els.marketplace.value || ''}`,
    ];
    const boxW = Math.min(els.canvas.width - 20, 600);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, boxW, 22 * lines.length + 16);
    ctx.fillStyle = '#fff';
    ctx.font = '18px Arial';
    lines.forEach((l, i) => ctx.fillText(l, 20, 32 + i * 22));

    requestAnimationFrame(drawWatermark);
  }

  // ---------- recording ----------
  function pickMimeType() {
    const candidates = [
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return 'video/webm';
  }

  async function startRecording() {
    const awb = (els.awb.value || '').trim();
    const marketplace = (els.marketplace.value || '').trim();
    const packer = (els.packer.value || '').trim();
    if (!awb) { setStatus('Scan or enter AWB'); return; }
    if (!marketplace) { setStatus('Select marketplace first'); return; }
    if (!packer) { setStatus('Enter packer name first'); return; }
    if (!state.stream) { setStatus('Camera not ready'); return; }

    // Barcode-scanner chain: if a recording is already running, queue this AWB
    // and stop the current one. The onstop handler will start the queued AWB
    // immediately, while the previous recording's upload runs in the background.
    if (state.recording) {
      state.queuedAwb = awb;
      els.awb.value = '';
      stopRecording();
      return;
    }

    // Pre-flight info — non-blocking, never interrupts the scan flow.
    fetch(`/vms/api/awb/${encodeURIComponent(awb)}`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => {
        const parts = [];
        if (j?.shipment) {
          parts.push(`<span class="vms-tag ok">In ee_shipments</span> Ref: ${j.shipment.reference_code || '-'} • Status: ${j.shipment.current_status || '-'}`);
        } else {
          parts.push(`<span class="vms-tag warn">Not yet in ee_shipments</span> — recording allowed; will reconcile later.`);
        }
        if (j?.video) {
          parts.push(`<span style="color:#dc2626">⚠ Already has video — upload will be rejected.</span>`);
        }
        els.awbInfo.innerHTML = parts.join(' ');
      })
      .catch(() => {});

    state.currentAwb = awb;
    state.chunks = [];
    state.mimeType = pickMimeType();
    els.awb.value = '';

    const canvasStream = els.canvas.captureStream(30);
    state.recorder = new MediaRecorder(canvasStream, { mimeType: state.mimeType });
    state.recorder.ondataavailable = (ev) => { if (ev.data?.size) state.chunks.push(ev.data); };
    state.recorder.onstop = () => {
      // Snapshot this recording's data so a new recording can start
      // immediately on the same canvas without clobbering the upload.
      const chunks = state.chunks;
      const mimeType = state.mimeType;
      const startedAt = state.startedAt;
      // Fire upload in background — do not await.
      onRecordingStopped(awb, marketplace, packer, chunks, mimeType, startedAt);
      // Chain into the queued AWB so the operator never has to click.
      if (state.queuedAwb) {
        const next = state.queuedAwb;
        state.queuedAwb = null;
        els.awb.value = next;
        // brief tick lets MediaRecorder fully tear down before re-arming
        setTimeout(() => startRecording(), 100);
      } else {
        els.awb.focus();
      }
    };

    state.recording = true;
    state.startedAt = Date.now();
    state.recorder.start();
    setStatus(`Recording AWB ${awb}`, 'recording');
    els.start.disabled = true;
    els.stop.disabled = false;

    // 2-min auto-stop
    state.autoStopTimer = setTimeout(() => {
      if (state.recording) {
        setStatus('2-min limit reached, stopping…', 'recording');
        stopRecording();
      }
    }, MAX_DURATION_MS);

    requestAnimationFrame(drawWatermark);
  }

  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    if (state.autoStopTimer) clearTimeout(state.autoStopTimer);
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    els.start.disabled = false;
    els.stop.disabled = true;
    setStatus('Camera connected', 'connected');
  }

  async function onRecordingStopped(awb, marketplace, packer, chunks, mimeType, startedAt) {
    if (!chunks || !chunks.length) {
      setProgress(0, `No data captured for ${awb}`);
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    const durationMs = Date.now() - startedAt;
    const clientStartedAt = new Date(startedAt).toISOString();

    setProgress(5, `Uploading ${awb}…`);

    let presign;
    try {
      const r = await fetch('/vms/api/upload-url', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ awb, packerName: packer, marketplace, mimeType }),
      });
      presign = await r.json();
      if (!r.ok || !presign.ok) throw new Error(presign?.error || 'upload-url failed');
    } catch (err) {
      setProgress(0, `❌ ${awb}: ${err.message}`);
      return;
    }

    try {
      await uploadWithProgress(presign.url, blob, presign.contentType, (p) => {
        setProgress(15 + p * 75, `Uploading ${awb} ${Math.round(p * 100)}%`);
      });
    } catch (err) {
      setProgress(0, `❌ ${awb} upload failed: ${err.message}`);
      return;
    }

    setProgress(95, `Confirming ${awb}…`);
    try {
      const r = await fetch('/vms/api/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          awb, key: presign.key, marketplace, packerName: packer,
          mimeType, durationMs, clientStartedAt,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j?.error || 'confirm failed');
    } catch (err) {
      setProgress(0, `❌ ${awb} confirm failed: ${err.message}`);
      return;
    }

    setProgress(100, `✅ Saved ${awb}`);
    refreshAwbList();
    refreshRecent();
  }

  function uploadWithProgress(url, blob, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`S3 ${xhr.status}: ${xhr.responseText?.slice(0, 200)}`));
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(blob);
    });
  }

  // ---------- AWB list ----------
  async function refreshAwbList() {
    try {
      const r = await fetch('/vms/api/awbs', { credentials: 'same-origin' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      const pending = j.rows.filter((r) => !r.has_video);
      els.pendingCount.textContent = pending.length;
      els.awbTable.innerHTML = pending.length
        ? pending.slice(0, 200).map((r) => `<tr>
            <td><a href="#" data-awb="${r.awb}" class="vms-pick">${r.awb}</a></td>
            <td>${r.reference_code || '-'}</td>
            <td>${r.label_printed_at ? new Date(r.label_printed_at).toLocaleString() : '-'}</td>
            <td>${r.current_status || '-'}</td>
          </tr>`).join('')
        : `<tr><td colspan="4" style="text-align:center;color:#64748b;">No pending AWBs</td></tr>`;
      els.awbTable.querySelectorAll('.vms-pick').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          els.awb.value = a.dataset.awb;
          els.awb.focus();
        });
      });
    } catch (err) {
      els.awbTable.innerHTML = `<tr><td colspan="4" style="color:#dc2626;">${err.message}</td></tr>`;
    }
  }

  async function refreshRecent() {
    try {
      const r = await fetch('/vms/api/recent?limit=20', { credentials: 'same-origin' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      els.recentTable.innerHTML = j.rows.length
        ? j.rows.map((r) => `<tr>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>${r.awb}</td>
            <td>${r.packer_name || '-'}</td>
            <td>${fmtBytes(r.size_bytes)}</td>
          </tr>`).join('')
        : `<tr><td colspan="4" style="text-align:center;color:#64748b;">No uploads yet</td></tr>`;
    } catch (err) {
      els.recentTable.innerHTML = `<tr><td colspan="4" style="color:#dc2626;">${err.message}</td></tr>`;
    }
  }

  // ---------- wiring ----------
  els.start.addEventListener('click', startRecording);
  els.stop.addEventListener('click', stopRecording);
  els.switch.addEventListener('click', switchCamera);
  els.refresh.addEventListener('click', () => { refreshAwbList(); refreshRecent(); });
  els.awb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); startRecording(); }
  });

  (async () => {
    await syncServerTime();
    setInterval(syncServerTime, 5 * 60 * 1000);
    await listCameras();
    try { await startCamera(); } catch (_) {}
    refreshAwbList();
    refreshRecent();
    setInterval(refreshAwbList, 60 * 1000);
  })();
})();
