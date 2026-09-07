(function () {
  if (window.top !== window) return;

  const storageKey = `reader-auto-scroll-speed:${location.hostname}`;
  const safeGetStorage = (key) => {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  };
  const safeSetStorage = (key, val) => {
    try { localStorage.setItem(key, val); } catch (e) {}
  };

  const savedSpeed = Number(safeGetStorage(storageKey));
  const state = {
    running: false,
    speed: Number.isFinite(savedSpeed) && savedSpeed >= 1 ? savedSpeed : 50,
    frame: 0,
    target: null,
    lastTime: 0,
    carry: 0,
    nextShown: false,
    lastPosition: 0,
    startPosition: 0,
    stalledFrames: 0
  };

  // 恢复和图书等小说站正文容器的可滚动性，保障滚轮与 Chrome 原生中键漫游指针正常呼出
  const ensureContainerScrollable = () => {
    const el = document.querySelector('#cbox, #content, [role="main"]');
    if (el && el.scrollHeight > el.clientHeight + 10) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'hidden' || oy === 'clip') {
        el.style.setProperty('overflow-y', 'auto', 'important');
        el.style.setProperty('overflow-x', 'hidden', 'important');
      }
    }
  };
  ensureContainerScrollable();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureContainerScrollable);
  }

  // 1. 顶部沉浸式极简光感进度条
  const topProgressBar = document.createElement('div');
  topProgressBar.id = 'ras-top-progress';
  document.documentElement.appendChild(topProgressBar);

  // 2. 右下角悬浮控制面板（内嵌精美阅读进度胶囊）
  const panel = document.createElement('div');
  panel.id = 'reader-auto-scroll-panel';
  panel.innerHTML = `
    <button id="ras-toggle" title="点击或按 S 开始/暂停">开始滚动</button>
    <label>速度 <input id="ras-speed" type="range" min="1" max="200" value="50" step="1"></label>
    <span id="ras-value">50 px/s</span>
    <div id="ras-progress-pill" title="当前章节阅读进度">
      <div id="ras-progress-fill"></div>
      <span id="ras-progress-text">0%</span>
    </div>
    <button id="ras-up" title="加速 (Alt+↑)">加速</button>
    <button id="ras-down" title="减速 (Alt+↓)">减速</button>
    <button id="ras-next" title="进入下一章 (Enter)" disabled>下一章</button>
    <button id="ras-close" title="收起/展开控制条">×</button>`;
  document.documentElement.appendChild(panel);

  const nextTip = document.createElement('div');
  nextTip.id = 'ras-next-tip';
  nextTip.innerHTML = '<span>下一章已准备</span><button type="button">按 Enter 继续</button>';
  document.documentElement.appendChild(nextTip);

  const toggle = panel.querySelector('#ras-toggle');
  const slider = panel.querySelector('#ras-speed');
  const value = panel.querySelector('#ras-value');
  const progressFill = panel.querySelector('#ras-progress-fill');
  const progressText = panel.querySelector('#ras-progress-text');
  const nextButton = panel.querySelector('#ras-next');

  const setSpeed = (n) => {
    state.speed = Math.max(1, Math.min(200, n));
    slider.value = state.speed;
    value.textContent = `${state.speed} px/s`;
    safeSetStorage(storageKey, String(state.speed));
  };
  setSpeed(state.speed);

  const isRootTarget = (target) =>
    target === document.scrollingElement || target === document.documentElement || target === document.body;

  const canScrollElement = (el) => {
    if (!el || el === panel || el.closest?.('#reader-auto-scroll-panel')) return false;
    if (el.scrollHeight <= el.clientHeight + 4) return false;
    const overflow = getComputedStyle(el).overflowY;
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  };

  const getScrollMetrics = (target) => {
    if (!target) return { position: 0, max: 0 };
    const root = isRootTarget(target);
    const position = root ? (window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0) : target.scrollTop;
    const viewport = root ? window.innerHeight : target.clientHeight;
    const content = root ? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) : target.scrollHeight;
    return { position, max: Math.max(0, content - viewport) };
  };

  const updateProgress = (target) => {
    if (!target) return { position: 0, max: 0 };
    const { position, max } = getScrollMetrics(target);
    const percent = max ? Math.min(100, Math.max(0, Math.round((position / max) * 100))) : 0;
    
    // 同步更新顶部光感细条与面板内的进度胶囊
    topProgressBar.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
    progressFill.style.width = `${percent}%`;

    if (position < state.lastPosition - 20) {
      state.nextShown = false;
      nextTip.classList.remove('ras-visible');
      nextButton.disabled = true;
    }
    state.lastPosition = position;
    return { position, max };
  };

  const findScrollTarget = () => {
    ensureContainerScrollable();
    const root = document.scrollingElement || document.documentElement;
    const rootMetrics = getScrollMetrics(root);

    // 优先检查小说阅读器常见正文容器（如和图书的 #cbox）
    const preferred = document.querySelector('#cbox, #content, .content, [role="main"], article, .read-content, #htmlContent');
    if (preferred && canScrollElement(preferred)) {
      return preferred;
    }

    // 检查其他内部可滚动容器
    const candidates = [...document.querySelectorAll('body *')]
      .filter((el) => el !== panel && !el.closest('#reader-auto-scroll-panel'))
      .filter(canScrollElement);
    candidates.sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth));

    if (candidates.length > 0 && candidates[0].scrollHeight > candidates[0].clientHeight + 10) {
      if (rootMetrics.max <= 0) return candidates[0];
      if (candidates[0].clientHeight * candidates[0].clientWidth > (window.innerWidth * window.innerHeight * 0.3)) {
        return candidates[0];
      }
    }

    return rootMetrics.max > 0 ? root : (document.body || document.documentElement);
  };

  // 底层全容错滚动执行器（兼容 window、documentElement、body 及各类滚动容器）
  const executeScroll = (target, distance) => {
    if (!distance) return 0;
    const isRoot = isRootTarget(target);
    const beforePos = getScrollMetrics(target).position;

    if (isRoot) {
      window.scrollBy(0, distance);
      const afterPos = getScrollMetrics(target).position;
      if (Math.abs(afterPos - beforePos) < 0.5) {
        if (document.scrollingElement) document.scrollingElement.scrollTop += distance;
        else if (document.documentElement) document.documentElement.scrollTop += distance;
        if (document.body) document.body.scrollTop += distance;
      }
    } else {
      target.scrollTop += distance;
      const afterPos = target.scrollTop;
      if (Math.abs(afterPos - beforePos) < 0.5) {
        window.scrollBy(0, distance);
        if (document.scrollingElement) document.scrollingElement.scrollTop += distance;
        if (document.body) document.body.scrollTop += distance;
      }
    }
    return getScrollMetrics(target).position - beforePos;
  };

  const tick = (time) => {
    if (!state.running) return;
    const elapsed = state.lastTime ? Math.min(50, time - state.lastTime) : 16.67;
    state.lastTime = time;
    state.carry += state.speed * (elapsed / 1000);
    const distance = Math.trunc(state.carry);
    state.carry -= distance;

    if (!distance) {
      state.frame = requestAnimationFrame(tick);
      return;
    }

    let target = state.target || (state.target = findScrollTarget());
    let isRoot = isRootTarget(target);
    let metrics = getScrollMetrics(target);

    if (!isRoot && metrics.max <= 0) {
      const replacement = findScrollTarget();
      if (replacement !== target) {
        state.target = target = replacement;
        metrics = getScrollMetrics(target);
        isRoot = isRootTarget(target);
      }
    }

    const moved = executeScroll(target, distance);
    const { position, max } = updateProgress(target);

    if (Math.abs(moved) < 0.5) {
      state.stalledFrames += 1;
    } else {
      state.stalledFrames = 0;
    }

    if (state.stalledFrames >= 3) {
      const fallback = findScrollTarget();
      if (fallback !== target) {
        state.target = fallback;
      } else if (!isRoot) {
        state.target = document.scrollingElement || document.documentElement;
      }
      state.stalledFrames = 0;
    }

    if (!state.nextShown && max > 0 && position > state.startPosition + 20 && position >= max - 80) {
      const next = document.querySelector('#next, a.next');
      if (next) {
        state.nextShown = true;
        nextTip.classList.add('ras-visible');
        nextButton.disabled = false;
      }
    }

    state.frame = requestAnimationFrame(tick);
  };

  const goNext = () => {
    const next = document.querySelector('#next, a.next');
    if (!next) return;
    next.click();
  };

  const setRunning = (running) => {
    state.running = running;
    if (running) {
      state.target = findScrollTarget();
      state.startPosition = getScrollMetrics(state.target).position;
      state.stalledFrames = 0;
      executeScroll(state.target, 3);
    }
    if (state.target) updateProgress(state.target);
    toggle.textContent = running ? '暂停滚动' : '开始滚动';
    panel.classList.toggle('ras-running', running);
    if (state.frame) cancelAnimationFrame(state.frame);
    state.lastTime = 0;
    state.carry = 0;
    state.frame = running ? requestAnimationFrame(tick) : 0;
  };

  const handlePanelAction = (btn) => {
    if (!btn) return;
    if (btn.id === 'ras-toggle') {
      setRunning(!state.running);
    } else if (btn.id === 'ras-up') {
      setSpeed(state.speed + 1);
    } else if (btn.id === 'ras-down') {
      setSpeed(state.speed - 1);
    } else if (btn.id === 'ras-close') {
      panel.classList.toggle('ras-collapsed');
    } else if (btn.id === 'ras-next') {
      goNext();
    }
  };

  // 在顶级 window 捕获阶段拦截控制面板按钮点击，彻底防止宿主网页脚本调用 stopPropagation 导致点击无反应
  window.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#reader-auto-scroll-panel button');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      handlePanelAction(btn);
      return;
    }
    const tipBtn = e.target && e.target.closest && e.target.closest('#ras-next-tip button');
    if (tipBtn) {
      e.preventDefault();
      e.stopPropagation();
      goNext();
      return;
    }
  }, true);

  // 防止网页 mousedown 拦截 panel 内部操作
  window.addEventListener('mousedown', (e) => {
    if (e.target && e.target.closest && e.target.closest('#reader-auto-scroll-panel, #ras-next-tip')) {
      e.stopPropagation();
    }
  }, true);

  slider.addEventListener('input', () => setSpeed(Number(slider.value)));

  // 鼠标中键：确保 Chrome 原生滚轮漫游正常呼出
  // 阻断小说网站自身的防复制/防中键脚本执行 preventDefault()，同时自身绝不调用 preventDefault()，放行给浏览器原生漫游
  window.addEventListener('mousedown', (e) => {
    if (e.button === 1) { // 鼠标中键
      ensureContainerScrollable();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener('pointerdown', (e) => {
    if (e.button === 1) {
      ensureContainerScrollable();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      // 允许中键点击链接正常在新标签页打开，阻断网站阻止
      e.stopPropagation();
    }
  }, true);

  // 解除小说网站对鼠标复制/选择/右键的恶性拦截，保障正常操作与中键响应
  ['contextmenu', 'selectstart', 'copy', 'cut', 'dragstart'].forEach((evtName) => {
    window.addEventListener(evtName, (e) => {
      e.stopPropagation();
    }, true);
  });

  document.addEventListener('wheel', (event) => {
    if (event.target.closest?.('#reader-auto-scroll-panel')) return;
    const target = state.target || (state.target = findScrollTarget());
    if (target) requestAnimationFrame(() => updateProgress(target));
  }, { capture: true, passive: true });

  const syncTarget = () => {
    const target = state.target || (state.target = findScrollTarget());
    updateProgress(target);
  };

  document.addEventListener('scroll', (event) => {
    const rootEvent = event.target === document || event.target === document.scrollingElement || event.target === document.documentElement || event.target === document.body;
    const target = state.target || (state.target = findScrollTarget());
    if (rootEvent || event.target === target) syncTarget();
  }, true);

  document.addEventListener('keydown', (event) => {
    const tag = event.target && event.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable;
    if (!typing && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's') {
      event.preventDefault(); setRunning(!state.running); return;
    }
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'r') {
      event.preventDefault(); panel.classList.toggle('ras-hidden'); return;
    }
    if (state.running && !typing && event.altKey && event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation(); setSpeed(state.speed + 1); return;
    }
    if (state.running && !typing && event.altKey && event.key === 'ArrowDown') {
      event.preventDefault(); event.stopImmediatePropagation(); setSpeed(state.speed - 1); return;
    }
    if (!typing && event.key === 'F8') { event.preventDefault(); panel.classList.remove('ras-hidden'); return; }
    if (!typing && event.key === 'Enter' && nextTip.classList.contains('ras-visible')) { event.preventDefault(); goNext(); return; }
  }, true);

  // 页面加载完成后主动同步初始阅读进度
  const initSync = () => {
    const target = state.target || (state.target = findScrollTarget());
    if (target) updateProgress(target);
  };
  initSync();
  setTimeout(initSync, 100);
})();
