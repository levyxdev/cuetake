/** Install once per document; all geometry uses CSS pixels, canvas uses DPR. */
export async function injectDemoOverlay(page, options = {}) {
  await page.evaluate(({ style: pointerStyle, size, color, clickEffect }) => {
    window.__cuetakeOverlay?.dispose();
    const abort = new AbortController();
    const root = document.createElement('div');
    root.id = 'cuetake-overlay';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root.setAttribute('aria-hidden', 'true');
    const css = document.createElement('style');
    css.textContent = '* { cursor:none !important; }';
    const cursor = document.createElement('div');
    cursor.id = 'cuetake-cursor';
    const hotspot = pointerStyle === 'arrow' ? size * 2 / 28 : size / 2;
    cursor.style.cssText = `position:absolute;left:-100px;top:-100px;width:${size}px;height:${pointerStyle === 'arrow' ? size * 36 / 28 : size}px;color:${color};transform:translate(-${hotspot}px,-${hotspot}px);filter:drop-shadow(0 1px 2px #0005)`;
    if (pointerStyle === 'arrow') {
      cursor.innerHTML = '<svg viewBox="0 0 28 36" width="100%" height="100%"><path d="M2 2 L2 27 L8.5 21 L14 33 L19 30.5 L13.5 19 L23 19 Z" fill="currentColor" stroke="#171717" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    } else {
      cursor.style.background = color;
      cursor.style.borderRadius = '50%';
      cursor.style.boxShadow = 'inset 0 0 0 1.5px #171717';
    }
    const canvas = document.createElement('canvas');
    canvas.id = 'cuetake-click-sparks';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    root.append(css, canvas, cursor);
    document.documentElement.append(root);
    const ctx = canvas.getContext('2d');
    function resize() {
      const dpr = devicePixelRatio || 1;
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize, { signal: abort.signal });
    let sparks = [];
    let animationId = null;
    const state = { activeCount: 0, lastClick: null };
    function draw(now) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      sparks = sparks.filter(s => now - s.start < clickEffect.duration);
      for (const spark of sparks) {
        const progress = Math.min(1, (now - spark.start) / clickEffect.duration);
        const eased = 1 - (1 - progress) ** 3;
        const distance = 5 + eased * clickEffect.radius;
        const length = clickEffect.length * (1 - eased);
        ctx.globalAlpha = 1 - progress;
        ctx.lineCap = 'round';
        for (let i = 0; i < clickEffect.count; i++) {
          const angle = 2 * Math.PI * i / clickEffect.count + Math.PI / 8;
          ctx.beginPath();
          ctx.moveTo(spark.x + distance * Math.cos(angle), spark.y + distance * Math.sin(angle));
          ctx.lineTo(spark.x + (distance + length) * Math.cos(angle), spark.y + (distance + length) * Math.sin(angle));
          // Dark edge + pointer-colored core are legible on white and dark UIs.
          ctx.strokeStyle = '#171717'; ctx.lineWidth = 4.5; ctx.stroke();
          ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      state.activeCount = sparks.length;
      animationId = sparks.length ? requestAnimationFrame(draw) : null;
    }
    const update = event => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; };
    document.addEventListener('pointermove', update, { capture: true, signal: abort.signal });
    document.addEventListener('pointerdown', event => {
      update(event);
      if (event.button !== 0 || clickEffect.style === 'none') return;
      sparks.push({ x: event.clientX, y: event.clientY, start: performance.now() });
      state.lastClick = { x: event.clientX, y: event.clientY };
      if (animationId === null) animationId = requestAnimationFrame(draw);
    }, { capture: true, signal: abort.signal });
    window.__cuetakeOverlay = {
      state,
      dispose() { abort.abort(); if (animationId !== null) cancelAnimationFrame(animationId); root.remove(); },
    };
  }, {
    style: options.cursorStyle || 'arrow', size: options.cursorSize || 24, color: options.cursorColor || '#ffffff',
    clickEffect: { style: 'spark', radius: 32, length: 16, count: 8, duration: 420, ...options.clickEffect },
  });
}
