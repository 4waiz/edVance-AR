// edVance AR - Scanner with built-in rocket + admin auth
(() => {
  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const canvas = $('#frame');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const modelContainer = $('#model-container');
  const startBtn = $('#start-btn');
  const loader = $('#loader');
  const scanResult = $('#scan-result');
  const scanResultP = $('#scan-result p');

  let scanning = false;
  let lastText = '';
  let barcodeDetector = null;
  let currentId = null;
  let modelVisible = false;
  let lastSeen = 0;
  let hideDelayMs = 4000;

  function show(el){ el?.classList?.remove('hidden'); }
  function hide(el){ el?.classList?.add('hidden'); }
  function status(msg, err=false){
    if (!scanResultP) return;
    scanResultP.textContent = msg;
    scanResult.classList.remove('hidden');
    scanResult.style.borderColor = err ? 'rgba(255,100,100,.4)' : 'rgba(255,255,255,.12)';
  }

  async function initCamera(){
    if (location.protocol !== 'https:' && location.hostname !== 'localhost'){
      status('Camera requires HTTPS or localhost.', true);
      throw new Error('insecure');
    }
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 }, height: { ideal: 720 }
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  const sceneWrap = (inner) => `
    <a-scene embedded renderer="alpha:true;antialias:true" vr-mode-ui="enabled:false" background="transparent:true"
             cursor="rayOrigin:mouse">
      ${inner}
      <a-light type="ambient" intensity="1"></a-light>
      <a-light type="directional" intensity="0.7" position="-1 1 2"></a-light>
      <a-camera wasd-controls-enabled="false" look-controls="enabled:false" position="0 0 2"></a-camera>
    </a-scene>`;

  // Drag-rotate component (desktop + mobile)
  if (window.AFRAME && !AFRAME.components['drag-rotate']) {
    AFRAME.registerComponent('drag-rotate', {
      schema: { speed: { default: 0.4 } },
      init: function(){
        const el = this.el;
        const sceneEl = el.sceneEl;
        let dragging = false, px=0, py=0, rx=0, ry=0;
        const start = (x,y)=>{ dragging=true; px=x; py=y; const r=el.getAttribute('rotation')||{x:0,y:0}; rx=r.x||0; ry=r.y||0; };
        const move = (x,y)=>{ if (!dragging) return; const dx=x-px, dy=y-py; el.setAttribute('rotation', `${rx - dy*this.data.speed} ${ry + dx*this.data.speed} 0`); };
        const end = ()=>{ dragging=false; };
        const attach = ()=>{
          const c = sceneEl.canvas || sceneEl.renderer?.domElement; if (!c) return setTimeout(attach,50);
          c.addEventListener('mousedown', e=>start(e.clientX,e.clientY));
          window.addEventListener('mousemove', e=>move(e.clientX,e.clientY));
          window.addEventListener('mouseup', end);
          c.addEventListener('touchstart', e=>{const t=e.touches[0]; start(t.clientX,t.clientY)}, {passive:true});
          window.addEventListener('touchmove', e=>{const t=e.touches[0]; move(t.clientX,t.clientY)}, {passive:true});
          window.addEventListener('touchend', end);
        };
        attach();
      }
    });
  }

  function forceTransparent(){
    const sceneEl = modelContainer.querySelector('a-scene');
    if (!sceneEl) return;
    const apply = () => {
      try { const r = sceneEl.renderer; if (r) { r.setClearColor(0x000000, 0); r.setClearAlpha?.(0); } } catch {}
      const c = sceneEl.canvas || sceneEl.renderer?.domElement;
      if (c && c.style) c.style.background = 'transparent';
      modelContainer.style.background = 'transparent';
    };
    if (sceneEl.hasLoaded) apply(); else sceneEl.addEventListener('loaded', apply);
    sceneEl.addEventListener('render-target-loaded', apply);
  }

  function clearOverlay(){
    modelContainer.innerHTML = '';
    $('#model-caption')?.remove();
  }
  function setCaption(title, description){
    let cap = $('#model-caption');
    if (!cap){ cap = document.createElement('div'); cap.id = 'model-caption'; modelContainer.appendChild(cap); }
    cap.innerHTML = `<strong>${title||''}</strong><span class="desc">${description||''}</span>`;
  }

  // Built-in presets for ID-1..ID-4
  const builtinById = {
    "ID-1": { id:"ID-1", title:"Robot Expressive", description:"Interactive — drag to rotate.", type:"gltf",
              gltfUrl:"https://modelviewer.dev/shared-assets/models/RobotExpressive.glb", scale:"0.6 0.6 0.6", position:"0 -0.5 0", rotation:"0 0 0" },
    "ID-2": { id:"ID-2", title:"Rocket", description:"Built-in model — drag to rotate.", type:"builtin", builtin:"rocket" },
    "ID-3": { id:"ID-3", title:"Astronaut", description:"Interactive — drag to rotate.", type:"gltf",
              gltfUrl:"https://modelviewer.dev/shared-assets/models/Astronaut.glb", scale:"1.1 1.1 1.1", position:"0 0 0", rotation:"0 0 0" },
    "ID-4": { id:"ID-4", title:"Solar System", description:"Animated orbits; drag to rotate the system.", type:"builtin", builtin:"solar" }
  };

  async function fetchItemById(raw){
    let id = raw;
    const m = /ID-\w+/.exec(raw) || /[?&]id=(ID-\w+)/.exec(raw);
    if (m) id = m[0].startsWith('ID-') ? m[0] : m[1];
    if (builtinById[id]) return builtinById[id];
    const urls = [`./data/${encodeURIComponent(id)}.json`];
    for (const u of urls){
      try { const res = await fetch(u, { cache: 'no-store' }); if (res.ok) return await res.json(); } catch {}
    }
    throw new Error(`No record for ${id}`);
  }

  function renderItem(item){
    clearOverlay();
    const pos = item.position || '0 0 0';
    const rot = item.rotation || '0 0 0';
    const scl = item.scale || '1 1 1';

    if (item.type === 'gltf' && item.gltfUrl){
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 0 -2.2">
          <a-entity gltf-model="url(${item.gltfUrl})"
                    position="${pos}"
                    rotation="${rot}"
                    scale="${scl}"
                    drag-rotate
                    animation-mixer></a-entity>
        </a-entity>`);
      forceTransparent();
      setCaption(item.title, item.description);
      return;
    }

    if (item.type === 'image' && item.imageUrl){
      const img = new Image();
      img.src = item.imageUrl;
      img.id = 'overlay-img';
      img.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:70vw;max-height:70vh;z-index:3;pointer-events:none';
      modelContainer.appendChild(img);
      setCaption(item.title, item.description);
      return;
    }

    if (item.type === 'builtin' && item.builtin === 'solar'){
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 0 -3" drag-rotate>
          <a-sphere radius="0.4" color="#FDB813"
                    animation="property: rotation; to:0 360 0; loop:true; dur:12000; easing:linear"></a-sphere>

          <a-entity animation="property: rotation; to:0 360 0; loop:true; dur:10000; easing:linear">
            <a-entity position="1.6 0 0">
              <a-sphere radius="0.16" color="#2E8B57"
                        animation="property: rotation; to:0 360 0; loop:true; dur:4000; easing:linear"></a-sphere>
              <a-entity animation="property: rotation; to:0 360 0; loop:true; dur:2800; easing:linear">
                <a-sphere position="0.34 0 0" radius="0.05" color="#bbbbbb"></a-sphere>
              </a-entity>
            </a-entity>
          </a-entity>

          <a-entity animation="property: rotation; to:0 360 0; loop:true; dur:7000; easing:linear">
            <a-sphere position="0.9 0 0" radius="0.09" color="#c77a2f"></a-sphere>
          </a-entity>
        </a-entity>`);
      forceTransparent();
      setCaption(item.title, item.description);
      return;
    }

    if (item.type === 'builtin' && item.builtin === 'rocket'){
      modelContainer.innerHTML = sceneWrap(`
        <a-entity position="0 0 -2.6" drag-rotate animation="property: position; dir: alternate; from: 0 0 -2.65; to: 0 0 -2.55; loop: true; dur: 1800; easing: easeInOutSine">
          <!-- body -->
          <a-cylinder position="0 -0.1 0" radius="0.18" height="0.9" color="#e5e7eb"></a-cylinder>
          <!-- nose -->
          <a-cone position="0 0.45 0" radius-bottom="0.18" radius-top="0.0" height="0.35" color="#ef4444"></a-cone>
          <!-- fins -->
          <a-box position="0.18 -0.35 0" depth="0.06" height="0.18" width="0.14" rotation="0 0 18" color="#ef4444"></a-box>
          <a-box position="-0.18 -0.35 0" depth="0.06" height="0.18" width="0.14" rotation="0 0 -18" color="#ef4444"></a-box>
          <a-box position="0 -0.35 0.18" depth="0.14" height="0.18" width="0.06" rotation="18 0 0" color="#ef4444"></a-box>
          <a-box position="0 -0.35 -0.18" depth="0.14" height="0.18" width="0.06" rotation="-18 0 0" color="#ef4444"></a-box>
          <!-- window -->
          <a-ring position="0 0.1 0.19" radius-inner="0.05" radius-outer="0.07" color="#1f2937"></a-ring>
          <!-- flame -->
          <a-cone position="0 -0.63 0" radius-bottom="0.12" radius-top="0.02" height="0.32" color="#f59e0b"
                   animation="property: scale; dir: alternate; from: 1 0.8 1; to: 1 1.2 1; loop: true; dur: 160"></a-cone>
        </a-entity>`);
      forceTransparent();
      setCaption(item.title, item.description);
      return;
    }

    // fallback cube
    modelContainer.innerHTML = sceneWrap(`
      <a-entity position="0 0 -2.3" drag-rotate>
        <a-box width="0.9" height="0.9" depth="0.9"
               material="color:#33b1ff;metalness:0.2;roughness:0.5"
               animation="property: rotation; to:0 360 0; loop:true; dur:14000; easing:linear"></a-box>
        <a-text value="${(item.builtin||'EDGE').toUpperCase()}" align="center" width="2" color="#fff" position="0 0 0.6"></a-text>
      </a-entity>`);
    forceTransparent();
    setCaption(item.title, item.description);
  }

  async function onScan(text){
    if (!text) return;
    lastText = text;
    try {
      show(loader);
      const item = await fetchItemById(text);
      renderItem(item);
      modelVisible = true; currentId = text; lastSeen = Date.now();
      status(`QR: ${text}`);
    } catch (e){
      status(e.message||'Unrecognized QR', true);
      clearOverlay();
    } finally { hide(loader); }
  }

  async function scanLoop(){
    if (!scanning) return;
    try {
      if (!barcodeDetector && 'BarcodeDetector' in window){
        try { barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
      }
      if (barcodeDetector){
        const codes = await barcodeDetector.detect(video);
        if (codes?.length){
          const v = codes[0].rawValue;
          if (v === currentId && modelVisible){ lastSeen = Date.now(); }
          else await onScan(v);
        }
      } else if (window.jsQR){
        const w = canvas.width = video.videoWidth || canvas.width;
        const h = canvas.height = video.videoHeight || canvas.height;
        if (w && h){
          ctx.drawImage(video, 0, 0, w, h);
          const imgData = ctx.getImageData(0, 0, w, h);
          const code = window.jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
          if (code?.data){
            if (code.data === currentId && modelVisible){ lastSeen = Date.now(); }
            else await onScan(code.data);
          }
        }
      }
    } catch (e){ }
    finally {
      if (modelVisible && Date.now() - lastSeen > hideDelayMs){
        clearOverlay(); modelVisible = false; currentId = null; status('Scanning…');
      }
      requestAnimationFrame(scanLoop);
    }
  }

  startBtn?.addEventListener('click', async () => {
    try { startBtn.disabled = true; await initCamera(); scanning = true; status('Scanning…'); scanLoop(); }
    catch (e){ startBtn.disabled = false; }
  });

  // Fullscreen toggle
  const fsBtn = document.getElementById('fs-btn');
  const videoWrap = document.querySelector('.video-wrap');
  fsBtn?.addEventListener('click', async () => {
    try { if (!document.fullscreenElement){ await videoWrap.requestFullscreen?.(); } else { await document.exitFullscreen?.(); } } catch (e){}
  });

  // Admin access (simple client-side prompt)
  const adminBtn = document.getElementById('admin-btn');
  adminBtn?.addEventListener('click', () => {
    const u = window.prompt('Username:');
    const p = u !== null ? window.prompt('Password:') : null;
    if (u === 'awaiz' && p === '1234') {
      window.location.href = './admin/create.html';
    } else if (u !== null && p !== null) {
      alert('Access denied');
    }
  });

  // Auto-start if camera already permitted
  (async () => {
    try { const perms = await navigator.permissions?.query?.({ name: 'camera' }); if (perms?.state === 'granted') startBtn?.click(); } catch {}
  })();
})();
