(() => {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'home';
  const room = (params.get('room') || 'main').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'main';
  const savedSplitRatio = Number(window.localStorage.getItem('resonance-split-ratio'));
  const state = {
    active: false,
    text: '',
    previous: '',
    partial: false,
    connected: false,
    fontSize: 64,
    asrSocket: null,
    channel: 'BroadcastChannel' in window ? new BroadcastChannel(`voice-caption-${room}`) : null,
    pdfRenderId: 0,
    presentationRenderId: 0,
    pdfDocument: null,
    currentPage: 1,
    presentationMode: false,
    transcript: [],
    demoTimer: null,
    signalPulseTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    splitRatio: Number.isFinite(savedSplitRatio) ? Math.min(75, Math.max(25, savedSplitRatio)) : 50,
    asrCommitted: [],
    asrSnapshot: '',
    audioQueue: [],
    audioQueueBytes: 0,
    audioFlushTimer: null,
    audioDeviceBound: false,
    inputSwitching: false,
    inputResumeSnapshot: null,
  };

  const $ = (id) => document.getElementById(id);
  const isHome = mode === 'home';
  const isSubtitle = mode === 'subtitle';
  const isSplit = mode === 'split';

  function getRecordButton() {
    return $(isSplit ? 'splitRecordButton' : 'subtitleRecordButton');
  }

  function getStatusTarget() {
    return $(isSplit ? 'splitStatus' : 'subtitleStatus');
  }

  function wsUrl(path) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${path}`;
  }

  function navigate(nextMode) {
    const nextUrl = nextMode === 'home' ? '/' : `/?mode=${nextMode}&room=${encodeURIComponent(room)}`;
    window.location.href = nextUrl;
  }

  function publishCaption() {
    const payload = {
      type: 'caption',
      text: state.text,
      previous: state.previous,
      transcript: state.transcript,
      active: state.active,
      partial: state.partial,
    };
    if (state.channel) state.channel.postMessage(payload);
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
  }

  function appendTranscriptLine(value) {
    const line = String(value || '').trim();
    if (!line || state.transcript[state.transcript.length - 1] === line) return;
    state.transcript.push(line);
    if (state.transcript.length > 200) state.transcript.shift();
  }

  function collapseRepeatedSpeechUnits(value) {
    const fillerUnits = new Set(['嗯', '呃', '啊', '唔', '哼', '这个', '那个', '就是', '然后', '所以']);
    let text = String(value || '');
    for (const filler of fillerUnits) {
      const escaped = filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`(${escaped})(?:[，,、\\s]*\\1){1,}`, 'g'), '$1');
    }
    let result = '';
    let index = 0;
    while (index < text.length) {
      let repeatedUnit = '';
      let repeatedCount = 0;
      for (let length = 1; length <= 8 && index + length <= text.length; length += 1) {
        const unit = text.slice(index, index + length);
        if (!/^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(unit)) continue;
        let count = 1;
        while (text.startsWith(unit, index + count * length)) count += 1;
        if (count >= 2 && (count >= 3 || fillerUnits.has(unit)) && count * length > repeatedCount * repeatedUnit.length) {
          repeatedUnit = unit;
          repeatedCount = count;
        }
      }
      if (repeatedUnit) {
        result += repeatedUnit;
        index += repeatedUnit.length * repeatedCount;
      } else {
        result += text[index];
        index += 1;
      }
    }
    return result;
  }

  function collapseRepeatedChunk(value) {
    let chunk = String(value || '');
    for (let round = 0; round < 3; round += 1) {
      let best = null;
      const maxLength = Math.min(32, Math.floor(chunk.length / 2));
      for (let start = 0; start <= chunk.length - 4; start += 1) {
        for (let length = maxLength; length >= 2; length -= 1) {
          if (start + length > chunk.length) continue;
          const anchor = chunk.slice(start, start + length);
          const compactAnchor = anchor.replace(/[，,、\s]/g, '');
          if (compactAnchor.length < 2) continue;
          const occurrences = [start];
          let searchFrom = start + length;
          while (occurrences.length < 6) {
            const next = chunk.indexOf(anchor, searchFrom);
            if (next < 0 || next - (occurrences[occurrences.length - 1] + length) > Math.max(12, length * 2)) break;
            occurrences.push(next);
            searchFrom = next + length;
          }
          const minimumOccurrences = compactAnchor.length <= 2 ? 3 : 2;
          if (occurrences.length < minimumOccurrences) continue;
          if (!best || length > best.length || (length === best.length && occurrences.length > best.occurrences)) {
            best = { start, last: occurrences[occurrences.length - 1], length, occurrences: occurrences.length };
          }
        }
      }
      if (!best) break;
      chunk = `${chunk.slice(0, best.start)}${chunk.slice(best.last)}`;
    }
    return chunk;
  }

  function collapseRepeatedRecognitionText(value) {
    const text = collapseRepeatedSpeechUnits(String(value || '')
      .replace(/\b([a-z])\1{2,}\b[。！？!?；;.、]*/gi, '')
      .replace(/\s+/g, ' ')
      .trim());
    if (!text) return '';
    const parts = text.split(/([。！？!?；;])/);
    let result = '';
    let chunk = '';
    parts.forEach((part) => {
      if (/^[。！？!?；;]$/.test(part)) {
        result += collapseRepeatedChunk(chunk) + part;
        chunk = '';
      } else {
        chunk += part;
      }
    });
    return collapseRepeatedSpeechUnits(`${result}${collapseRepeatedChunk(chunk)}`).trim();
  }

  function normalizeRecognitionLine(value) {
    return String(value || '').replace(/[。！？!?；;，,、\s]/g, '');
  }

  function findRecognitionDuplicate(lines, value) {
    const normalized = normalizeRecognitionLine(value);
    if (!normalized) return -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = normalizeRecognitionLine(lines[index]);
      if (candidate === normalized) return index;
      const shorter = Math.min(candidate.length, normalized.length);
      const longer = Math.max(candidate.length, normalized.length);
      if (shorter >= 6 && shorter / longer >= .8 && (candidate.startsWith(normalized) || normalized.startsWith(candidate))) return index;
    }
    return -1;
  }

  function mergeRecognitionLine(lines, value) {
    const line = collapseRepeatedRecognitionText(value);
    if (!line) return;
    const duplicateIndex = findRecognitionDuplicate(lines, line);
    if (duplicateIndex >= 0) {
      if (line.length >= lines[duplicateIndex].length) lines[duplicateIndex] = line;
      return;
    }
    lines.push(line);
    if (lines.length > 200) lines.shift();
  }

  function appendCommittedRecognitionLine(value) {
    mergeRecognitionLine(state.asrCommitted, value);
  }

  function commonPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index += 1;
    return index;
  }

  function splitRecognitionSnapshot(value) {
    const completeLines = value.match(/[^。！？!?；;]+[。！？!?；;]+/g) || [];
    const consumed = completeLines.reduce((length, line) => length + line.length, 0);
    return { completeLines, remainder: value.slice(consumed).trim() };
  }

  function updateRecognitionText(value, isFinal = false) {
    const incoming = collapseRepeatedRecognitionText(value);
    if (!incoming) return;
    const previousSnapshot = state.asrSnapshot;
    let snapshot = incoming;
    if (previousSnapshot) {
      if (incoming.startsWith(previousSnapshot)) {
        snapshot = incoming;
      } else if (previousSnapshot.startsWith(incoming)) {
        snapshot = previousSnapshot;
      } else {
        const sharedPrefix = commonPrefixLength(previousSnapshot, incoming);
        const revisionThreshold = Math.min(8, Math.max(3, Math.floor(Math.min(previousSnapshot.length, incoming.length) * 0.5)));
        if (sharedPrefix >= revisionThreshold || /[。！？!?；;]\s*$/.test(previousSnapshot)) {
          if (sharedPrefix < revisionThreshold) {
            splitRecognitionSnapshot(previousSnapshot).completeLines.forEach(appendCommittedRecognitionLine);
            const previousRemainder = splitRecognitionSnapshot(previousSnapshot).remainder;
            appendCommittedRecognitionLine(previousRemainder);
          }
          snapshot = incoming;
        } else {
          snapshot = `${previousSnapshot}${incoming}`;
        }
      }
    }
    state.asrSnapshot = snapshot;
    const { completeLines, remainder } = splitRecognitionSnapshot(snapshot);
    if (isFinal) {
      completeLines.forEach(appendCommittedRecognitionLine);
      appendCommittedRecognitionLine(remainder);
      state.asrSnapshot = '';
      state.transcript = state.asrCommitted.slice(-200);
      state.text = '';
      state.previous = state.transcript[state.transcript.length - 1] || '';
      state.partial = false;
      return;
    }
    const visibleLines = [...state.asrCommitted];
    completeLines.forEach((line) => mergeRecognitionLine(visibleLines, line));
    state.transcript = visibleLines.slice(-200);
    state.text = remainder || (completeLines.length ? '' : snapshot);
    state.previous = state.transcript[state.transcript.length - 1] || '';
    state.partial = Boolean(state.text);
  }

  function scrollTranscriptByPageIfNeeded() {
    const transcript = $('splitTranscript');
    const end = $('splitTranscriptEnd');
    if (!transcript || !end || transcript.clientHeight === 0) return;
    const transcriptRect = transcript.getBoundingClientRect();
    const endRect = end.getBoundingClientRect();
    if (endRect.bottom <= transcriptRect.bottom - 12) return;
    transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight;
  }

  function scrollLiveTranscript() {
    const transcript = $('liveTranscript');
    const end = $('liveTranscriptEnd');
    if (!transcript || !end || transcript.clientHeight === 0) return;
    const transcriptRect = transcript.getBoundingClientRect();
    const endRect = end.getBoundingClientRect();
    if (endRect.bottom <= transcriptRect.bottom - 12) return;
    transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight;
  }

  function setCaption(payload) {
    if (Array.isArray(payload.transcript)) {
      const incomingLines = [];
      payload.transcript.forEach((line) => mergeRecognitionLine(incomingLines, line));
      state.transcript = incomingLines.slice(-200);
    } else {
      appendTranscriptLine(payload.previous);
    }
    state.text = collapseRepeatedRecognitionText(payload.text || '');
    state.previous = String(payload.previous || '');
    state.active = payload.active === true;
    state.partial = payload.partial === true;
    render();
  }

  function connectCaption(role) {
    return fetch('/api/config').then((response) => response.json()).then((config) => new Promise((resolve) => {
      const socket = new WebSocket(wsUrl(`/caption?room=${encodeURIComponent(room)}`));
      state.ws = socket;
      state.ws = socket;
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'join', role, room, token: config.gatewayToken || '' })));
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (message.type === 'ready') {
          state.connected = true;
          render();
          resolve(config);
        }
        if (message.type === 'caption') setCaption(message);
        if (message.type === 'error') resolve(config);
      });
      socket.addEventListener('close', () => {
        state.connected = false;
        render();
      });
      socket.addEventListener('error', () => resolve(config));
    }));
  }

  function renderSubtitle() {
    $('subtitleView').classList.toggle('is-live', state.active);
    $('subtitleView').classList.toggle('signal-live', state.active);
    $('liveTranscriptHistory').textContent = state.transcript.join('\n');
    $('liveText').textContent = state.text || (state.transcript.length ? '' : '等待实时字幕…');
    $('liveText').classList.toggle('empty', !state.text && !state.transcript.length);
    $('liveText').style.fontSize = `${state.fontSize}px`;
    $('liveTranscriptHistory').style.fontSize = `${state.fontSize}px`;
    scrollLiveTranscript();
    $('subtitleStatusDot').classList.toggle('live', state.active);
    $('subtitleStatus').textContent = state.active ? (state.partial ? '正在识别演讲' : '字幕已更新') : (state.connected ? '已连接，等待演讲开始' : '字幕服务未连接');
    $('subtitleRoom').textContent = room.toUpperCase();
    $('subtitleRecordButton').classList.toggle('active', state.active);
    $('subtitleRecordLabel').textContent = state.active ? '停止识别' : '开始识别';
    $('fontSlider').value = state.fontSize;
    $('fontSizeValue').textContent = `${state.fontSize}px`;
    animateCaption('liveText');
  }

  function renderSplit() {
    $('splitView').classList.toggle('is-live', state.active);
    $('splitView').classList.toggle('signal-live', state.active);
    $('splitTranscriptHistory').textContent = state.transcript.join('\n');
    $('splitText').textContent = state.text || (state.transcript.length ? '' : '等待实时字幕…');
    $('splitText').classList.toggle('empty', !state.text && !state.transcript.length);
    $('splitTranscriptHistory').style.fontSize = `${state.fontSize}px`;
    $('splitText').style.fontSize = `${state.fontSize}px`;
    scrollTranscriptByPageIfNeeded();
    $('splitStatus').textContent = state.active ? '现场转译中' : (state.text ? '本段已完成' : (state.connected ? '已连接，等待字幕' : '等待现场连接'));
    $('splitRecordButton').classList.toggle('active', state.active);
    $('splitRecordLabel').textContent = state.active ? '停止识别' : '开始识别';
    $('splitFontSlider').value = state.fontSize;
    $('splitFontSizeValue').textContent = `${state.fontSize}px`;
    $('splitClock').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    renderSplitLayout();
    const presentationButton = $('splitPresentationButton');
    presentationButton.disabled = !state.pdfDocument;
    presentationButton.textContent = state.presentationMode ? '退出演讲' : '开始演讲';
    $('pptPageIndicator').textContent = state.pdfDocument ? `${state.currentPage} / ${state.pdfDocument.numPages}` : '1 / 1';
    $('pptPreviousButton').disabled = !state.presentationMode || state.currentPage <= 1;
    $('pptNextButton').disabled = !state.presentationMode || !state.pdfDocument || state.currentPage >= state.pdfDocument.numPages;
    animateCaption('splitText');
  }

  function animateCaption(id) {
    const node = $(id);
    if (!node) return;
    const value = node.textContent;
    if (node.dataset.captionValue === value) return;
    const hasPreviousValue = node.dataset.captionValue !== undefined;
    node.dataset.captionValue = value;
    node.classList.remove('caption-updated');
    window.requestAnimationFrame(() => node.classList.add('caption-updated'));
    if (hasPreviousValue) pulseSignal();
  }

  function pulseSignal() {
    const visualizers = document.querySelectorAll('.signal-visualizer');
    visualizers.forEach((node) => {
      node.classList.remove('signal-pulse');
      void node.offsetWidth;
      node.classList.add('signal-pulse');
    });
    window.clearTimeout(state.signalPulseTimer);
    state.signalPulseTimer = window.setTimeout(() => {
      visualizers.forEach((node) => node.classList.remove('signal-pulse'));
    }, 560);
  }

  function renderSplitLayout() {
    const grid = $('splitGrid');
    if (!grid) return;
    grid.style.setProperty('--ppt-ratio', `${state.splitRatio}fr`);
    grid.style.setProperty('--caption-ratio', `${100 - state.splitRatio}fr`);
    const divider = $('splitDivider');
    divider?.setAttribute('aria-valuenow', String(state.splitRatio));
    divider?.setAttribute('aria-valuetext', `PPT ${state.splitRatio}%，字幕 ${100 - state.splitRatio}%`);
  }

  function setSplitRatio(value) {
    state.splitRatio = Math.min(75, Math.max(25, Math.round(value)));
    window.localStorage.setItem('resonance-split-ratio', String(state.splitRatio));
    renderSplitLayout();
  }

  function updateSplitRatioFromPointer(clientX) {
    const rect = $('splitGrid').getBoundingClientRect();
    const usableWidth = rect.width - 32;
    setSplitRatio(((clientX - rect.left) / usableWidth) * 100);
  }

  function initSplitResizer() {
    const divider = $('splitDivider');
    let dragging = false;
    divider.addEventListener('pointerdown', (event) => {
      dragging = true;
      divider.setPointerCapture?.(event.pointerId);
      $('splitView').classList.add('is-resizing');
      updateSplitRatioFromPointer(event.clientX);
    });
    divider.addEventListener('pointermove', (event) => {
      if (dragging) updateSplitRatioFromPointer(event.clientX);
    });
    const stopDragging = () => {
      dragging = false;
      $('splitView').classList.remove('is-resizing');
    };
    divider.addEventListener('pointerup', stopDragging);
    divider.addEventListener('pointercancel', stopDragging);
    divider.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); setSplitRatio(state.splitRatio - 2); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setSplitRatio(state.splitRatio + 2); }
    });
    renderSplitLayout();
  }

  function render() {
    if (isSubtitle) renderSubtitle();
    if (isSplit) renderSplit();
  }

  function downsample(buffer, inputRate, outputRate) {
    if (inputRate === outputRate) return buffer;
    const ratio = inputRate / outputRate;
    const length = Math.round(buffer.length / ratio);
    const result = new Float32Array(length);
    let offset = 0;
    for (let index = 0; index < length; index += 1) {
      const nextOffset = Math.round((index + 1) * ratio);
      let total = 0;
      let count = 0;
      for (let cursor = offset; cursor < nextOffset && cursor < buffer.length; cursor += 1) { total += buffer[cursor]; count += 1; }
      result[index] = count ? total / count : 0;
      offset = nextOffset;
    }
    return result;
  }

  function toPcm16(floatBuffer) {
    const output = new Int16Array(floatBuffer.length);
    for (let index = 0; index < floatBuffer.length; index += 1) {
      const value = Math.max(-1, Math.min(1, floatBuffer[index]));
      output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return output;
  }

  function flushAudioQueue() {
    const socket = state.asrSocket;
    if (!state.active || !socket || socket.readyState !== WebSocket.OPEN) return;
    while (state.audioQueue.length && socket.bufferedAmount < 512 * 1024) {
      const chunk = state.audioQueue.shift();
      state.audioQueueBytes -= chunk.byteLength;
      socket.send(chunk);
    }
    if (state.audioQueue.length && !state.audioFlushTimer) {
      state.audioFlushTimer = window.setTimeout(() => {
        state.audioFlushTimer = null;
        flushAudioQueue();
      }, 20);
    }
  }

  function enqueueAudioChunk(chunk) {
    state.audioQueue.push(chunk);
    state.audioQueueBytes += chunk.byteLength;
    if (state.audioQueueBytes > 4 * 1024 * 1024) {
      stopMicrophone('识别网络拥堵，已停止以避免继续丢失音频');
      return;
    }
    flushAudioQueue();
  }

  function startElapsed() {
    const started = Date.now();
    state.elapsedTimer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      const target = getStatusTarget();
      if (target && state.active) target.dataset.elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }, 500);
  }

  function stopElapsed() {
    window.clearInterval(state.elapsedTimer);
  }

  async function startMicrophone() {
    if (state.active) { stopMicrophone(); return; }
    const recordButton = getRecordButton();
    const statusTarget = getStatusTarget();
    if (!navigator.mediaDevices?.getUserMedia) {
      if (statusTarget) statusTarget.textContent = '当前浏览器不支持麦克风识别';
      return;
    }
    recordButton.disabled = true;
    try {
      const config = await fetch('/api/config').then((response) => response.json());
      if (!config.liveAsrConfigured) throw new Error('服务器尚未配置实时识别服务');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { ideal: 'default' }, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      state.stream = stream;
      state.reconnectAttempts = 0;
      openAsrSocket(stream, config.gatewayToken || '');
    } catch (error) {
      if (statusTarget) statusTarget.textContent = error.message;
      recordButton.disabled = false;
    }
  }

  function bindAudioDeviceChanges() {
    if (state.audioDeviceBound || !navigator.mediaDevices?.addEventListener) return;
    state.audioDeviceBound = true;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!state.active || state.inputSwitching) return;
      state.inputSwitching = true;
      state.inputResumeSnapshot = {
        text: state.text,
        previous: state.previous,
        partial: state.partial,
        transcript: state.transcript.slice(),
        asrCommitted: state.asrCommitted.slice(),
        asrSnapshot: state.asrSnapshot,
      };
      stopMicrophone('正在自动切换到系统默认麦克风');
      startMicrophone().finally(() => {
        state.inputSwitching = false;
      });
    });
  }

  function scheduleAsrReconnect(reason, token) {
    if (!state.active || !state.stream || state.reconnectTimer) return;
    if (state.reconnectAttempts >= 2) {
      stopMicrophone(`${reason}，自动重连已失败，请检查网络或服务额度`);
      return;
    }
    state.reconnectAttempts += 1;
    const delay = state.reconnectAttempts * 800;
    const statusTarget = getStatusTarget();
    if (statusTarget) statusTarget.textContent = `${reason}，正在重连（${state.reconnectAttempts}/2）`;
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      if (state.active && state.stream) openAsrSocket(state.stream, token);
    }, delay);
  }

  function openAsrSocket(stream, token) {
    const socket = new WebSocket(wsUrl('/asr'));
    state.asrSocket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'start', token })));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message.type === 'ready') {
        if (!state.audioProcessor) setupAudio(stream);
        else { state.reconnectAttempts = 0; flushAudioQueue(); render(); publishCaption(); }
      }
      if (message.type === 'partial' || message.type === 'final') {
        updateRecognitionText(message.text, message.type === 'final');
        render();
        publishCaption();
      }
      if (message.type === 'error') {
        const code = message.code ? `（错误码 ${message.code}）` : '';
        stopMicrophone(`识别服务错误${code}：${message.message || '未知错误'}`);
      }
      if (message.type === 'closed') scheduleAsrReconnect('识别连接已断开', token);
    });
    socket.addEventListener('error', () => scheduleAsrReconnect('识别网络异常', token));
    socket.addEventListener('close', () => {
      if (state.active && socket === state.asrSocket) scheduleAsrReconnect('识别连接已关闭', token);
    });
  }

  function setupAudio(stream) {
    const resumeSnapshot = state.inputResumeSnapshot;
    state.inputResumeSnapshot = null;
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioContext.createMediaStreamSource(stream);
    const processor = state.audioContext.createScriptProcessor(2048, 1, 1);
    const mute = state.audioContext.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!state.active) return;
      const input = event.inputBuffer.getChannelData(0);
      enqueueAudioChunk(toPcm16(downsample(input, state.audioContext.sampleRate, 16000)).buffer);
    };
    source.connect(processor); processor.connect(mute); mute.connect(state.audioContext.destination);
    state.audioSource = source; state.audioProcessor = processor; state.audioMute = mute;
    state.active = true; state.text = ''; state.previous = ''; state.transcript = []; state.asrCommitted = []; state.asrSnapshot = ''; state.partial = true;
    if (resumeSnapshot) {
      state.text = resumeSnapshot.text;
      state.previous = resumeSnapshot.previous;
      state.partial = resumeSnapshot.partial;
      state.transcript = resumeSnapshot.transcript;
      state.asrCommitted = resumeSnapshot.asrCommitted;
      state.asrSnapshot = resumeSnapshot.asrSnapshot;
    }
    startElapsed(); render(); publishCaption();
    const recordButton = getRecordButton();
    recordButton.disabled = false;
  }

  function stopMicrophone(message) {
    stopDemo();
    if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    if (state.asrSnapshot || state.text) updateRecognitionText(state.asrSnapshot || state.text, true);
    if (state.asrSocket?.readyState === WebSocket.OPEN) state.asrSocket.send(JSON.stringify({ type: 'stop' }));
    state.asrSocket?.close();
    state.stream?.getTracks().forEach((track) => track.stop());
    state.audioProcessor?.disconnect(); state.audioSource?.disconnect(); state.audioMute?.disconnect(); state.audioContext?.close();
    if (state.audioFlushTimer) window.clearTimeout(state.audioFlushTimer);
    state.audioFlushTimer = null; state.audioQueue = []; state.audioQueueBytes = 0;
    state.asrSocket = null; state.stream = null; state.audioContext = null; state.audioProcessor = null; state.audioSource = null; state.audioMute = null; state.active = false; state.partial = false; state.reconnectAttempts = 0;
    stopElapsed();
    const recordButton = getRecordButton();
    if (recordButton) recordButton.disabled = false;
    const statusTarget = getStatusTarget();
    if (statusTarget) statusTarget.textContent = message || '已停止识别';
    render(); publishCaption();
  }

  function stopDemo() {
    if (state.demoTimer) window.clearInterval(state.demoTimer);
    state.demoTimer = null;
  }

  function openDemoDialog() {
    const dialog = $('demoDialog');
    const input = $('demoInput');
    if (!dialog || !input) return;
    input.value = input.value.trim() || '大家好，今天我想和大家分享一个关于勇气的故事。';
    dialog.hidden = false;
    dialog.classList.add('visible');
    window.setTimeout(() => input.focus(), 0);
  }

  function closeDemoDialog() {
    const dialog = $('demoDialog');
    if (!dialog) return;
    dialog.classList.remove('visible');
    dialog.hidden = true;
  }

  function startDemo(input) {
    const value = String(input || '').trim();
    if (!value) {
      $('demoInput')?.focus();
      return;
    }
    closeDemoDialog();
    stopDemo();
    const chunks = value.match(/[^，。！？；,.!?;]+[，。！？；,.!?;]?/g) || [value];
    let chunkIndex = 0; let charIndex = 0;
    state.active = true; state.previous = ''; state.text = ''; state.transcript = []; state.asrCommitted = []; state.asrSnapshot = ''; state.partial = true; render(); publishCaption();
    state.demoTimer = window.setInterval(() => {
      const chunk = chunks[chunkIndex] || '';
      charIndex = Math.min(charIndex + 1, chunk.length);
      state.text = chunk.slice(0, charIndex); state.partial = charIndex < chunk.length; render(); publishCaption();
      if (charIndex >= chunk.length) {
        appendTranscriptLine(chunk);
        chunkIndex += 1; charIndex = 0;
        state.text = '';
        if (chunkIndex >= chunks.length) { stopDemo(); state.active = false; state.partial = false; }
        state.previous = chunk;
        render(); publishCaption();
      }
    }, 115);
  }

  function runDemo() {
    if (state.active) stopMicrophone();
    openDemoDialog();
  }

  function changeFont(delta) {
    state.fontSize = Math.min(96, Math.max(16, state.fontSize + delta));
    render();
  }

  function loadPptUrl() {
    const value = $('pptUrlInput').value.trim();
    if (!value) return;
    $('pptHint').textContent = '正在载入演示文稿…';
    state.pdfDocument = null;
    state.presentationMode = false;
    $('pptPane').classList.remove('presentation-mode');
    $('pptStage').hidden = true;
    $('pptViewer').hidden = true;
    $('pptFrame').src = value;
    $('pptFrame').hidden = false;
    $('pptEmpty').hidden = true;
    renderSplit();
  }

  async function loadPdf(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      $('pptHint').textContent = '请选择 PDF 文件（.pdf），PPTX 请先导出为 PDF';
      return;
    }
    const renderId = state.pdfRenderId + 1;
    state.pdfRenderId = renderId;
    state.pdfDocument = null;
    state.presentationMode = false;
    $('pptPane').classList.remove('presentation-mode');
    $('pptStage').hidden = true;
    $('pptHint').textContent = `${file.name || 'PDF 文件'} 已载入，正在显示预览…`;
    $('pptEmpty').hidden = true;
    $('pptFrame').hidden = true;
    $('pptViewer').hidden = false;
    $('pptPages').replaceChildren();
    try {
      const pdfjsLib = await import('/vendor/pdfjs/pdf.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      if (renderId !== state.pdfRenderId) return;
      state.pdfDocument = pdf;
      state.currentPage = 1;
      renderSplit();
      const pages = $('pptPages');
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.4, Math.max(.2, (pages.clientWidth - 4) / baseViewport.width));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.className = 'ppt-page';
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        pages.append(canvas);
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null,
        }).promise;
      }
      $('pptHint').textContent = `${file.name || 'PDF 文件'} 已载入，共 ${pdf.numPages} 页`;
    } catch (error) {
      console.error('[pdf-preview] failed to render PDF', error);
      if (renderId !== state.pdfRenderId) return;
      $('pptViewer').hidden = true;
      $('pptEmpty').hidden = false;
      $('pptPane').classList.remove('presentation-mode');
      $('pptHint').textContent = 'PDF 打开失败，请确认文件未损坏后重试';
      state.pdfDocument = null;
      renderSplit();
    }
  }

  async function renderPresentationPage(pageNumber) {
    if (!state.pdfDocument) return;
    const renderId = state.presentationRenderId + 1;
    state.presentationRenderId = renderId;
    const page = await state.pdfDocument.getPage(pageNumber);
    if (!state.presentationMode || renderId !== state.presentationRenderId) return;
    const stage = $('pptStage');
    const canvas = $('pptStageCanvas');
    const baseViewport = page.getViewport({ scale: 1 });
    const maxWidth = Math.max(160, stage.clientWidth - 44);
    const maxHeight = Math.max(120, stage.clientHeight - 86);
    const scale = Math.min(1.6, maxWidth / baseViewport.width, maxHeight / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(viewport.width * pixelRatio);
    canvas.height = Math.ceil(viewport.height * pixelRatio);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null,
    }).promise;
    if (renderId === state.presentationRenderId) renderSplit();
  }

  function startPresentation() {
    if (!state.pdfDocument) return;
    state.presentationMode = true;
    state.currentPage = 1;
    $('pptPane').classList.add('presentation-mode');
    $('pptEmpty').hidden = true;
    $('pptViewer').hidden = true;
    $('pptFrame').hidden = true;
    $('pptStage').hidden = false;
    renderSplit();
    renderPresentationPage(state.currentPage);
  }

  function exitPresentation() {
    state.presentationMode = false;
    $('pptStage').hidden = true;
    $('pptViewer').hidden = false;
    $('pptPane').classList.remove('presentation-mode');
    renderSplit();
  }

  function changePresentationPage(delta) {
    if (!state.presentationMode || !state.pdfDocument) return;
    const nextPage = Math.min(state.pdfDocument.numPages, Math.max(1, state.currentPage + delta));
    if (nextPage === state.currentPage) return;
    state.currentPage = nextPage;
    renderSplit();
    renderPresentationPage(state.currentPage);
  }

  function initHome() {
    $('homeSubtitleButton').addEventListener('click', () => navigate('subtitle'));
    $('heroSubtitleButton').addEventListener('click', () => navigate('subtitle'));
    $('heroSplitButton').addEventListener('click', () => navigate('split'));
  }

  function initDemoDialog() {
    $('demoConfirmButton').addEventListener('click', () => startDemo($('demoInput').value));
    $('demoCancelButton').addEventListener('click', closeDemoDialog);
    $('demoCancelButtonSecondary').addEventListener('click', closeDemoDialog);
    $('demoDialog').addEventListener('click', (event) => {
      if (event.target.dataset.demoCancel === 'true') closeDemoDialog();
    });
    $('demoInput').addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startDemo(event.currentTarget.value);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('demoDialog').hidden) closeDemoDialog();
    });
  }

  function initSubtitle() {
    $('homeView').style.display = 'none';
    $('subtitleView').classList.add('active');
    if (state.channel) state.channel.addEventListener('message', (event) => setCaption(event.data));
    connectCaption('control');
    bindAudioDeviceChanges();
    $('subtitleRecordButton').addEventListener('click', startMicrophone);
    $('subtitleDemoButton').addEventListener('click', runDemo);
    $('subtitleClearButton').addEventListener('click', () => { if (state.active) stopMicrophone(); state.text = ''; state.previous = ''; state.transcript = []; state.asrCommitted = []; state.asrSnapshot = ''; render(); publishCaption(); });
    $('subtitleSplitButton').addEventListener('click', () => window.open(`/?mode=split&room=${encodeURIComponent(room)}`, '_blank', 'noopener,noreferrer'));
    $('fontDown').addEventListener('click', () => changeFont(-4));
    $('fontUp').addEventListener('click', () => changeFont(4));
    $('fontSlider').addEventListener('input', (event) => { state.fontSize = Number(event.target.value); render(); });
    render();
  }

  function initSplit() {
    $('homeView').style.display = 'none';
    $('splitView').classList.add('active');
    if (state.channel) state.channel.addEventListener('message', (event) => setCaption(event.data));
    connectCaption('stage');
    bindAudioDeviceChanges();
    $('splitFullscreenButton').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen?.();
        else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
        else throw new Error('fullscreen-unavailable');
      } catch (error) {
        $('splitStatus').textContent = '当前浏览器暂不允许全屏，请使用浏览器菜单进入全屏';
      }
    });
    $('splitRecordButton').addEventListener('click', startMicrophone);
    $('splitDemoButton').addEventListener('click', runDemo);
    $('splitClearButton').addEventListener('click', () => { if (state.active) stopMicrophone(); state.text = ''; state.previous = ''; state.transcript = []; state.asrCommitted = []; state.asrSnapshot = ''; render(); publishCaption(); });
    $('splitFontDown').addEventListener('click', () => changeFont(-4));
    $('splitFontUp').addEventListener('click', () => changeFont(4));
    $('splitFontSlider').addEventListener('input', (event) => { state.fontSize = Number(event.target.value); render(); });
    $('splitPresentationButton').addEventListener('click', () => { if (state.presentationMode) exitPresentation(); else startPresentation(); });
    $('pptPreviousButton').addEventListener('click', () => changePresentationPage(-1));
    $('pptNextButton').addEventListener('click', () => changePresentationPage(1));
    $('pptExitButton').addEventListener('click', exitPresentation);
    document.addEventListener('keydown', (event) => {
      if (!state.presentationMode) return;
      if (event.target?.closest?.('button, input, textarea, [contenteditable="true"], [role="separator"]')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') { event.preventDefault(); changePresentationPage(-1); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') { event.preventDefault(); changePresentationPage(1); }
      if (event.key === 'Escape') exitPresentation();
    });
    document.addEventListener('fullscreenchange', () => {
      $('splitFullscreenButton').textContent = document.fullscreenElement ? '退出全屏' : '全屏显示';
    });
    initSplitResizer();
    $('pptLoadButton').addEventListener('click', loadPptUrl);
    $('pptUrlInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadPptUrl(); });
    $('pptFileInput').addEventListener('change', (event) => loadPdf(event.target.files[0]));
    render();
  }

  initDemoDialog();
  if (isHome) initHome();
  if (isSubtitle) initSubtitle();
  if (isSplit) initSplit();
})();
