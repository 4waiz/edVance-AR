// EDGE 3D QR Scanner — unified desktop/mobile with transparent AR overlay
// Models + caption are lifted on phones so they don't hide behind the bottom UI.

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('video');
  const modelContainer = document.getElementById('model-container');
  const scanResultP = document.querySelector('#scan-result p');
  const scanResultDiv = document.getElementById('scan-result');
  const loader = document.getElementById('loader');
  const startBtn = document.getElementById('start-btn');
  const startLogo = document.getElementById('start-logo');
  const footer = document.querySelector('.footer');

  /* ---------- measure footer + set caption lift ---------- */
  function setFooterHeightVar() {
    const h = footer?.offsetHeight || 28;
    document.documentElement.style.setProperty('--footer-h', `${h}px`);
  }
  function setCaptionExtraVar() {
    // Add more lift on shorter screens (phones)
    const h = window.innerHeight;
    let extra = 56;            // default
    if (h < 900) extra = 64;
    if (h < 820) extra = 72;
    if (h < 740) extra = 84;
    if (h < 680) extra = 96;
    document.documentElement.style.setProperty('--caption-extra', `${extra}px`);
  }
  setFooterHeightVar();
  setCaptionExtraVar();
  window.addEventListener('resize', () => { setFooterHeightVar(); setCaptionExtraVar(); });
  window.addEventListener('orientationchange', () => { setFooterHeightVar(); setCaptionExtraVar(); });

  /* ---------- A-Frame component: color-cycle ---------- */
  if (window.AFRAME && !AFRAME.components['color-cycle']) {
    AFRAME.registerComponent('color-cycle', {
      schema: { colors: { default: '#d32f2f, #43a047, #1976d2, #fdd835' }, selector: { default: '' } },
      init: function () {
        this.palette = (this.data.colors || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!this.palette.length) this.palette = ['#ff0000', '#00ff00', '#0000ff'];
        this.idx = 0;
        this.targets = this.data.selector ? Array.from(this.el.querySelectorAll(this.data.selector)) : [this.el];
        this.onClick = () => {
          this.idx = (this.idx + 1) % this.palette.length;
          const col = this.palette[this.idx];
          this.targets.forEach(t => t.setAttribute('material', 'color', col));
        };
        this.el.addEventListener('click', this.onClick);
      },
      remove: function () { this.el.removeEventListener('click', this.onClick); }
    });
  }
  /* ---------------------------------------------------- */

  // Tuning
  const LOST_TIMEOUT_MS = 2000;
  const JSQR_TARGET_W = 480;
  const SCAN_MIN_INTERVAL = 60;

  // State
  let scanning = false;
  let activeId = null;
  let lastSeenAt = 0;
  let lastScanAt = 0;

  // Camera / detection
  let streamRef = null;
  let useBarcodeDetector = false;
  let detector = null;
  let rafId = null;
  let canvas = null, ctx = null;

  function updateStatus(message, isError = false) {
    if (scanResultP) scanResultP.textContent = message;
    if (scanResultDiv) scanResultDiv.classList.toggle('hidden', !isError);
  }

  // Overlay definitions with descriptions
  const overlays = {
    'ID-1': { mode: 'edgeRing', name: 'EDGE Ring', desc: 'A twisting ring that symbolizes innovation and continuity.' },
    'ID-2': { mode: 'ufo3d',    name: 'UFO',       desc: 'A playful flying saucer—tap it to change its color.' },
    'ID-3': { mode: 'apple3d',  name: 'Apple',     desc: "This is an apple—it's very tasty." },
    'ID-4': { mode: 'edgeCube', name: 'EDGE Cube', desc: 'A clean, rotating cube with an EDGE label.' }
  };

  // Calculate a Y-offset to push models up on short screens
  function modelY() {
    const h = window.innerHeight;
    const minH = 600, maxH = 900;     // interpolate between these
    const t = Math.max(0, Math.min(1, (maxH - h) / (maxH - minH)));
    return +(0.35 + t * 0.55).toFixed(2); // 0.35..0.90
  }

  // Scene wrapper (transparent + cursor for clicks)
  function sceneWrap(inner) {
    return `
      <a-scene
        embedded
        renderer="alpha: true; antialias: true"
        vr-mode-ui="enabled: false"
        style="background: transparent"
        cursor="rayOrigin: mouse"
        raycaster="objects: .clickable">
        ${inner}
        <a-light type="ambient" intensity="1"></a-light>
        <a-light type="directional" intensity="0.7" position="-1 1 2"></a-light>
        <a-camera wasd-controls-enabled="false" look-controls="enabled: false" position="0 0 2"></a-camera>
      </a-scene>
    `;
  }

  // Hard-force transparency (covers iOS Safari)
  function forceTransparent() {
    const sceneEl = modelContainer.querySelector('a-scene');
    if (!sceneEl) return;
    const apply = () => {
      try {
        const r = sceneEl.renderer;
        if (r) { r.setClearColor(0x000000, 0); r.setClearAlpha?.(0); }
      } catch {}
      const c = sceneEl.canvas || sceneEl?.renderer?.domElement;
      if (c) c.style.background = 'transparent';
      modelContainer.style.background = 'transparent';
    };
    if (sceneEl.hasLoaded) apply(); else sceneEl.addEventListener('loaded', apply);
    sceneEl.addEventListener('render-target-loaded', apply);
  }

  /* ---------- Caption helpers ---------- */
  function setCaption(title, description) {
    let cap = document.getElementById('model-caption');
    if (!cap) { cap = document.createElement('div'); cap.id = 'model-caption'; modelContainer.appendChild(cap); }
    cap.innerHTML = `<strong>${title}</strong><span class="desc">${description || ''}</span>`;
  }
  function clearCaption() { document.getElementById('model-caption')?.remove(); }
  /* ------------------------------------ */

  function showOverlay(def) {
    modelContainer.innerHTML = '';
    const y = modelY(); // compute per display

    if (def.mode === 'edgeRing') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -2.5" animation="property: rotation; to: 0 360 0; loop: true; dur: 12000; easing: linear">
          <a-torus-knot class="clickable" p="2" q="3" radius="0.9" radius-tubular="0.08"
                        material="color: #00d1b2; metalness: 0.4; roughness: 0.3"
                        color-cycle="colors: #00d1b2, #ff5a2e, #1976d2, #9c27b0"></a-torus-knot>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }

    if (def.mode === 'ufo3d') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -2.5">
          <a-entity class="clickable"
                    color-cycle="selector: .color-part; colors: #8e9eab, #9c27b0, #43a047, #ff7043"
                    animation="property: position; to: 0 0.2 0; dir: alternate; loop: true; dur: 1500">
            <a-cylinder height="0.18" radius="0.9" class="color-part"
                        material="color: #8e9eab; metalness:0.6; roughness:0.2"></a-cylinder>
            <a-sphere radius="0.5" position="0 0.35 0" class="color-part"
                      material="color: #cfd8dc; metalness:0.1; roughness:0.9"></a-sphere>
            <a-ring position="0 0.05 0" radius-inner="0.25" radius-outer="0.85" class="color-part"
                    material="color:#4dd0e1; opacity:0.6; transparent:true"></a-ring>
            <a-sphere radius="0.06" position="0.6 0.02 0" color="#ff5252"></a-sphere>
            <a-sphere radius="0.06" position="-0.6 0.02 0" color="#ff5252"></a-sphere>
            <a-sphere radius="0.06" position="0 0.02 0.6" color="#ff5252"></a-sphere>
            <a-sphere radius="0.06" position="0 0.02 -0.6" color="#ff5252"></a-sphere>
          </a-entity>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }

    if (def.mode === 'apple3d') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -2.5">
          <a-sphere radius="0.7" color="#fdd835" class="clickable"
                    color-cycle="colors: #fdd835, #d32f2f, #43a047, #1976d2">
            <a-animation attribute="rotation" to="0 360 0" dur="15000" repeat="indefinite" easing="linear"></a-animation>
          </a-sphere>
          <a-cylinder position="0 0.65 0.3" radius="0.05" height="0.25" color="#6d4c41"></a-cylinder>
          <a-plane position="0.12 0.8 0.3" rotation="0 0 35" width="0.35" height="0.2"
                   color="#43a047" material="side: double"></a-plane>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }

    if (def.mode === 'edgeCube') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -2.5" class="clickable"
                  color-cycle="selector: .color-part; colors: #00d1b2, #ff5a2e, #1976d2, #9c27b0">
          <a-box class="color-part" width="0.9" height="0.9" depth="0.9"
                 material="color: #00d1b2; metalness: 0.3; roughness: 0.45"
                 animation="property: rotation; to: 0 360 0; loop: true; dur: 12000; easing: linear"></a-box>
          <a-text value="EDGE" align="center" width="2" color="#ffffff" position="0 0 0.5"></a-text>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }
  }

  function clearOverlay() { modelContainer.innerHTML = ''; clearCaption(); loader.classList.add('hidden'); }

  /* ---------- Scanner setup ---------- */
  async function ensureJsQR() {
    if (window.jsQR) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
      s.onload = resolve; s.onerror = () => reject(new Error('Failed to load jsQR'));
      document.head.appendChild(s);
    });
    if (!window.jsQR) throw new Error('jsQR failed to load');
  }

  async function setupDetector() {
    useBarcodeDetector = 'BarcodeDetector' in window;
    if (useBarcodeDetector) {
      try { const f = await window.BarcodeDetector.getSupportedFormats();
        if (!f.includes('qr_code')) useBarcodeDetector = false; } catch { useBarcodeDetector = false; }
    }
    if (useBarcodeDetector) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    else await ensureJsQR();
  }

  async function requestMotionPermissionIfNeeded() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        await DeviceMotionEvent.requestPermission().catch(()=>{});
      }
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission().catch(()=>{});
      }
    } catch {}
  }

  async function startCamera() {
    const constraints = {
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    };
    streamRef = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = streamRef;
    video.setAttribute('playsinline', 'true');
    await video.play();
  }

  function stopCamera() {
    if (rafId) cancelAnimationFrame(rafId);
    if (streamRef) { streamRef.getTracks().forEach(t => t.stop()); streamRef = null; }
    scanning = false; activeId = null;
  }

  function handleRecognizedText(text) {
    const def = overlays[text];
    if (def) showOverlay(def);
    else { updateStatus(`QR "${text}" not recognized. Expect ID-1, ID-2, ID-3, or ID-4.`, true); clearOverlay(); }
  }

  function registerDetection(text) {
    const now = performance.now();
    if (text) {
      if (text !== activeId) { activeId = text; handleRecognizedText(text); }
      lastSeenAt = now;
    } else if (activeId && (now - lastSeenAt) > LOST_TIMEOUT_MS) {
      activeId = null; lastSeenAt = 0; clearOverlay();
    }
  }

  async function scanLoop() {
    if (!scanning) return;
    let detectedText = null;
    const now = performance.now();

    if (now - lastScanAt >= SCAN_MIN_INTERVAL) {
      lastScanAt = now;
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
          if (useBarcodeDetector) {
            const codes = await detector.detect(video);
            if (codes && codes.length) detectedText = codes[0].rawValue || codes[0].displayValue;
          } else {
            if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
            const vw = video.videoWidth, vh = video.videoHeight;
            const scale = JSQR_TARGET_W / Math.max(1, vw);
            canvas.width = Math.floor(vw * scale);
            canvas.height = Math.floor(vh * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(id.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) detectedText = code.data;
          }
        }
      } catch {}
    }

    registerDetection(detectedText);
    rafId = requestAnimationFrame(scanLoop);
  }

  async function startScanner() {
    try {
      if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not supported in this browser.');
      }
      await requestMotionPermissionIfNeeded();

      loader.classList.remove('hidden');
      await startCamera();
      await setupDetector();

      scanning = true;
      startBtn.style.display = 'none';
      if (startLogo) startLogo.style.display = 'none';
      scanLoop();
    } catch (err) {
      const msg =
        err?.name === 'NotAllowedError' ? 'Camera access denied. Enable camera permissions and retry.' :
        err?.name === 'NotFoundError'   ? 'No camera found on this device.' :
        (location.protocol !== 'https:' && location.hostname !== 'localhost')
          ? 'This must be served over HTTPS or localhost for camera access.'
          : `Could not start camera: ${err?.message || err}`;
      updateStatus(msg, true);
    } finally { loader.classList.add('hidden'); }
  }

  startBtn.addEventListener('click', startScanner);
  window.addEventListener('beforeunload', stopCamera);
});
