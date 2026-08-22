/* 이미지 메타데이터 뷰어 — Chrome 확장 콘텐츠 스크립트
 * 유저스크립트 본문을 그대로 쓰고, GM_* 함수만 크롬 API로 대체한다.
 * 이 파일은 build.py 가 자동 생성한다. 직접 고치지 말 것.
 */
(async () => {
  'use strict';

  // ── 설정 저장소 (팝업과 공유) ───────────────────────────────
  let CACHE = {};
  try { CACHE = await chrome.storage.local.get(null); } catch (e) { CACHE = {}; }

  function GM_getValue(k, d) { return (k in CACHE) ? CACHE[k] : d; }
  function GM_setValue(k, v) { CACHE[k] = v; try { chrome.storage.local.set({ [k]: v }); } catch (e) {} }

  // ── 스타일 주입 ─────────────────────────────────────────────
  function GM_addStyle(css) {
    const st = document.createElement('style');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
    return st;
  }

  // ── 클립보드 ────────────────────────────────────────────────
  function GM_setClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ── 메뉴 명령은 팝업 UI가 대신한다 ──────────────────────────
  function GM_registerMenuCommand() {}

  // ── 이미지 받기 (백그라운드 서비스 워커 경유) ───────────────
  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function GM_xmlhttpRequest(opt) {
    const range = opt.headers && opt.headers.Range;
    let done = false;
    const timer = opt.timeout ? setTimeout(() => {
      if (!done) { done = true; opt.ontimeout && opt.ontimeout(); }
    }, opt.timeout) : 0;

    try {
      chrome.runtime.sendMessage({ type: 'imv-fetch', url: opt.url, range }, (res) => {
        if (done) return;
        done = true; if (timer) clearTimeout(timer);
        if (chrome.runtime.lastError || !res) {
          opt.onerror && opt.onerror(new Error(
            (chrome.runtime.lastError && chrome.runtime.lastError.message) || '확장프로그램 통신 실패'));
          return;
        }
        if (!res.ok) {
          opt.onload && opt.onload({ status: res.status || 0, response: null, responseHeaders: '' });
          return;
        }
        const u8 = b64ToU8(res.data);
        const headers = [
          res.contentRange ? 'content-range: ' + res.contentRange : '',
          res.contentType ? 'content-type: ' + res.contentType : '',
        ].filter(Boolean).join('\n');
        opt.onload && opt.onload({ status: res.status, response: u8.buffer, responseHeaders: headers });
      });
    } catch (e) {
      if (!done) { done = true; if (timer) clearTimeout(timer); opt.onerror && opt.onerror(e); }
    }
  }

  // ── 저장은 브라우저 기본 다운로드로 ─────────────────────────
  window.__imvDownload = (url, filename) => {
    try { chrome.runtime.sendMessage({ type: 'imv-download', url, filename }); }
    catch (e) {}
  };

  // ── 팝업에서 설정을 바꾸면 바로 반영 ────────────────────────
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const k of Object.keys(changes)) CACHE[k] = changes[k].newValue;
      const cfg = window.__imvDebug && window.__imvDebug.CFG;
      if (!cfg) return;
      if ('openOn' in changes) cfg.openOn = changes.openOn.newValue;
      if ('skipStickers' in changes) cfg.skipStickers = changes.skipStickers.newValue;
    });
  } catch (e) {}

/* ===================== 유저스크립트 본문 시작 ===================== */
