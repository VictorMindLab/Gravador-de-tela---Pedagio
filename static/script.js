(() => {
  const previewEl = document.getElementById('preview');
  const recordBtn = document.getElementById('recordBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const timerEl = document.getElementById('timer');
  const standbyOverlay = document.getElementById('standbyOverlay');
  const micToggle = document.getElementById('micToggle');
  const sysAudioToggle = document.getElementById('sysAudioToggle');
  const fpsSelect = document.getElementById('fpsSelect');
  const resSelect = document.getElementById('resSelect');
  const qualitySelect = document.getElementById('qualitySelect');
  const recordingsEl = document.getElementById('recordings');
  const helpChip = document.getElementById('helpChip');
  const helpDialog = document.getElementById('helpDialog');
  const areaToggle = document.getElementById('areaToggle');
  const selectAreaBtn = document.getElementById('selectAreaBtn');
  const cropOverlay = document.getElementById('cropOverlay');
  const cropBox = document.getElementById('cropBox');
  const cropConfirmBtn = document.getElementById('cropConfirmBtn');
  const cropCancelBtn = document.getElementById('cropCancelBtn');
  const scheduleToggle = document.getElementById('scheduleToggle');
  const scheduleStart = document.getElementById('scheduleStart');
  const scheduleEnd = document.getElementById('scheduleEnd');
  const scheduleBtn = document.getElementById('scheduleBtn');
  const cancelScheduleBtn = document.getElementById('cancelScheduleBtn');
  const scheduleStatus = document.getElementById('scheduleStatus');
  const preselectSourceBtn = document.getElementById('preselectSourceBtn');
  const preselectStatus = document.getElementById('preselectStatus');
  const autoSaveToggle = document.getElementById('autoSaveToggle');
  const pickDirBtn = document.getElementById('pickDirBtn');
  const dirStatus = document.getElementById('dirStatus');
  // Multi-schedule UI
  const newScheduleStart = document.getElementById('newScheduleStart');
  const newScheduleEnd = document.getElementById('newScheduleEnd');
  const addScheduleBtn = document.getElementById('addScheduleBtn');
  const newAutoSave = document.getElementById('newAutoSave');
  const scheduleList = document.getElementById('scheduleList');

  let displayStream = null;
  let microphoneStream = null;
  let mixedStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let timerId = null;
  let startTime = 0;
  let pausedMs = 0;
  let pauseStart = 0;
  let cropRect = null; // { x, y, w, h } relativo ao preview
  let scheduledTimeoutStart = null;
  let scheduledTimeoutStop = null;
  let preselectedStream = null; // stream escolhido antes do horário
  let saveDirectoryHandle = null; // File System Access API
  let micPermissionState = 'prompt';
  let preferredMicDeviceId = localStorage.getItem('preferredMicId') || null;

  function isStreamActive(stream){
    return !!stream && stream.getTracks().some(t => t.readyState === 'live');
  }

  function setMicEnabled(enabled){
    if (!microphoneStream) return;
    microphoneStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }

  // Incremental auto-save (streaming para arquivo)
  let currentFileHandle = null;
  let currentWritable = null;
  let currentWriteQueue = Promise.resolve();
  let currentFileName = null;
  let currentRecordingOwner = null; // null = manual, ou id do agendamento

  async function beginAutoSave(dirHandle){
    const name = filename('Gravacao', 'webm');
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    currentFileHandle = fileHandle;
    currentWritable = writable;
    currentFileName = name;
  }

  function enqueueWrite(chunk){
    if (!currentWritable) return;
    currentWriteQueue = currentWriteQueue.then(() => currentWritable.write(chunk)).catch(err => console.error('Falha ao gravar chunk:', err));
  }

  async function finalizeFileAndGetURL(){
    if (!currentWritable || !currentFileHandle) return null;
    try {
      await currentWriteQueue; // garante que todos os writes terminaram
      await currentWritable.close();
      const file = await currentFileHandle.getFile();
      const url = URL.createObjectURL(file);
      const sizeMB = (file.size / (1024*1024)).toFixed(2);
      const name = currentFileName;
      // limpar contexto
      currentWritable = null; currentFileHandle = null; currentFileName = null; currentWriteQueue = Promise.resolve();
      return { url, sizeMB, name, file };
    } catch(err){
      console.error('Falha ao finalizar arquivo:', err);
      return null;
    }
  }
  const schedules = new Map(); // id -> { start, end, options, timers, preselectedStream, saveDirHandle }

  function formatTime(ms){
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2,'0');
    const m = String(Math.floor((total % 3600)/60)).padStart(2,'0');
    const s = String(total % 60).padStart(2,'0');
    return `${h}:${m}:${s}`;
  }

  function startTimer(){
    startTime = Date.now();
    pausedMs = 0;
    clearInterval(timerId);
    timerId = setInterval(() => {
      const elapsed = Date.now() - startTime - pausedMs;
      timerEl.textContent = formatTime(elapsed);
    }, 200);
  }

  function pauseTimer(){
    pauseStart = Date.now();
  }

  function resumeTimer(){
    if (pauseStart) {
      pausedMs += Date.now() - pauseStart;
      pauseStart = 0;
    }
  }

  function resetTimer(){
    clearInterval(timerId);
    timerEl.textContent = '00:00:00';
    startTime = 0; pausedMs = 0; pauseStart = 0;
  }

  function setUIRecordingState(isRecording){
    recordBtn.setAttribute('aria-pressed', isRecording ? 'true' : 'false');
    recordBtn.querySelector('.label').textContent = isRecording ? 'Gravando' : 'Gravar';
    pauseBtn.disabled = !isRecording;
    stopBtn.disabled = !isRecording;
    micToggle.disabled = isRecording;
    sysAudioToggle.disabled = isRecording;
    fpsSelect.disabled = isRecording;
    resSelect.disabled = isRecording;
    qualitySelect.disabled = isRecording;
    standbyOverlay.style.display = isRecording ? 'none' : 'flex';
    // sync fancy dropdown disabled
    syncFancyDisabled(resSelect);
    syncFancyDisabled(fpsSelect);
    syncFancyDisabled(qualitySelect);
    if (areaToggle){
      areaToggle.disabled = isRecording;
      selectAreaBtn.disabled = isRecording || !areaToggle.checked;
    }
  }

  function getSelectedResolution(){
    const value = resSelect?.value;
    if (!value) return null;
    const [w, h] = value.split('x').map(Number);
    if (!w || !h) return null;
    return { width: w, height: h };
  }

  async function getDisplayStream(){
    const fps = Number(fpsSelect.value);
    const wantSystemAudio = sysAudioToggle.checked;
    const res = getSelectedResolution();
    const video = { frameRate: fps };
    if (res){
      // Use valores ideais; alguns navegadores podem ignorar
      video.width = { ideal: res.width };
      video.height = { ideal: res.height };
    }
    const constraints = { video, audio: wantSystemAudio };
    const stream = preselectedStream || await navigator.mediaDevices.getDisplayMedia(constraints);
    // Tentar reforçar as constraints no track (pode ser ignorado para capture)
    try {
      const track = stream.getVideoTracks()[0];
      const toApply = { frameRate: fps };
      if (res){ toApply.width = res.width; toApply.height = res.height; }
      await track.applyConstraints(toApply);
    } catch (err){
      console.warn('applyConstraints indisponível/ignorado:', err);
    }
    return stream;
  }

  // Fancy dropdown implementation
  function enhanceSelect(selectElement){
    const container = selectElement.closest('.select');
    if (!container || container.classList.contains('has-fancy')) return;
    container.classList.add('has-fancy');
    selectElement.classList.add('fancy-hidden');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'fancy-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const valueSpan = document.createElement('span');
    valueSpan.className = 'value';
    valueSpan.textContent = selectElement.options[selectElement.selectedIndex]?.text || '';
    const chev = document.createElement('span');
    chev.className = 'chev';
    trigger.appendChild(valueSpan);
    trigger.appendChild(chev);

    const list = document.createElement('ul');
    list.className = 'fancy-options';
    list.setAttribute('role', 'listbox');

    Array.from(selectElement.options).forEach((opt, idx) => {
      const li = document.createElement('li');
      li.className = 'fancy-option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      li.textContent = opt.text;
      if (idx === selectElement.selectedIndex) li.setAttribute('aria-selected', 'true');
      li.addEventListener('click', () => {
        selectElement.value = opt.value;
        selectElement.dispatchEvent(new Event('change', { bubbles: true }));
        updateFancy(selectElement, container, trigger, list);
        list.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      });
      list.appendChild(li);
    });

    container.appendChild(trigger);
    container.appendChild(list);

    function toggle(){
      if (selectElement.disabled) return;
      const isOpen = list.classList.toggle('open');
      trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    trigger.addEventListener('click', toggle);
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)){
        list.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });

    selectElement.addEventListener('change', () => {
      updateFancy(selectElement, container, trigger, list);
    });

    syncFancyDisabled(selectElement);
  }

  function updateFancy(selectElement, container, trigger, list){
    const text = selectElement.options[selectElement.selectedIndex]?.text || '';
    trigger.querySelector('.value').textContent = text;
    Array.from(list.children).forEach(li => {
      li.setAttribute('aria-selected', li.dataset.value === selectElement.value ? 'true' : 'false');
    });
  }

  function syncFancyDisabled(selectElement){
    const container = selectElement.closest('.select');
    const trig = container?.querySelector('.fancy-select-trigger');
    if (!container || !trig) return;
    if (selectElement.disabled){
      container.classList.add('fancy-disabled');
      trig.setAttribute('disabled', '');
    } else {
      container.classList.remove('fancy-disabled');
      trig.removeAttribute('disabled');
    }
  }

  async function getMicrophoneStream(){
    if (!micToggle.checked) return null;
    try {
      // Tenta usar permissão persistida e dispositivo preferido
      if (navigator.permissions && navigator.permissions.query){
        try {
          const status = await navigator.permissions.query({ name: 'microphone' });
          micPermissionState = status.state; // 'granted' | 'denied' | 'prompt'
        } catch {}
      }

      const constraintsBase = { audio: preferredMicDeviceId ? { deviceId: { exact: preferredMicDeviceId } } : true };
      const stream = await navigator.mediaDevices.getUserMedia(constraintsBase);

      // Memoriza o deviceId para futuras sessões
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings();
      if (settings.deviceId){
        preferredMicDeviceId = settings.deviceId;
        localStorage.setItem('preferredMicId', preferredMicDeviceId);
      }
      return stream;
    } catch(err){
      console.warn('Microfone não disponível:', err);
      return null;
    }
  }

  async function buildMixedStream(){
    const wantMic = !!microphoneStream && microphoneStream.getAudioTracks().length > 0;
    const wantSys = !!displayStream && displayStream.getAudioTracks().length > 0;
    const videoTrack = displayStream.getVideoTracks()[0];

    if (!wantMic && !wantSys){
      return new MediaStream([videoTrack]);
    }

    if (wantMic && !wantSys){
      return new MediaStream([videoTrack, microphoneStream.getAudioTracks()[0]]);
    }

    if (!wantMic && wantSys){
      return new MediaStream([videoTrack, displayStream.getAudioTracks()[0]]);
    }

    // Mix mic + system audio
    const audioContext = new AudioContext();
    const dest = audioContext.createMediaStreamDestination();
    const micSource = audioContext.createMediaStreamSource(microphoneStream);
    const sysSource = audioContext.createMediaStreamSource(new MediaStream([displayStream.getAudioTracks()[0]]));
    micSource.connect(dest);
    sysSource.connect(dest);
    const mixedAudioTrack = dest.stream.getAudioTracks()[0];
    return new MediaStream([videoTrack, mixedAudioTrack]);
  }

  function pickSupportedMime(){
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (const type of candidates){
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  function filename(prefix, ext){
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    const name = `${prefix}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
    return name;
  }

  async function startRecording(){
    try {
      displayStream = await getDisplayStream();
      // Reutiliza stream de microfone já concedido para evitar novo prompt
      if (!isStreamActive(microphoneStream)){
        microphoneStream = await getMicrophoneStream();
      }
      mixedStream = await buildMixedStream();

      if (areaToggle && areaToggle.checked && cropRect){
        mixedStream = await createCroppedStream(mixedStream, cropRect);
      }

      previewEl.srcObject = displayStream;
      recordedChunks = [];

      const type = pickSupportedMime();
      const videoBitsPerSecond = Number(qualitySelect.value);
      mediaRecorder = new MediaRecorder(mixedStream, { mimeType: type || undefined, videoBitsPerSecond });

      mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) {
          if (autoSaveToggle?.checked && saveDirectoryHandle){ enqueueWrite(e.data); }
          else { recordedChunks.push(e.data); }
        }
      };
      mediaRecorder.onstop = handleStop;
      mediaRecorder.start(800); // timeslice

      if (autoSaveToggle?.checked && saveDirectoryHandle){ await beginAutoSave(saveDirectoryHandle); }

      setUIRecordingState(true);
      startTimer();

      displayStream.getVideoTracks()[0].addEventListener('ended', () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
      });
    } catch(err){
      console.error(err);
      alert('Não foi possível iniciar a gravação. Verifique permissões.');
      cleanupStreams();
      setUIRecordingState(false);
      resetTimer();
    }
  }

  function pauseRecording(){
    if (!mediaRecorder) return;
    if (mediaRecorder.state === 'recording'){
      mediaRecorder.pause();
      pauseBtn.textContent = 'Retomar';
      pauseTimer();
    } else if (mediaRecorder.state === 'paused'){
      mediaRecorder.resume();
      pauseBtn.textContent = 'Pausar';
      resumeTimer();
    }
  }

  function stopRecording(){
    if (!mediaRecorder) return;
    if (mediaRecorder.state !== 'inactive'){
      mediaRecorder.stop();
    }
  }

  function cleanupStreams(){
    const stopTracks = stream => stream && stream.getTracks().forEach(t => t.stop());
    stopTracks(displayStream); displayStream = null;
    // Não paramos o microfone para preservar a permissão e evitar novo prompt
    // Apenas silenciamos para não consumir CPU/áudio quando inativo
    setMicEnabled(false);
    stopTracks(mixedStream); mixedStream = null;
    previewEl.srcObject = null;
  }

  function handleStop(){
    // Se estivermos em modo de auto-save incremental, finalize o arquivo
    const isStreaming = !!currentWritable;
    if (isStreaming){
      finalizeFileAndGetURL().then(res => {
        if (!res) return;
        addRecordingCard(res.url, res.name, res.sizeMB, res.file);
      });
    } else {
      const blob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const sizeMB = (blob.size / (1024*1024)).toFixed(2);
      const name = filename('Gravacao', 'webm');
      if (autoSaveToggle?.checked && saveDirectoryHandle){
        saveBlobToDirectory(saveDirectoryHandle, name, blob).catch(console.error);
      }
      addRecordingCard(url, name, sizeMB, blob);
    }

    setUIRecordingState(false);
    resetTimer();
    cleanupStreams();
  }

  // ----- Preselect source -----
  if (preselectSourceBtn){
    preselectSourceBtn.addEventListener('click', async () => {
      try {
        // Captura a fonte agora e guarda o stream para uso no agendamento
        const prev = preselectedStream;
        preselectedStream = await getDisplayStream();
        if (prev) prev.getTracks().forEach(t => t.stop());
        preselectStatus.hidden = false;
        preselectStatus.textContent = 'Fonte pré-selecionada';
      } catch(err){
        console.error(err);
        alert('Não foi possível pré-selecionar a fonte.');
      }
    });
  }

  // ----- Auto save (File System Access API) -----
  if (pickDirBtn){
    pickDirBtn.addEventListener('click', async () => {
      try {
        saveDirectoryHandle = await window.showDirectoryPicker();
        dirStatus.hidden = false;
        dirStatus.textContent = 'Pasta selecionada';
      } catch(err){
        if (err?.name !== 'AbortError') console.error(err);
      }
    });
  }

  function renderSchedules(){
    if (!scheduleList) return;
    scheduleList.innerHTML = '';
    Array.from(schedules.entries()).sort((a,b)=>a[1].start-b[1].start).forEach(([id, s]) => {
      const card = document.createElement('div');
      card.className = 'schedule-card';
      card.innerHTML = `
        <div class="row">
          <div>
            <div class="title">${new Date(s.start).toLocaleString()} → ${new Date(s.end).toLocaleString()}</div>
            <div class="sub">${s.options.areaToggle ? 'Área' : 'Tela inteira'} • ${s.options.fps} FPS • ${s.options.resText} • ${s.options.autoSave ? 'AutoSave' : 'Manual'}</div>
          </div>
          <div class="actions">
            <button class="btn" data-action="preselect">Pré-selecionar fonte</button>
            <button class="btn" data-action="dir">Pasta</button>
            <button class="btn btn-danger" data-action="delete">Excluir</button>
          </div>
        </div>
      `;
      const act = card.querySelector('.actions');
      act.querySelector('[data-action="preselect"]').addEventListener('click', async () => {
        try {
          const prev = s.preselectedStream;
          s.preselectedStream = await getDisplayMediaForSchedule(s.options);
          if (prev) prev.getTracks().forEach(t=>t.stop());
          act.querySelector('[data-action="preselect"]').textContent = 'Fonte ok';
        } catch(err){ alert('Falha na pré-seleção.'); console.error(err); }
      });
      act.querySelector('[data-action="dir"]').addEventListener('click', async () => {
        try { s.saveDirHandle = await window.showDirectoryPicker(); } catch(err){ if (err?.name !== 'AbortError') console.error(err); }
      });
      act.querySelector('[data-action="delete"]').addEventListener('click', () => cancelSchedule(id));
      scheduleList.appendChild(card);
    });
  }

  async function getDisplayMediaForSchedule(options){
    const video = { frameRate: options.fps };
    if (options.res){ video.width = { ideal: options.res.width }; video.height = { ideal: options.res.height }; }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: options.systemAudio });
    try {
      const track = stream.getVideoTracks()[0];
      const toApply = { frameRate: options.fps };
      if (options.res){ toApply.width = options.res.width; toApply.height = options.res.height; }
      await track.applyConstraints(toApply);
    } catch {}
    return stream;
  }

  async function saveBlobToDirectory(dirHandle, fileName, blob){
    try {
      const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch(err){
      console.error('Falha ao salvar automaticamente:', err);
    }
  }

  // ----- Crop selection UI -----
  if (areaToggle && selectAreaBtn){
    areaToggle.addEventListener('change', () => {
      selectAreaBtn.disabled = !areaToggle.checked || (mediaRecorder && mediaRecorder.state !== 'inactive');
      if (!areaToggle.checked){ cropRect = null; }
    });
    selectAreaBtn.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') return;
      beginCropSelection();
    });
  }

  function beginCropSelection(){
    cropRect = null;
    cropOverlay.hidden = false;
    cropBox.hidden = true;
    const bounds = previewEl.getBoundingClientRect();
    let startX = 0, startY = 0, currentX = 0, currentY = 0, dragging = false;

    function toLocal(clientX, clientY){
      const x = Math.min(Math.max(0, clientX - bounds.left), bounds.width);
      const y = Math.min(Math.max(0, clientY - bounds.top), bounds.height);
      return { x, y };
    }

    function onDown(e){
      const p = toLocal(e.clientX ?? e.touches?.[0]?.clientX, e.clientY ?? e.touches?.[0]?.clientY);
      startX = p.x; startY = p.y; dragging = true; cropBox.hidden = false;
      updateBox(p.x, p.y);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive:false });
      window.addEventListener('touchend', onUp);
    }
    function onMove(e){
      if (!dragging) return;
      const p = toLocal(e.clientX ?? e.touches?.[0]?.clientX, e.clientY ?? e.touches?.[0]?.clientY);
      currentX = p.x; currentY = p.y; updateBox(p.x, p.y);
    }
    function onUp(){ dragging = false; cleanupMove(); }
    function cleanupMove(){
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    }
    function updateBox(x, y){
      const left = Math.min(startX, x);
      const top = Math.min(startY, y);
      const w = Math.abs(x - startX);
      const h = Math.abs(y - startY);
      Object.assign(cropBox.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    }

    cropOverlay.addEventListener('mousedown', onDown, { once: true });
    cropOverlay.addEventListener('touchstart', onDown, { once: true, passive:false });

    cropConfirmBtn.onclick = () => {
      const rect = cropBox.getBoundingClientRect();
      const pb = previewEl.getBoundingClientRect();
      const x = rect.left - pb.left; const y = rect.top - pb.top;
      const w = rect.width; const h = rect.height;
      if (w < 10 || h < 10){
        alert('Área muito pequena. Selecione novamente.');
        return;
      }
      cropRect = { x, y, w, h };
      cropOverlay.hidden = true;
    };
    cropCancelBtn.onclick = () => {
      cropRect = null; cropOverlay.hidden = true;
    };
  }

  async function createCroppedStream(sourceMixedStream, rect){
    const videoTrack = sourceMixedStream.getVideoTracks()[0];
    const audioTracks = sourceMixedStream.getAudioTracks();

    const captureVideoEl = document.createElement('video');
    captureVideoEl.srcObject = new MediaStream([videoTrack]);
    captureVideoEl.muted = true; captureVideoEl.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const settings = videoTrack.getSettings();
    const previewBounds = previewEl.getBoundingClientRect();
    const scaleX = (settings.width || previewBounds.width) / previewBounds.width;
    const scaleY = (settings.height || previewBounds.height) / previewBounds.height;

    canvas.width = Math.round(rect.w * scaleX);
    canvas.height = Math.round(rect.h * scaleY);

    let rafId = 0;
    function draw(){
      const sx = Math.round(rect.x * scaleX);
      const sy = Math.round(rect.y * scaleY);
      const sw = Math.round(rect.w * scaleX);
      const sh = Math.round(rect.h * scaleY);
      try { ctx.drawImage(captureVideoEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height); } catch(e){}
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);

    const canvasStream = canvas.captureStream(Number(fpsSelect.value) || 30);
    const newVideoTrack = canvasStream.getVideoTracks()[0];
    const result = new MediaStream([newVideoTrack, ...audioTracks]);
    newVideoTrack.addEventListener('ended', () => cancelAnimationFrame(rafId));
    return result;
  }

  // ----- Scheduling (multi) -----
  if (addScheduleBtn){
    addScheduleBtn.addEventListener('click', async () => {
      const start = new Date(newScheduleStart.value);
      const end = new Date(newScheduleEnd.value);
      if (!(start instanceof Date) || isNaN(start.getTime())) return alert('Defina início.');
      if (!(end instanceof Date) || isNaN(end.getTime())) return alert('Defina fim.');
      if (end <= start) return alert('Fim deve ser após o início.');

      const res = getSelectedResolution();
      const opts = {
        fps: Number(fpsSelect.value) || 30,
        res,
        resText: res ? `${res.width}x${res.height}` : 'Auto',
        systemAudio: sysAudioToggle.checked,
        mic: micToggle.checked,
        quality: Number(qualitySelect.value),
        areaToggle: areaToggle?.checked && !!cropRect,
        cropRect: areaToggle?.checked ? { ...cropRect } : null,
        autoSave: newAutoSave.checked
      };
      const id = crypto.randomUUID();
      const s = { id, start: start.getTime(), end: end.getTime(), options: opts, timers: {}, preselectedStream: preselectedStream, saveDirHandle: saveDirectoryHandle };
      schedules.set(id, s);

      const msToStart = Math.max(0, s.start - Date.now());
      const msToEnd = Math.max(0, s.end - Date.now());
      s.timers.start = setTimeout(() => runScheduleStart(id), msToStart);
      s.timers.stop = setTimeout(() => runScheduleStop(id), msToEnd);
      renderSchedules();
    });
  }

  async function runScheduleStart(id){
    const s = schedules.get(id); if (!s) return;
    try {
      if (!s.preselectedStream){
        s.preselectedStream = await getDisplayMediaForSchedule(s.options);
      }
      displayStream = s.preselectedStream;
      if (s.options.mic){
        if (!isStreamActive(microphoneStream)){
          microphoneStream = await getMicrophoneStream();
        } else {
          setMicEnabled(true);
        }
      } else {
        microphoneStream = null;
      }
      const prevQuality = qualitySelect.value; qualitySelect.value = s.options.quality;
      mixedStream = await buildMixedStream();
      if (s.options.areaToggle && s.options.cropRect){
        mixedStream = await createCroppedStream(mixedStream, s.options.cropRect);
      }
      recordedChunks = [];
      previewEl.srcObject = displayStream;
      const type = pickSupportedMime();
      mediaRecorder = new MediaRecorder(mixedStream, { mimeType: type || undefined, videoBitsPerSecond: s.options.quality });
      mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0){
          if (s.options.autoSave && (s.saveDirHandle || saveDirectoryHandle)) enqueueWrite(e.data);
          else recordedChunks.push(e.data);
        }
      };
      mediaRecorder.onstop = () => handleStopForSchedule(id);
      mediaRecorder.start(800);
      if (s.options.autoSave && (s.saveDirHandle || saveDirectoryHandle)){
        const dir = s.saveDirHandle || saveDirectoryHandle;
        await beginAutoSave(dir);
      }
      setUIRecordingState(true);
      startTimer();
      qualitySelect.value = prevQuality;
    } catch(err){ console.error('Falha ao iniciar agendamento', err); }
  }

  function runScheduleStop(id){
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch{}
  }

  function handleStopForSchedule(id){
    const s = schedules.get(id);
    const isStreaming = !!currentWritable;
    if (isStreaming){
      finalizeFileAndGetURL().then(res => {
        if (!res) return;
        addRecordingCard(res.url, res.name, res.sizeMB, res.file);
        setUIRecordingState(false); resetTimer(); cleanupStreams();
      });
    } else {
      const blob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'video/webm' });
      const name = filename('Gravacao', 'webm');
      const dir = s?.saveDirHandle || saveDirectoryHandle;
      if (s?.options.autoSave && dir){ saveBlobToDirectory(dir, name, blob).catch(console.error); }
      const url = URL.createObjectURL(blob);
      const sizeMB = (blob.size / (1024*1024)).toFixed(2);
      addRecordingCard(url, name, sizeMB, blob);
      setUIRecordingState(false); resetTimer(); cleanupStreams();
    }
  }

  function cancelSchedule(id){
    const s = schedules.get(id); if (!s) return;
    if (s.timers.start) clearTimeout(s.timers.start);
    if (s.timers.stop) clearTimeout(s.timers.stop);
    if (s.preselectedStream) s.preselectedStream.getTracks().forEach(t=>t.stop());
    schedules.delete(id);
    renderSchedules();
  }

  function addRecordingCard(url, name, sizeMB, blob){
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="thumb"><video src="${url}" controls></video></div>
      <div class="meta">
        <div>
          <div class="title">${name}</div>
          <div class="sub">${sizeMB} MB</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-primary" data-action="to-mp4">Baixar MP4</button>
        <a class="btn" download="${name}" href="${url}">Baixar WEBM</a>
      </div>
    `;
    const convertBtn = card.querySelector('button[data-action="to-mp4"]');
    convertBtn.addEventListener('click', async () => {
      convertBtn.disabled = true;
      convertBtn.textContent = 'Baixando FFmpeg...';
      try {
        const mp4 = await convertWebmToMp4(blob, (p) => {
          convertBtn.textContent = `Convertendo... ${Math.round(p*100)}%`;
        });
        const mp4Url = URL.createObjectURL(mp4);
        const a = document.createElement('a');
        a.href = mp4Url;
        a.download = name.replace('.webm', '.mp4');
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(mp4Url);
        convertBtn.textContent = 'Baixar MP4';
      } catch(err){
        console.error(err);
        alert('Falha na conversão para MP4.');
      } finally {
        convertBtn.disabled = false;
      }
    });

    recordingsEl.prepend(card);
  }

  function ensureDialogPolyfill(){
    if (!HTMLDialogElement) return;
  }

  helpChip?.addEventListener('click', (e) => {
    e.preventDefault();
    ensureDialogPolyfill();
    helpDialog.showModal();
  });

  recordBtn.addEventListener('click', () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive'){
      startRecording();
    }
  });

  pauseBtn.addEventListener('click', () => pauseRecording());
  stopBtn.addEventListener('click', () => stopRecording());

  // State sync
  function updateButtons(){
    const state = mediaRecorder?.state || 'inactive';
    if (state === 'inactive'){
      pauseBtn.disabled = true; stopBtn.disabled = true;
      pauseBtn.textContent = 'Pausar';
    } else if (state === 'recording'){
      pauseBtn.disabled = false; stopBtn.disabled = false;
      pauseBtn.textContent = 'Pausar';
    } else if (state === 'paused'){
      pauseBtn.disabled = false; stopBtn.disabled = false;
      pauseBtn.textContent = 'Retomar';
    }
  }

  const obs = new MutationObserver(updateButtons);
  obs.observe(timerEl, { childList: true });

  // FFmpeg (opcional)
  let ffmpegInstance = null;
  async function loadFFmpeg(){
    if (ffmpegInstance) return ffmpegInstance;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/ffmpeg.min.js';
      s.async = true;
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    const { createFFmpeg, fetchFile } = window.FFmpeg;
    const ffmpeg = createFFmpeg({ log: false });
    await ffmpeg.load();
    ffmpegInstance = { ffmpeg, fetchFile };
    return ffmpegInstance;
  }

  async function convertWebmToMp4(webmBlob, onProgress){
    const { ffmpeg, fetchFile } = await loadFFmpeg();
    ffmpeg.setProgress(({ ratio }) => { if (onProgress) onProgress(ratio || 0); });
    const inName = 'input.webm';
    const outName = 'output.mp4';
    ffmpeg.FS('writeFile', inName, await fetchFile(webmBlob));
    await ffmpeg.run('-i', inName, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outName);
    const data = ffmpeg.FS('readFile', outName);
    ffmpeg.FS('unlink', inName);
    ffmpeg.FS('unlink', outName);
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  // Initial
  resetTimer();
  // Enhance all dropdowns for dark, consistent menus
  [resSelect, fpsSelect, qualitySelect].forEach(enhanceSelect);
  setUIRecordingState(false);
})();


