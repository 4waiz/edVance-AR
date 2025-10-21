// EDGE 3D QR Scanner — educational interactive overlays + improved persistence logic
// - Models are now educational (molecule, solar system, heart, bridge)
// - Interactivity: tap/click to cycle colors or toggle animations
// - Persistence: models remain visible for 6 seconds after QR disappears, but switch immediately on a new QR

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

  /* ---------- A-Frame component: toggle-anim (start/stop an animation by id) ---------- */
  if (window.AFRAME && !AFRAME.components['toggle-anim']) {
    AFRAME.registerComponent('toggle-anim', {
      schema: { anim: { default: '' } },
      init: function () {
        this.on = true;
        this.onClick = () => {
          this.on = !this.on;
          const id = this.data.anim;
          if (!id) return;
          const target = this.el;
          const attr = `animation__${id}`;
          const exists = target.getAttribute(attr);
          if (exists != null) {
            if (this.on) target.emit(`${id}-start`);
            else target.emit(`${id}-stop`);
          }
          // Fallback: pause/resume generic animation component
          const anims = target.components['animation'];
          if (anims && anims.animation) {
            if (this.on) anims.animation.resume();
            else anims.animation.pause();
          }
        };
        this.el.addEventListener('click', this.onClick);
      },
      remove: function () { this.el.removeEventListener('click', this.onClick); }
    });
  }

  // Tuning
  const LOST_TIMEOUT_MS = 6000; // keep overlay for 6s after QR disappears
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

  // Overlay definitions with descriptions (educational)
  const overlays = {
    'ID-1': { mode: 'molecule', name: 'Water Molecule (H₂O)', desc: 'Atomic structure: 2×H bound to O (~104.5° angle). Tap to cycle colors.' },
    'ID-2': { mode: 'solar',    name: 'Mini Solar System',    desc: 'Sun + planets with orbital motion. Tap to change planet colors.' },
    'ID-3': { mode: 'heart',    name: 'Pulsing Heart',        desc: 'Simplified anatomy with heartbeat animation. Tap to pause/resume.' },
    'ID-4': { mode: 'bridge',   name: 'Truss Bridge',         desc: 'Basic truss showing members. Tap to recolor members.' }
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

    // WATER MOLECULE (H2O) — O in center, two H at ~104.5°
    if (def.mode === 'molecule') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -2.7">
          <!-- Oxygen -->
          <a-sphere radius="0.42" class="clickable color-part"
                    material="color: #ef5350; metalness: 0.1; roughness: 0.8"
                    color-cycle="selector: .color-part; colors: #ef5350, #42a5f5, #66bb6a, #fdd835">
          </a-sphere>
          <!-- Hydrogens -->
          <a-sphere radius="0.28" position="0.75 0.15 -0.05" class="clickable color-part"
                    material="color: #f5f5f5; metalness:0.05; roughness:0.9"></a-sphere>
          <a-sphere radius="0.28" position="-0.75 0.15 -0.05" class="clickable color-part"
                    material="color: #f5f5f5; metalness:0.05; roughness:0.9"></a-sphere>
          <!-- Bonds -->
          <a-cylinder radius="0.04" height="0.85" position="0.36 0.07 -0.03" rotation="0 0 -25" color="#b0bec5"></a-cylinder>
          <a-cylinder radius="0.04" height="0.85" position="-0.36 0.07 -0.03" rotation="0 0 25" color="#b0bec5"></a-cylinder>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }

    // MINI SOLAR SYSTEM — simple orbits
    if (def.mode === 'solar') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -3">
          <!-- Sun -->
          <a-sphere radius="0.45" material="color: #ffca28; emissive: #ffb300; emissiveIntensity: 0.6"
                    animation="property: rotation; to: 0 360 0; loop: true; dur: 14000; easing: linear"></a-sphere>
          <!-- Planet 1 -->
          <a-entity animation="property: rotation; to: 0 360 0; loop: true; dur: 6000; easing: linear">
            <a-sphere radius="0.12" position="0.9 0 0" class="clickable color-part"
                      material="color: #90caf9"></a-sphere>
          </a-entity>
          <!-- Planet 2 -->
          <a-entity animation="property: rotation; to: 0 -360 0; loop: true; dur: 10000; easing: linear">
            <a-sphere radius="0.16" position="1.4 0 0" class="clickable color-part"
                      material="color: #81c784"></a-sphere>
          </a-entity>
          <!-- Planet 3 -->
          <a-entity animation="property: rotation; to: 0 360 0; loop: true; dur: 16000; easing: linear">
            <a-sphere radius="0.2" position="2 0 0" class="clickable color-part"
                      material="color: #ce93d8"></a-sphere>
          </a-entity>
          <!-- Make all planets color-cycle -->
          <a-entity color-cycle="selector: .color-part; colors: #90caf9, #81c784, #ffab91, #fff176" class="clickable"></a-entity>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }

    // PULSING HEART — simplified ellipsoid with heartbeat
    if (def.mode === 'heart') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -2.6">
          <a-sphere radius="0.55" scale="1 1.2 1" class="clickable"
                    material="color: #e53935; metalness:0.05; roughness:0.9"
                    animation__pulse="property: scale; to: 1.05 1.26 1.05; dir: alternate; loop: true; dur: 800; startEvents: pulse-start; pauseEvents: pulse-stop"
                    toggle-anim="anim: pulse">
          </a-sphere>
          <!-- A small aorta-ish tube -->
          <a-cylinder position="0 0.8 0.1" radius="0.08" height="0.35" rotation="20 0 0" color="#b71c1c"></a-cylinder>
        </a-entity>
      `);
      forceTransparent(); setCaption(def.name, def.desc); return;
    }

    // TRUSS BRIDGE — simple Pratt-like truss
    if (def.mode === 'bridge') {
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 ${y} -3" class="clickable"
                  color-cycle="selector: .member; colors: #90a4ae, #ef5350, #42a5f5, #66bb6a">
          <!-- Deck -->
          <a-box class="member" width="3" height="0.08" depth="0.5" position="0 -0.6 0" material="color: #90a4ae"></a-box>
          <!-- Top chord -->
          <a-box class="member" width="3" height="0.06" depth="0.3" position="0 0.6 0" material="color: #90a4ae"></a-box>
          <!-- Vertical + diagonal members -->
          <a-box class="member" width="0.06" height="1.2" depth="0.3" position="-1 0 0" material="color: #90a4ae"></a-box>
          <a-box class="member" width="0.06" height="1.2" depth="0.3" position="-0.5 0 0" material="color: #90a4ae"></a-box>
          <a-box class="member" width="0.06" height="1.2" depth="0.3" position="0 0 0" material="color: #90a4ae"></a-box>
          <a-box class="member" width="0.06" height="1.2" depth="0.3" position="0.5 0 0" material="color: #90a4ae"></a-box>
          <a-box class="member" width="0.06" height="1.2" depth="0.3" position="1 0 0" material="color: #90a4ae"></a-box>
          <!-- Diagonals -->
          <a-cylinder class="member" radius="0.03" height="1.2" position="-0.75 0 0" rotation="0 0 35" material="color: #90a4ae"></a-cylinder>
          <a-cylinder class="member" radius="0.03" height="1.2" position="-0.25 0 0" rotation="0 0 -35" material="color: #90a4ae"></a-cylinder>
          <a-cylinder class="member" radius="0.03" height="1.2" position="0.25 0 0" rotation="0 0 35" material="color: #90a4ae"></a-cylinder>
          <a-cylinder class="member" radius="0.03" height="1.2" position="0.75 0 0" rotation="0 0 -35" material="color: #90a4ae"></a-cylinder>
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
      // If a different QR appears, switch immediately
      if (text !== activeId) { activeId = text; handleRecognizedText(text); }
      lastSeenAt = now;
    } else if (activeId && (now - lastSeenAt) > LOST_TIMEOUT_MS) {
      // Clear only after 6s of being lost
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
