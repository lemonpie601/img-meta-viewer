// ==UserScript==
// @name         이미지 메타데이터 뷰어
// @namespace    https://github.com/local/img-meta-viewer
// @version      4.5.0
// @description  아카라이브·디시인사이드에서 이미지를 Alt+클릭하면 페이지 안에 카드 팝업이 뜨고, EXIF와 NovelAI·ComfyUI·A1111 등 각종 AI 생성 메타데이터를 보여줍니다. 사이트 다크/라이트 테마 자동 대응.
// @author       you
// @match        https://arca.live/*
// @match        https://*.arca.live/*
// @match        https://gall.dcinside.com/*
// @match        https://m.dcinside.com/*
// @match        https://*.dcinside.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      namu.la
// @connect      arca.live
// @connect      dcinside.com
// @connect      dcinside.co.kr
// @connect      nstatic.dcinside.com
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================
   * 0. 설정
   * ======================================================= */
  // 설정은 템퍼몽키에 저장되어 새로고침해도 유지된다
  const store = {
    get(k, d) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) {}
      try { const v = localStorage.getItem('imv_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) {}
      try { localStorage.setItem('imv_' + k, JSON.stringify(v)); } catch (e) {}
    },
  };

  const CFG = {
    // 'alt'      = Alt+클릭으로 열기 (평소 클릭은 사이트 원래 동작 그대로)
    // 'dblclick' = 더블클릭으로 열기 (한 번 클릭은 아무 일도 없음)
    // 'click'    = 그냥 클릭으로 열기 (사이트 기본 동작을 가로챔)
    openOn: store.get('openOn', 'alt'),
    // 디시콘·아카콘·프로필 아이콘 등은 그냥 클릭 방식일 때 분석 대상에서 제외
    skipStickers: store.get('skipStickers', true),
    // 팝업 최대 이미지 배율
    maxZoom: 8,
    minZoom: 0.05,
  };

  const HOST = location.hostname;
  const IS_ARCA = /arca\.live$/.test(HOST);
  const IS_DC = /dcinside\.(com|co\.kr)$/.test(HOST);

  /* =========================================================
   * 1. 바이너리 유틸
   * ======================================================= */

  const td = new TextDecoder('utf-8');
  const tdLatin = new TextDecoder('latin1');

  function u8ToStr(u8) {
    try { return td.decode(u8); } catch (e) { return tdLatin.decode(u8); }
  }

  function bytesHuman(n) {
    if (n == null) return '-';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(2)) + ' ' + u[i];
  }

  // DecompressionStream 기반 압축 해제 (deflate = zlib, gzip)
  async function decompress(u8, format) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream 미지원');
    const ds = new DecompressionStream(format);
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function tryInflate(u8) {
    // zTXt/iTXt 는 zlib(deflate) 컨테이너
    try { return await decompress(u8, 'deflate'); } catch (e) { /* fallthrough */ }
    try { return await decompress(u8, 'deflate-raw'); } catch (e) { /* fallthrough */ }
    throw new Error('압축 해제 실패');
  }

  /* =========================================================
   * 2. 포맷 감지
   * ======================================================= */

  function detectFormat(u8) {
    const b = u8;
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
    if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'WEBP';
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'GIF';
    if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const brand = tdLatin.decode(b.subarray(8, 12));
      if (brand.startsWith('avif')) return 'AVIF';
      return 'MP4';
    }
    if (b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) return 'TIFF';
    return 'UNKNOWN';
  }

  /* =========================================================
   * 3. PNG 청크 파서
   * ======================================================= */

  async function parsePNG(u8) {
    const out = { width: null, height: null, bitDepth: null, colorType: null, text: {}, chunks: [] };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 8;
    const colorTypes = {
      0: 'Grayscale', 2: 'Truecolor (RGB)', 3: 'Indexed',
      4: 'Grayscale + Alpha', 6: 'Truecolor + Alpha (RGBA)',
    };

    while (p + 8 <= u8.length) {
      const len = dv.getUint32(p);
      const type = tdLatin.decode(u8.subarray(p + 4, p + 8));
      const dataStart = p + 8;
      const dataEnd = dataStart + len;
      if (dataEnd > u8.length) break;
      out.chunks.push(type);

      if (type === 'IHDR') {
        out.width = dv.getUint32(dataStart);
        out.height = dv.getUint32(dataStart + 4);
        out.bitDepth = u8[dataStart + 8];
        out.colorType = colorTypes[u8[dataStart + 9]] || String(u8[dataStart + 9]);
        out.hasAlpha = u8[dataStart + 9] === 4 || u8[dataStart + 9] === 6;
      } else if (type === 'tEXt') {
        const seg = u8.subarray(dataStart, dataEnd);
        const z = seg.indexOf(0);
        if (z > -1) {
          out.text[tdLatin.decode(seg.subarray(0, z))] = u8ToStr(seg.subarray(z + 1));
        }
      } else if (type === 'zTXt') {
        const seg = u8.subarray(dataStart, dataEnd);
        const z = seg.indexOf(0);
        if (z > -1) {
          const key = tdLatin.decode(seg.subarray(0, z));
          try {
            const raw = await tryInflate(seg.subarray(z + 2));
            out.text[key] = u8ToStr(raw);
          } catch (e) { out.text[key] = '[압축 해제 실패]'; }
        }
      } else if (type === 'iTXt') {
        const seg = u8.subarray(dataStart, dataEnd);
        const z = seg.indexOf(0);
        if (z > -1) {
          const key = tdLatin.decode(seg.subarray(0, z));
          const compFlag = seg[z + 1];
          // z+2 = compression method, 이후 language tag \0 translated keyword \0 text
          let q = z + 3;
          let nulls = 0;
          while (q < seg.length && nulls < 2) { if (seg[q] === 0) nulls++; q++; }
          const body = seg.subarray(q);
          if (compFlag === 1) {
            try { out.text[key] = u8ToStr(await tryInflate(body)); }
            catch (e) { out.text[key] = '[압축 해제 실패]'; }
          } else {
            out.text[key] = u8ToStr(body);
          }
        }
      } else if (type === 'eXIf') {
        out.exifChunk = u8.subarray(dataStart, dataEnd);
      } else if (type === 'caBX') {
        out.c2pa = true;
      } else if (type === 'IEND') {
        break;
      }
      p = dataEnd + 4; // + CRC
    }
    return out;
  }

  /* =========================================================
   * 4. EXIF (TIFF) 파서
   * ======================================================= */

  const EXIF_TAGS = {
    0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
    0x011a: 'XResolution', 0x011b: 'YResolution', 0x0128: 'ResolutionUnit',
    0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
    0x8298: 'Copyright', 0x010e: 'ImageDescription',
    0x8769: '_ExifIFD', 0x8825: '_GPSIFD',
    0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram',
    0x8827: 'ISO', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
    0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9204: 'ExposureBias',
    0x9205: 'MaxApertureValue', 0x9207: 'MeteringMode', 0x9208: 'LightSource',
    0x9209: 'Flash', 0x920a: 'FocalLength', 0x9286: 'UserComment',
    0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension',
    0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa406: 'SceneCaptureType',
    0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber',
    0xa432: 'LensSpecification', 0xa433: 'LensMake', 0xa434: 'LensModel',
    0x9291: 'SubSecTimeOriginal',
  };

  const GPS_TAGS = {
    0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude',
    0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude',
    0x0007: 'GPSTimeStamp', 0x001d: 'GPSDateStamp',
  };

  const ORIENTATION = {
    1: '정상 (0°)', 2: '좌우 반전', 3: '180° 회전', 4: '상하 반전',
    5: '좌우 반전 + 270°', 6: '90° 시계방향', 7: '좌우 반전 + 90°', 8: '270° 시계방향',
  };

  function parseTIFF(u8) {
    if (u8.length < 8) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const le = u8[0] === 0x49 && u8[1] === 0x49;
    if (!le && !(u8[0] === 0x4d && u8[1] === 0x4d)) return null;
    if (dv.getUint16(2, le) !== 42) return null;

    const result = {};
    const readIFD = (offset, tagMap, target) => {
      if (offset + 2 > u8.length) return 0;
      const count = dv.getUint16(offset, le);
      let sub = [];
      for (let i = 0; i < count; i++) {
        const e = offset + 2 + i * 12;
        if (e + 12 > u8.length) break;
        const tag = dv.getUint16(e, le);
        const type = dv.getUint16(e + 2, le);
        const num = dv.getUint32(e + 4, le);
        const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
        const size = (sizes[type] || 1) * num;
        let vOff = size > 4 ? dv.getUint32(e + 8, le) : e + 8;
        if (vOff + size > u8.length) continue;

        let val;
        try {
          if (type === 2) {
            val = tdLatin.decode(u8.subarray(vOff, vOff + num)).replace(/\0+$/, '');
          } else if (type === 7) {
            const raw = u8.subarray(vOff, vOff + num);
            val = decodeUserComment(raw);
          } else if (type === 5 || type === 10) {
            const arr = [];
            for (let k = 0; k < num; k++) {
              const a = type === 5 ? dv.getUint32(vOff + k * 8, le) : dv.getInt32(vOff + k * 8, le);
              const b = type === 5 ? dv.getUint32(vOff + k * 8 + 4, le) : dv.getInt32(vOff + k * 8 + 4, le);
              arr.push(b === 0 ? 0 : a / b);
            }
            val = arr.length === 1 ? arr[0] : arr;
          } else {
            const arr = [];
            for (let k = 0; k < num; k++) {
              const o = vOff + k * (sizes[type] || 1);
              if (type === 1 || type === 6) arr.push(u8[o]);
              else if (type === 3) arr.push(dv.getUint16(o, le));
              else if (type === 8) arr.push(dv.getInt16(o, le));
              else if (type === 4) arr.push(dv.getUint32(o, le));
              else if (type === 9) arr.push(dv.getInt32(o, le));
              else if (type === 11) arr.push(dv.getFloat32(o, le));
              else if (type === 12) arr.push(dv.getFloat64(o, le));
            }
            val = arr.length === 1 ? arr[0] : arr;
          }
        } catch (err) { continue; }

        const name = tagMap[tag];
        if (name === '_ExifIFD' || name === '_GPSIFD') {
          sub.push({ kind: name, offset: val });
        } else if (name) {
          target[name] = val;
        }
      }
      for (const s of sub) {
        if (s.kind === '_ExifIFD') readIFD(s.offset, EXIF_TAGS, target);
        else readIFD(s.offset, GPS_TAGS, target);
      }
      const nextOff = offset + 2 + count * 12;
      return nextOff + 4 <= u8.length ? dv.getUint32(nextOff, le) : 0;
    };

    readIFD(dv.getUint32(4, le), EXIF_TAGS, result);
    return Object.keys(result).length ? result : null;
  }

  function decodeUserComment(raw) {
    const head = tdLatin.decode(raw.subarray(0, 8));
    if (head.startsWith('ASCII')) return tdLatin.decode(raw.subarray(8)).replace(/\0+$/, '');
    if (head.startsWith('UNICODE')) {
      // UTF-16 (보통 BE)
      const body = raw.subarray(8);
      let s = '';
      for (let i = 0; i + 1 < body.length; i += 2) {
        const c = (body[i] << 8) | body[i + 1];
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    return u8ToStr(raw).replace(/\0+$/, '');
  }

  /* =========================================================
   * 5. JPEG / WEBP 세그먼트
   * ======================================================= */

  function parseJPEG(u8) {
    const out = { width: null, height: null, text: {}, comments: [] };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 2;
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xff) { p++; continue; }
      const marker = u8[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const len = dv.getUint16(p + 2);
      const seg = u8.subarray(p + 4, p + 2 + len);

      if (marker === 0xe1) {
        const sig = tdLatin.decode(seg.subarray(0, 6));
        if (sig === 'Exif\0\0') out.exifChunk = seg.subarray(6);
        else if (tdLatin.decode(seg.subarray(0, 28)).indexOf('ns.adobe.com/xap') > -1) out.xmp = u8ToStr(seg);
      } else if (marker === 0xeb) {
        if (tdLatin.decode(seg.subarray(0, 12)).indexOf('jumb') > -1) out.c2pa = true;
      } else if (marker === 0xfe) {
        out.comments.push(u8ToStr(seg));
      } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        out.height = dv.getUint16(p + 5);
        out.width = dv.getUint16(p + 7);
        out.bitDepth = u8[p + 4];
      }
      p += 2 + len;
    }
    return out;
  }

  function parseWEBP(u8) {
    const out = { width: null, height: null, text: {} };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 12;
    while (p + 8 <= u8.length) {
      const fourcc = tdLatin.decode(u8.subarray(p, p + 4));
      const size = dv.getUint32(p + 4, true);
      const body = u8.subarray(p + 8, p + 8 + size);
      if (fourcc === 'VP8X') {
        out.width = 1 + (body[4] | (body[5] << 8) | (body[6] << 16));
        out.height = 1 + (body[7] | (body[8] << 8) | (body[9] << 16));
        out.hasAlpha = !!(body[0] & 0x10);
      } else if (fourcc === 'VP8 ' && out.width == null) {
        out.width = dv.getUint16(p + 8 + 6, true) & 0x3fff;
        out.height = dv.getUint16(p + 8 + 8, true) & 0x3fff;
      } else if (fourcc === 'VP8L' && out.width == null) {
        const b = body;
        const bits = b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24);
        out.width = (bits & 0x3fff) + 1;
        out.height = ((bits >> 14) & 0x3fff) + 1;
      } else if (fourcc === 'EXIF') {
        out.exifChunk = body;
      } else if (fourcc === 'XMP ') {
        out.xmp = u8ToStr(body);
      }
      p += 8 + size + (size % 2);
    }
    return out;
  }

  function parseGIF(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true), text: {} };
  }

  /* =========================================================
   * 6. NovelAI Stealth PNG (알파 채널 LSB) 추출
   * ======================================================= */

  const STEALTH_MAGICS = ['stealth_pnginfo', 'stealth_pngcomp', 'stealth_rgbinfo', 'stealth_rgbcomp'];

  function bitsToStr(bits) {
    let s = '';
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let c = 0;
      for (let k = 0; k < 8; k++) c = (c << 1) | bits[i + k];
      s += String.fromCharCode(c);
    }
    return s;
  }

  // 알파 채널 LSB를 열 우선으로 읽는다.
  // 매직(120비트) + 길이(32비트)만 먼저 확인하고, 아니면 즉시 포기해서 큰 이미지에서도 가볍다.
  async function extractStealth(blobUrl) {
    let bmp = null, ctx = null, w = 0, h = 0;
    try {
      const blob = await (await fetch(blobUrl)).blob();
      if (typeof createImageBitmap === 'function') {
        bmp = await createImageBitmap(blob);
        w = bmp.width; h = bmp.height;
      } else {
        bmp = await new Promise((res, rej) => {
          const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = blobUrl;
        });
        w = bmp.naturalWidth; h = bmp.naturalHeight;
      }
      if (!w || !h || w * h > 40e6) return null;

      const Canvas = (typeof OffscreenCanvas === 'function')
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      ctx = Canvas.getContext('2d', { willReadFrequently: true, alpha: true });
      ctx.drawImage(bmp, 0, 0);

      // 한 번에 읽을 열 묶음 (필요한 만큼만)
      const HEADER_BITS = 15 * 8 + 32;
      const colsFor = (bits) => Math.max(1, Math.ceil(bits / h));

      let col = 0;
      let strip = null, stripW = 0, stripX = 0;
      const readStrip = (x, cols) => {
        const cw = Math.min(cols, w - x);
        strip = ctx.getImageData(x, 0, cw, h).data;
        stripW = cw; stripX = x;
      };
      const bitAt = (idx) => {
        const x = (idx / h) | 0, y = idx % h;
        if (x < stripX || x >= stripX + stripW) readStrip(x, Math.max(1, colsFor(HEADER_BITS)));
        return strip[(y * stripW + (x - stripX)) * 4 + 3] & 1;
      };

      const total = w * h;
      if (total < HEADER_BITS) return null;
      readStrip(0, colsFor(HEADER_BITS));

      // 매직 확인 (120비트) — 여기서 대부분의 이미지가 즉시 걸러진다
      const magicBits = [];
      for (let i = 0; i < 120; i++) magicBits.push(bitAt(i));
      const magic = bitsToStr(magicBits);
      if (!STEALTH_MAGICS.includes(magic)) return null;

      let dataLen = 0;
      for (let i = 120; i < HEADER_BITS; i++) dataLen = ((dataLen << 1) | bitAt(i)) >>> 0;
      if (dataLen <= 0 || dataLen > total - HEADER_BITS) return null;

      // 실제 데이터 구간만 추가로 읽는다
      const bytes = new Uint8Array(Math.ceil(dataLen / 8));
      let acc = 0, accN = 0, bi = 0;
      const startIdx = HEADER_BITS, endIdx = HEADER_BITS + dataLen;
      const chunkCols = Math.max(1, Math.ceil(4096 / h));
      for (let i = startIdx; i < endIdx; i++) {
        const x = (i / h) | 0;
        if (x < stripX || x >= stripX + stripW) readStrip(x, chunkCols);
        const y = i % h;
        acc = (acc << 1) | (strip[(y * stripW + (x - stripX)) * 4 + 3] & 1);
        if (++accN === 8) { bytes[bi++] = acc; acc = 0; accN = 0; }
      }

      let out = bytes;
      if (magic.endsWith('comp')) {
        try { out = await decompress(bytes, 'gzip'); } catch (e) { return null; }
      }
      return { magic, text: u8ToStr(out) };
    } catch (e) {
      return null;
    } finally {
      if (bmp && typeof bmp.close === 'function') bmp.close();
    }
  }

  /* =========================================================
   * 7. 생성 AI 메타데이터 해석 (여러 툴 지원)
   * ======================================================= */

  function safeJSON(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  const flat = (v) => (v === null || v === undefined) ? '' :
    (typeof v === 'boolean' ? (v ? '켜짐' : '꺼짐') :
      (typeof v === 'object' ? JSON.stringify(v) : String(v)));

  // A1111 계열 "parameters" 문자열
  function parseA1111(str) {
    const lines = String(str).split('\n');
    const last = lines[lines.length - 1];
    const isSettings = /(^|,)\s*(Steps|Sampler|CFG scale|Seed|Model)\s*:/.test(last) && lines.length > 1;
    const body = isSettings ? lines.slice(0, -1).join('\n') : str;
    const tail = isSettings ? last : '';

    let prompt = body, negative = '';
    const ni = body.indexOf('Negative prompt:');
    if (ni > -1) {
      prompt = body.slice(0, ni);
      negative = body.slice(ni + 'Negative prompt:'.length);
    }
    const settings = {};
    if (tail) {
      tail.split(/,\s*(?=[A-Za-z][\w .\-/]*:)/).forEach((kv) => {
        const i = kv.indexOf(':');
        if (i > -1) settings[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      });
    }
    return { prompt: prompt.trim(), negative: negative.trim(), settings };
  }

  const SETTING_LABELS = {
    steps: '스텝', Steps: '스텝', sampler: '샘플러', Sampler: '샘플러',
    sampler_name: '샘플러', scheduler: '스케줄러', noise_schedule: '노이즈 스케줄',
    seed: '시드', Seed: '시드', scale: 'CFG', cfg: 'CFG', 'CFG scale': 'CFG',
    cfg_scale: 'CFG', cfg_rescale: 'CFG 리스케일', model: '모델', Model: '모델',
    'Model hash': '모델 해시', width: '가로', height: '세로', Size: '크기',
    strength: '강도', denoise: '디노이즈', 'Denoising strength': '디노이즈',
    'Clip skip': 'CLIP skip', VAE: 'VAE', 'Hires upscale': '고해상도 배율',
    'Hires upscaler': '업스케일러', sm: 'SMEA', sm_dyn: 'SMEA DYN',
    n_samples: '생성 장수', uncond_scale: 'UC 강도', legacy: '레거시',
  };

  const ORDER = ['모델', '스텝', '샘플러', '스케줄러', 'CFG', '시드', '크기', '가로', '세로'];

  function tidySettings(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      const v = flat(obj[k]);
      if (v === '' || v === 'null' || v === 'undefined') continue;
      if (/^(signed_hash|request_type|reference_image|extra|v4_prompt|v4_negative_prompt|skip_cfg_above_sigma|controlnet_model|image|mask)$/i.test(k)) continue;
      if (v.length > 400) continue;
      out[SETTING_LABELS[k] || k] = v;
    }
    // 자주 보는 항목을 앞으로
    const sorted = {};
    for (const key of ORDER) if (out[key] !== undefined) { sorted[key] = out[key]; delete out[key]; }
    return Object.assign(sorted, out);
  }

  function mk(source, prompt, negative, settings, raw) {
    const P = (prompt || '').trim(), N = (negative || '').trim();
    const s = tidySettings(settings);
    // 프롬프트와 똑같은 값이 설정에 중복으로 남는 걸 방지
    for (const k of Object.keys(s)) if (s[k] === P || (N && s[k] === N)) delete s[k];
    return { source, prompt: P, negative: N, settings: s, raw };
  }

  // ---- 개별 감지기 ----------------------------------------------------
  const DETECTORS = [
    // NovelAI (V3 / V4 캐릭터 프롬프트 포함)
    (t) => {
      const c = safeJSON(t.Comment);
      if (!/NovelAI/i.test(t.Software || '') && !(c && (c.uc !== undefined || c.steps !== undefined) && t.Description !== undefined)) return null;
      const s = Object.assign({}, c || {});
      delete s.prompt; delete s.uc; delete s.negative_prompt;
      if (t.Source) s.model = t.Source;
      if (t.Generation_time) s['생성 시간'] = (+t.Generation_time).toFixed(1) + '초';

      let prompt = (c && c.prompt) || t.Description || '';
      let negative = (c && (c.uc || c.negative_prompt)) || '';
      const chars = [];

      if (c) {
        const vp = c.v4_prompt && c.v4_prompt.caption;
        const vn = c.v4_negative_prompt && c.v4_negative_prompt.caption;
        if (vp) {
          if (vp.base_caption) prompt = vp.base_caption;
          if (vn && vn.base_caption) negative = vn.base_caption;
          const pc = vp.char_captions || [];
          const nc = (vn && vn.char_captions) || [];
          pc.forEach((ch, i) => {
            const ctr = (ch.centers && ch.centers[0]) || null;
            chars.push({
              prompt: ch.char_caption || '',
              negative: (nc[i] && nc[i].char_caption) || '',
              center: ctr ? { x: ctr.x, y: ctr.y } : null,
            });
          });
          s['좌표 사용'] = c.v4_prompt.use_coords ? '켜짐' : '꺼짐';
          s['순서 사용'] = c.v4_prompt.use_order ? '켜짐' : '꺼짐';
        } else if (Array.isArray(c.characterPrompts)) {
          // 구형 다중 캐릭터 포맷
          c.characterPrompts.forEach((ch) => chars.push({
            prompt: ch.prompt || ch.caption || '',
            negative: ch.uc || ch.negative_prompt || '',
            center: ch.center || null,
          }));
        }
      }

      const r = mk('NovelAI', prompt, negative, s, c || t.Comment);
      if (chars.length) r.characters = chars;
      return r;
    },
    // ComfyUI
    (t) => {
      const pj = safeJSON(t.prompt);
      const wf = safeJSON(t.workflow);
      if (!pj && !wf) return null;
      const s = {}; const texts = [];
      const graph = pj || {};
      for (const id of Object.keys(graph)) {
        const n = graph[id];
        if (!n || !n.inputs) continue;
        if (typeof n.inputs.text === 'string' && n.inputs.text.trim()) texts.push(n.inputs.text.trim());
        if (/KSampler|SamplerCustom/i.test(n.class_type || '')) {
          for (const k of ['seed', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
            if (n.inputs[k] !== undefined) s[k] = n.inputs[k];
          }
        }
        if (/CheckpointLoader|UNETLoader/i.test(n.class_type || '')) s.model = n.inputs.ckpt_name || n.inputs.unet_name;
        if (/LoraLoader/i.test(n.class_type || '')) s['LoRA'] = n.inputs.lora_name;
        if (/EmptyLatentImage|EmptySD3/i.test(n.class_type || '')) { s.width = n.inputs.width; s.height = n.inputs.height; }
      }
      const uniq = [...new Set(texts)];
      return mk('ComfyUI', uniq[0] || '', uniq[1] || '', s, pj || wf);
    },
    // Fooocus
    (t) => {
      const c = safeJSON(t.Comment) || safeJSON(t.parameters);
      if (!c || !(c.full_prompt || c.base_model || c.fooocus_version || c.performance)) return null;
      const s = Object.assign({}, c);
      delete s.prompt; delete s.negative_prompt; delete s.full_prompt; delete s.full_negative_prompt;
      delete s.base_model; delete s.fooocus_version; delete s.loras; delete s.styles;
      if (c.base_model) s.model = c.base_model;
      if (c.fooocus_version) s['Fooocus 버전'] = c.fooocus_version;
      return mk('Fooocus', c.prompt || (Array.isArray(c.full_prompt) ? c.full_prompt.join(', ') : c.full_prompt),
        c.negative_prompt || '', s, c);
    },
    // SwarmUI / StableSwarm
    (t) => {
      const j = safeJSON(t.parameters) || safeJSON(t.sui_image_params);
      const p = j && (j.sui_image_params || (j.prompt !== undefined && j.model !== undefined ? j : null));
      if (!p) return null;
      const s = Object.assign({}, p);
      delete s.prompt; delete s.negativeprompt;
      return mk('SwarmUI', p.prompt, p.negativeprompt || p.negative_prompt, s, j);
    },
    // InvokeAI
    (t) => {
      const j = safeJSON(t.invokeai_metadata) || safeJSON(t['sd-metadata']);
      if (!j && !t.Dream) return null;
      const img = (j && (j.image || j)) || {};
      const s = Object.assign({}, img);
      delete s.prompt; delete s.negative_prompt;
      if (s.model && typeof s.model === 'object') s.model = s.model.model_name || s.model.name || flat(s.model);
      let prompt = img.positive_prompt || img.prompt || t.Dream || '';
      if (Array.isArray(prompt)) prompt = prompt.map((x) => x.prompt || x).join(', ');
      return mk('InvokeAI', prompt, img.negative_prompt || '', s, j || t.Dream);
    },
    // Draw Things (JSON in UserComment)
    (t) => {
      const j = safeJSON(t.UserComment) || safeJSON(t.Comment);
      if (!j || j.c === undefined || j.uc === undefined) return null;
      const s = Object.assign({}, j); delete s.c; delete s.uc;
      return mk('Draw Things', j.c, j.uc, s, j);
    },
    // Easy Diffusion / NMKD
    (t) => {
      const j = safeJSON(t.prompt) || safeJSON(t.Comment);
      if (!j || typeof j.prompt !== 'string' || j.num_inference_steps === undefined) return null;
      const s = Object.assign({}, j); delete s.prompt; delete s.negative_prompt;
      return mk('Easy Diffusion', j.prompt, j.negative_prompt, s, j);
    },
    // A1111 / Forge / SD.Next / reForge / Civitai
    (t) => {
      const raw = t.parameters || t.Parameters || t.UserComment || t.Description;
      if (!raw || typeof raw !== 'string') return null;
      if (!/Steps:\s*\d+|Negative prompt:/.test(raw)) return null;
      const p = parseA1111(raw);
      let name = 'Stable Diffusion (A1111 계열)';
      if (/Civitai resources/i.test(raw)) name = 'Civitai';
      if (/Version:\s*f?\d.*forge/i.test(raw)) name = 'Forge';
      const r = mk(name, p.prompt, p.negative, p.settings, raw);
      const ex = safeJSON(p.settings['Civitai resources']);
      if (ex) r.settings['Civitai 리소스'] = ex.map((x) => x.modelName || x.name || x.type).join(', ');
      return r;
    },
    // Midjourney (EXIF 기반)
    (t) => {
      const d = t.__exifDescription || '';
      const author = t.__exifArtist || '';
      if (!/Midjourney|Job ID/i.test(d + ' ' + author)) return null;
      const s = {};
      const jid = d.match(/Job ID:\s*([\w-]+)/i);
      if (jid) s['Job ID'] = jid[1];
      const ar = d.match(/--ar\s+[\d:]+/); if (ar) s['비율'] = ar[0].replace('--ar ', '');
      const v = d.match(/--v\s+[\d.]+|--niji\s*[\d.]*/); if (v) s['버전'] = v[0];
      return mk('Midjourney', d.replace(/Job ID:.*/i, '').trim(), '', s, d);
    },
  ];

  // 아무 감지기에도 안 걸릴 때: JSON/텍스트에서 프롬프트처럼 보이는 값 추출
  function genericDetect(text) {
    const PROMPT_KEYS = ['prompt', 'positive_prompt', 'positive', 'Prompt', 'description', 'caption', 'c'];
    const NEG_KEYS = ['negative_prompt', 'negativeprompt', 'negative', 'uc', 'Negative prompt'];
    for (const k of Object.keys(text)) {
      if (k.startsWith('__')) continue;
      const j = safeJSON(text[k]);
      if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
      const pk = PROMPT_KEYS.find((x) => typeof j[x] === 'string' && j[x].trim());
      if (!pk) continue;
      const nk = NEG_KEYS.find((x) => typeof j[x] === 'string');
      const s = Object.assign({}, j);
      delete s[pk]; if (nk) delete s[nk];
      return mk('생성 메타데이터 (' + k + ')', j[pk], nk ? j[nk] : '', s, j);
    }
    // 태그 나열처럼 보이는 긴 문자열
    for (const k of Object.keys(text)) {
      if (k.startsWith('__')) continue;
      const v = text[k];
      if (typeof v === 'string' && v.length > 40 && (v.match(/,/g) || []).length >= 4 && !/[<>]{2}/.test(v)) {
        return mk('텍스트 메타데이터 (' + k + ')', v, '', {}, v);
      }
    }
    return null;
  }

  function interpretGenMeta(text) {
    for (const d of DETECTORS) {
      try {
        const r = d(text);
        if (r && (r.prompt || r.negative || Object.keys(r.settings).length)) return r;
      } catch (e) { /* 다음 감지기 */ }
    }
    return genericDetect(text);
  }

  /* =========================================================
   * 8. 통합 분석
   * ======================================================= */

  async function analyze(u8, blobUrl) {
    const fmt = detectFormat(u8);
    const info = { format: fmt, size: u8.length };
    let parsed = { text: {} };

    if (fmt === 'PNG') parsed = await parsePNG(u8);
    else if (fmt === 'JPEG') parsed = parseJPEG(u8);
    else if (fmt === 'WEBP') parsed = parseWEBP(u8);
    else if (fmt === 'GIF') parsed = parseGIF(u8);
    else if (fmt === 'TIFF') parsed = { text: {}, exifChunk: u8 };

    info.width = parsed.width;
    info.height = parsed.height;
    info.bitDepth = parsed.bitDepth;
    info.colorType = parsed.colorType;
    info.hasAlpha = parsed.hasAlpha;
    if (fmt === 'JPEG') { info.colorType = info.colorType || 'YCbCr'; info.hasAlpha = false; }
    if (fmt === 'GIF') { info.colorType = info.colorType || 'Indexed'; }
    info.comments = parsed.comments;
    info.xmp = parsed.xmp;
    info.c2pa = !!parsed.c2pa;
    info.text = parsed.text || {};
    // 메타데이터를 담은 청크만 기록 (IDAT 등 픽셀 데이터는 제외)
    info.metaChunks = (parsed.chunks || []).filter((c) => /^(tEXt|zTXt|iTXt|eXIf|caBX|IHDR)$/.test(c) && c !== 'IHDR');

    if (parsed.exifChunk) {
      try { info.exif = parseTIFF(parsed.exifChunk); } catch (e) { info.exif = null; }
    }

    // EXIF 안에 들어있는 생성 정보도 감지기에 넘긴다
    if (info.exif) {
      if (info.exif.UserComment) info.text.UserComment = info.exif.UserComment;
      info.text.__exifDescription = info.exif.ImageDescription || '';
      info.text.__exifArtist = info.exif.Artist || '';
    }
    if (info.xmp) {
      const m = info.xmp.match(/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/);
      if (m) info.text.__xmpDescription = m[1];
    }

    info.gen = interpretGenMeta(info.text);

    // 알파 채널이 있는 PNG에서만 은닉 메타데이터를 확인할 가치가 있다
    info.needStealth = !info.gen && fmt === 'PNG' && info.hasAlpha === true;
    if (info.needStealth && blobUrl) {
      info.needStealth = false;
      const st = await extractStealth(blobUrl);
      if (st) {
        info.stealth = st;
        const j = safeJSON(st.text);
        if (j) {
          Object.assign(info.text, j);
          info.gen = interpretGenMeta(info.text);
        }
        if (!info.gen) info.gen = mk('은닉 메타데이터', st.text, '', {}, st.text);
        info.gen.source += ' · 알파 채널 복원';
      }
    }

    // 표시용 텍스트 청크 (내부용 __키 제외)
    info.displayText = {};
    for (const k of Object.keys(info.text)) if (!k.startsWith('__')) info.displayText[k] = info.text[k];

    return info;
  }

  /* =========================================================
   * 9. 이미지 원본 URL 후보
   * ======================================================= */

  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }

  // srcset 중 가장 큰 후보
  function fromSrcset(img) {
    const ss = img.getAttribute('srcset') || '';
    if (!ss) return null;
    let best = null, bestW = -1;
    for (const part of ss.split(',')) {
      const m = part.trim().split(/\s+/);
      if (!m[0]) continue;
      const w = m[1] ? parseFloat(m[1]) : 1;
      if (w > bestW) { bestW = w; best = m[0]; }
    }
    return best;
  }

  // 주소별로 알아낸 진짜 파일명을 기억해 둔다 (download.php 처럼 경로에 이름이 없는 경우용)
  const NAME_HINT = new Map();

  // 디시인사이드: 본문 이미지는 변환본(viewimage.php)이고,
  // 원본은 글 아래 첨부파일 목록의 download.php 에 있다.
  // 본문의 data-fileno 이미지 순서와 첨부 목록 순서가 1:1로 대응한다.
  function dcAttachmentUrl(img) {
    if (!img.hasAttribute('data-fileno')) return null;
    const body = img.closest('.write_div, .writing_view_box') || document;
    const imgs = [...body.querySelectorAll('img[data-fileno]')];
    const links = [...document.querySelectorAll('.appending_file a[href], .appending_file_box a[href]')]
      .filter((a) => /download\.php/i.test(a.getAttribute('href') || ''));
    const i = imgs.indexOf(img);
    if (i < 0 || links.length !== imgs.length || !links[i]) return null;
    const href = links[i].getAttribute('href');
    const name = (links[i].textContent || '').trim().split(/\s{2,}|\(/)[0].trim();
    const abs = absUrl(href);
    if (abs && name && /\.[a-z0-9]{2,5}$/i.test(name)) NAME_HINT.set(abs, name);
    return href;
  }

  function candidateUrls(img) {
    const set = [];
    const push = (u) => { const a = absUrl(u); if (a && !set.includes(a)) set.push(a); };

    // 0) 디시인사이드 첨부파일 원본이 있으면 그것부터
    if (IS_DC) { const at = dcAttachmentUrl(img); if (at) push(at); }

    // 1) 글에 달린 원본 링크가 가장 믿을 만하다
    const a = img.closest('a');
    if (a && a.href && /\.(png|jpe?g|gif|webp|bmp|avif)(\?|$)/i.test(a.href)) push(a.href);
    if (a && a.href && /(namu\.la|dcinside|dcimg)/i.test(a.href)) push(a.href);

    // 2) 사이트가 알려주는 원본 주소 / 지연 로딩 주소
    for (const attr of ['data-originalurl', 'data-orig', 'data-original', 'data-src', 'data-lazy-src', 'data-echo']) {
      const v = img.getAttribute(attr);
      if (v) push(v);
    }
    const ss = fromSrcset(img);
    if (ss) push(ss);

    // 3) 실제로 표시 중인 주소 (지연로딩 자리표시자는 제외)
    const src = img.getAttribute('src') || img.currentSrc || img.src;
    const isPlaceholder = src && (/nstatic\.dcinside\.com/i.test(src) || /^data:/i.test(src)
      || img.classList.contains('lazy'));
    if (src && !isPlaceholder) push(src);

    // 4) 축소본으로 보이면 원본 변형도 후보에 넣는다
    if (src && /[?&]type=/.test(src)) {
      push(src.replace(/([?&])type=[^&]*/, '$1type=orig'));
      push(src.replace(/([?&])type=[^&]*&?/, '$1').replace(/[?&]$/, ''));
    }
    if (IS_DC) {
      const oc = img.getAttribute('onclick') || (img.parentElement && img.parentElement.getAttribute('onclick')) || '';
      const m = oc.match(/https?:\/\/[^'"\s)]+/);
      if (m) push(m[0]);
      if (src) push(src.replace(/&?t=\d+/g, ''));
    }
    if (img.currentSrc) push(img.currentSrc);
    return set;
  }

  function refererFor(url) {
    if (/dcinside|dcimg/i.test(url)) return 'https://gall.dcinside.com/';
    if (/namu\.la|arca\.live/i.test(url)) return 'https://arca.live/';
    return location.origin + '/';
  }

  // headBytes 를 주면 파일 앞부분만 요청한다 (메타데이터는 대부분 파일 맨 앞에 있음)
  function fetchBytes(url, headBytes) {
    return new Promise((resolve, reject) => {
      const headers = { Referer: refererFor(url), Accept: 'image/*,*/*' };
      if (headBytes) headers.Range = 'bytes=0-' + (headBytes - 1);
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', headers, timeout: 30000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300 && r.response && r.response.byteLength > 100) {
            const u8 = new Uint8Array(r.response);
            const hdr = r.responseHeaders || '';
            const cr = hdr.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
            let fname = null;
            const cd = hdr.match(/content-disposition:\s*([^\r\n]+)/i);
            if (cd) {
              const st = cd[1].match(/filename\*=\s*UTF-8''([^;]+)/i);
              const pl = cd[1].match(/filename\s*=\s*"?([^";]+)"?/i);
              try { fname = st ? decodeURIComponent(st[1]) : (pl ? pl[1].trim() : null); } catch (e) { fname = pl ? pl[1].trim() : null; }
            }
            // 206이면 일부만 받은 것, 200이면 서버가 Range를 무시하고 전체를 준 것
            resolve({
              u8, url, filename: fname,
              partial: r.status === 206 && !!headBytes,
              total: cr ? +cr[1] : u8.length,
            });
          } else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => reject(new Error('네트워크 오류')),
        ontimeout: () => reject(new Error('시간 초과')),
      });
    });
  }

  async function fetchBest(urls, headBytes) {
    let lastErr;
    for (const u of urls) {
      try {
        const r = await fetchBytes(u, headBytes);
        if (detectFormat(r.u8) !== 'UNKNOWN') return r;
        lastErr = new Error('이미지가 아님');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('불러오기 실패');
  }

  // 같은 이미지라도 주소에 따라 메타데이터가 지워진 축소본이 오기도 한다.
  // 후보 주소를 차례로 확인해서 메타데이터가 살아있는 쪽을 고른다.
  const MAX_CANDIDATES = 4;

  function metaScore(info) {
    return (info.gen ? 8 : 0)
      + (info.exif ? 4 : 0)
      + (Object.keys(info.displayText || {}).length ? 2 : 0)
      + (info.needStealth ? 1 : 0);
  }

  async function resolveBest(urls, headBytes) {
    let best = null, lastErr = null, tried = 0;
    for (const u of urls) {
      if (tried >= MAX_CANDIDATES) break;
      let r;
      try { r = await fetchBytes(u, headBytes); } catch (e) { lastErr = e; continue; }
      if (detectFormat(r.u8) === 'UNKNOWN') { lastErr = new Error('이미지가 아님'); continue; }
      tried++;
      let info;
      try { info = await analyze(r.u8, null); } catch (e) { continue; }
      const score = metaScore(info);
      const bigger = best && (r.total || 0) > (best.res.total || 0);
      if (!best || score > best.score || (score === best.score && bigger)) best = { res: r, info, score };
      if (score >= 8) break;   // 생성 메타데이터를 찾았으면 더 볼 필요 없음
    }
    if (!best) throw lastErr || new Error('불러오기 실패');
    return best;
  }

  /* =========================================================
   * 10. 테마 감지
   * ======================================================= */

  function luminanceOf(colorStr) {
    const m = String(colorStr).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.2) return null; // 투명
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function detectTheme() {
    // 1) 사이트가 명시한 다크 모드 클래스/속성
    const root = document.documentElement, body = document.body;
    const hint = [root.className, body && body.className, root.getAttribute('data-theme') || '',
      body && body.getAttribute('data-theme') || ''].join(' ');
    if (/(^|[\s-])(dark|night|theme-dark|dark-mode|dcdark)/i.test(hint)) return 'dark';
    if (/(^|[\s-])(light|theme-light|light-mode)/i.test(hint)) return 'light';
    // 2) 실제 배경색 밝기
    for (const node of [body, root]) {
      if (!node) continue;
      const l = luminanceOf(getComputedStyle(node).backgroundColor);
      if (l !== null) return l < 0.45 ? 'dark' : 'light';
    }
    // 3) 시스템 설정
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* =========================================================
   * 11. 스타일
   * ======================================================= */

  const CSS = `
  .imv-root{
    --bg:#f7f8fb; --card:#fff; --card2:#eef1f6; --line:#e2e6ee; --line2:#eceff5;
    --fg:#1b1f26; --fg2:#59616f; --fg3:#8d95a3;
    --accent:#3b6ef0; --accent-fg:#fff; --chip:#edf1fb; --chip-fg:#33509d;
    --neg:#fdf0f2; --neg-line:#f0d2d8; --neg-fg:#8d4652;
    --stage:#e8ebf1; --thumb:#c3cad6; --thumb-h:#a3acbc;
    --shadow:0 24px 70px rgba(20,25,45,.25); --scrim:rgba(226,230,238,.78);
  }
  .imv-root.dark{
    --bg:#171a20; --card:#1d2028; --card2:#252932; --line:#30353f; --line2:#282d36;
    --fg:#e8ebf1; --fg2:#a3abb9; --fg3:#767f8d;
    --accent:#5b86f5; --accent-fg:#fff; --chip:#232b3c; --chip-fg:#9ab5ff;
    --neg:#241a1e; --neg-line:#442931; --neg-fg:#d59aa6;
    --stage:#101216; --thumb:#3c4350; --thumb-h:#4d5462;
    --shadow:0 24px 70px rgba(0,0,0,.6); --scrim:rgba(6,7,10,.8);
  }

  .imv-root{position:fixed;inset:0;z-index:2147483600;background:var(--scrim);
    display:flex;align-items:center;justify-content:center;padding:22px;
    font:14px/1.6 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",-apple-system,sans-serif;
    color:var(--fg);-webkit-font-smoothing:antialiased;}

  /* 얇고 둥근 스크롤바 */
  .imv-root ::-webkit-scrollbar{width:11px;height:11px;}
  .imv-root ::-webkit-scrollbar-track{background:transparent;}
  .imv-root ::-webkit-scrollbar-thumb{background:var(--thumb);border-radius:99px;
    border:3.5px solid transparent;background-clip:content-box;}
  .imv-root ::-webkit-scrollbar-thumb:hover{background:var(--thumb-h);background-clip:content-box;
    border:3.5px solid transparent;}
  .imv-root ::-webkit-scrollbar-corner{background:transparent;}
  .imv-root *{scrollbar-width:thin;scrollbar-color:var(--thumb) transparent;}

  .imv-card{display:grid;grid-template-columns:minmax(0,1fr) 430px;
    width:min(1180px,96vw);height:min(840px,92vh);background:var(--bg);
    border-radius:18px;overflow:hidden;box-shadow:var(--shadow);
    animation:imv-in .16s ease-out;}
  @keyframes imv-in{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}

  /* 왼쪽: 이미지 */
  .imv-stage{position:relative;background:var(--stage);display:flex;align-items:center;
    justify-content:center;overflow:hidden;min-width:0;min-height:0;}
  .imv-stage img{max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in;display:block;}
  .imv-stagebar{position:absolute;left:0;right:0;bottom:0;display:flex;gap:6px;align-items:center;
    padding:10px 12px;background:linear-gradient(to top,rgba(0,0,0,.45),transparent);
    opacity:0;transition:opacity .15s;pointer-events:none;}
  .imv-stage:hover .imv-stagebar{opacity:1;}
  .imv-stagebar span{color:#fff;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,.6);}

  /* 오른쪽: 패널 */
  .imv-side{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--card);
    border-left:1px solid var(--line);}
  .imv-shead{display:flex;align-items:center;gap:8px;padding:13px 14px 11px;}
  .imv-shead .nm{flex:1;min-width:0;font-weight:600;font-size:14px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .imv-x{width:30px;height:30px;flex:none;border:0;background:transparent;color:var(--fg3);
    border-radius:9px;font-size:19px;line-height:1;cursor:pointer;}
  .imv-x:hover{background:var(--card2);color:var(--fg);}

  .imv-badges{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 11px;}
  .imv-bdg{display:inline-flex;align-items:center;background:var(--chip);color:var(--chip-fg);
    border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;}
  .imv-bdg.plain{background:var(--card2);color:var(--fg3);font-weight:500;}

  .imv-tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);
    overflow-x:auto;flex:none;scrollbar-width:none;}
  .imv-tabs::-webkit-scrollbar{display:none;}
  .imv-tab{flex:none;border:0;background:transparent;color:var(--fg3);cursor:pointer;
    padding:9px 11px 10px;font:600 13px/1 inherit;border-bottom:2px solid transparent;
    white-space:nowrap;font-family:inherit;}
  .imv-tab:hover{color:var(--fg2);}
  .imv-tab.on{color:var(--accent);border-bottom-color:var(--accent);}
  .imv-tab .cnt{font-weight:500;opacity:.65;margin-left:4px;font-size:11.5px;}

  .imv-pane{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;padding:14px;
    display:flex;flex-direction:column;gap:12px;}
  .imv-pane>*{min-width:0;max-width:100%;}

  .imv-foot{flex:none;display:flex;gap:6px;padding:10px 14px;border-top:1px solid var(--line);
    background:var(--card);}

  /* 공용 조각 */
  .imv-sec{border:1px solid var(--line);border-radius:12px;padding:12px 13px;background:var(--bg);
    min-width:0;overflow:hidden;}
  .imv-sec>.h{display:flex;align-items:center;gap:8px;margin-bottom:9px;
    font-size:11.5px;font-weight:700;letter-spacing:.03em;color:var(--fg3);}
  .imv-sec>.h .sp{flex:1;}

  .imv-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:0;}
  .imv-item{display:flex;align-items:center;gap:10px;height:36px;
    border-bottom:1px solid var(--line2);}
  .imv-item:last-child{border-bottom:0;}
  .imv-item .k,.imv-item .v{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .imv-item .k{flex:0 0 92px;color:var(--fg3);font-size:12.5px;}
  .imv-item .v{flex:1;min-width:0;}
  .imv-item .v.empty{color:var(--fg3);}
  .imv-item.click{cursor:pointer;}
  .imv-item.click:hover{background:var(--card2);border-radius:7px;}

  .imv-tags{display:flex;flex-wrap:wrap;gap:5px;}
  .imv-tag{background:var(--chip);color:var(--chip-fg);border:0;border-radius:7px;
    padding:4px 9px;font:12.5px/1.4 inherit;cursor:pointer;text-align:left;font-family:inherit;
    max-width:100%;overflow-wrap:anywhere;}
  .imv-tag:hover{filter:brightness(.96);}
  .imv-tag:active{transform:scale(.96);}
  .imv-tag.neg{background:var(--neg);color:var(--neg-fg);border:1px solid var(--neg-line);}

  .imv-raw{white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;background:var(--card2);
    border:1px solid var(--line);border-radius:9px;padding:9px 11px;margin:8px 0 0;
    font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    max-height:260px;overflow:auto;color:var(--fg2);}

  .imv-btn{background:var(--card2);border:1px solid var(--line);color:var(--fg2);
    border-radius:8px;padding:5px 10px;font:12.5px/1.5 inherit;font-family:inherit;cursor:pointer;
    text-decoration:none;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}
  .imv-btn:hover{color:var(--fg);border-color:var(--fg3);}
  .imv-btn.on{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);}
  .imv-btn.grow{flex:1;justify-content:center;}

  /* 캐릭터 카드 */
  .imv-char{border:1px solid var(--line);border-radius:12px;padding:11px 12px;background:var(--bg);
    min-width:0;overflow:hidden;}
  .imv-char>.h{display:flex;align-items:center;gap:7px;margin-bottom:8px;}
  .imv-char .no{display:inline-flex;align-items:center;justify-content:center;
    width:20px;height:20px;border-radius:6px;background:var(--accent);color:var(--accent-fg);
    font-size:11.5px;font-weight:700;}
  .imv-char .pos{margin-left:auto;font-size:11.5px;color:var(--fg3);}
  .imv-char .sub{display:flex;align-items:center;gap:6px;margin:10px 0 5px;}
  .imv-char .sub .lbl{font-size:11px;font-weight:700;color:var(--fg3);letter-spacing:.03em;}
  .imv-char .sub .sp{flex:1;}
  .imv-btn.mini{padding:2px 8px;font-size:11.5px;border-radius:7px;}
  .imv-map{width:44px;height:44px;border:1px solid var(--line);border-radius:6px;position:relative;
    background:var(--card2);flex:none;}
  .imv-map i{position:absolute;width:8px;height:8px;border-radius:50%;background:var(--accent);
    transform:translate(-50%,-50%);}

  .imv-msg{color:var(--fg2);text-align:center;padding:30px 14px;font-size:13.5px;line-height:1.7;}
  .imv-spin{width:20px;height:20px;border:2px solid var(--line);border-top-color:var(--accent);
    border-radius:50%;animation:imv-spin .7s linear infinite;margin:0 auto 12px;}
  @keyframes imv-spin{to{transform:rotate(360deg)}}

  .imv-zoom{position:fixed;inset:0;z-index:2147483601;background:rgba(0,0,0,.93);
    cursor:zoom-out;overflow:hidden;}
  .imv-zoom img{position:absolute;transform-origin:0 0;cursor:grab;max-width:none;}

  @media (max-width:880px){
    .imv-root{padding:0;}
    .imv-card{grid-template-columns:1fr;grid-template-rows:minmax(140px,34%) minmax(0,1fr);
      width:100%;height:100%;border-radius:0;}
    .imv-side{border-left:0;border-top:1px solid var(--line);}
  }`;

  if (typeof GM_addStyle === 'function') GM_addStyle(CSS);
  else { const st = document.createElement('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }

  /* =========================================================
   * 12. UI 조각
   * ======================================================= */

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const k of Object.keys(props)) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== null && props[k] !== undefined) n.setAttribute(k, props[k]);
    }
    for (const c of kids) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  };

  function toast(msg) {
    const t = el('div', { text: msg });
    Object.assign(t.style, {
      position: 'fixed', left: '50%', bottom: '34px', transform: 'translateX(-50%)',
      background: 'rgba(28,30,36,.95)', color: '#fff', padding: '9px 16px', borderRadius: '10px',
      zIndex: 2147483647, fontSize: '13px', pointerEvents: 'none', transition: 'opacity .3s',
      fontFamily: '"Pretendard","Malgun Gothic",sans-serif',
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 1300);
  }

  function copy(text, label) {
    try { GM_setClipboard(text); }
    catch (e) { navigator.clipboard && navigator.clipboard.writeText(text); }
    toast((label || '복사') + ' 완료');
  }

  function sec(titleText, actionNode, ...kids) {
    const s = el('div', { class: 'imv-sec' });
    if (titleText) {
      const h = el('div', { class: 'h' }, titleText, el('span', { class: 'sp' }));
      if (actionNode) h.appendChild(actionNode);
      s.appendChild(h);
    }
    for (const k of kids) if (k) s.appendChild(k);
    return s;
  }

  function grid(pairs) {
    const g = el('div', { class: 'imv-grid' });
    for (const [k, v] of pairs) {
      const has = v !== undefined && v !== null && v !== '';
      const val = has ? String(v) : '—';
      const item = el('div', { class: 'imv-item' + (has ? ' click' : '') },
        el('span', { class: 'k', text: k, title: k }),
        el('span', { class: 'v' + (has ? '' : ' empty'), text: val, title: has ? val : '' }));
      if (has) item.onclick = () => copy(val, k);
      g.appendChild(item);
    }
    return g;
  }

  // 프롬프트: 태그 칩 ↔ 원문 전환
  function promptView(text, isNeg) {
    const wrap = el('div');
    const tags = text.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
    const useTags = tags.length > 0 && tags.every((t) => t.length < 90);
    const tagBox = el('div', { class: 'imv-tags' });
    if (useTags) {
      for (const t of tags) {
        tagBox.appendChild(el('button', {
          class: 'imv-tag' + (isNeg ? ' neg' : ''), text: t,
          title: '클릭하면 이 태그만 복사', onclick: () => copy(t, '태그'),
        }));
      }
      wrap.appendChild(tagBox);
    }
    const raw = el('pre', { class: 'imv-raw', text: text });
    if (useTags) raw.style.display = 'none';
    wrap.appendChild(raw);
    wrap._hasTags = useTags;
    wrap._toggleRaw = () => {
      if (!useTags) return null;
      const showing = raw.style.display !== 'none';
      raw.style.display = showing ? 'none' : '';
      tagBox.style.display = showing ? '' : 'none';
      return !showing;
    };
    return wrap;
  }

  function promptSection(title, text, isNeg) {
    const pv = promptView(text, isNeg);
    const acts = el('span', { style: 'display:flex;gap:5px' });
    if (pv._hasTags) {
      const tg = el('button', { class: 'imv-btn', text: '원문' });
      tg.onclick = () => { const on = pv._toggleRaw(); tg.classList.toggle('on', !!on); };
      acts.appendChild(tg);
    }
    acts.appendChild(el('button', { class: 'imv-btn', text: '복사', onclick: () => copy(text, title) }));
    return sec(title, acts, pv);
  }

  /* =========================================================
   * 13. 오버레이
   * ======================================================= */

  let overlay = null, zoomLayer = null, prevOverflow = '';

  function closeZoom() {
    if (!zoomLayer) return;
    if (zoomLayer._cleanup) zoomLayer._cleanup();
    zoomLayer.remove(); zoomLayer = null;
  }

  function closeOverlay() {
    closeZoom();
    if (!overlay) return;
    if (overlay._blobUrl) URL.revokeObjectURL(overlay._blobUrl);
    overlay.remove(); overlay = null;
    document.documentElement.style.overflow = prevOverflow;
  }

  function openZoom(src) {
    closeZoom();
    const layer = el('div', { class: 'imv-zoom' });
    const img = el('img', { src });
    layer.appendChild(img);
    let scale = 1, tx = 0, ty = 0, drag = false, sx = 0, sy = 0, moved = false, raf = 0;
    const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
    const fit = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w) return;
      scale = Math.min(innerWidth / w, innerHeight / h, 1) * 0.94;
      tx = (innerWidth - w * scale) / 2; ty = (innerHeight - h * scale) / 2; apply();
    };
    img.onload = fit; if (img.complete) setTimeout(fit, 0);
    layer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const ns = Math.min(CFG.maxZoom, Math.max(CFG.minZoom, scale * f));
      const px = (e.clientX - tx) / scale, py = (e.clientY - ty) / scale;
      tx = e.clientX - px * ns; ty = e.clientY - py * ns; scale = ns; apply();
    }, { passive: false });
    img.addEventListener('mousedown', (e) => {
      e.preventDefault(); drag = true; moved = false;
      sx = e.clientX - tx; sy = e.clientY - ty; img.style.cursor = 'grabbing';
    });
    // 창 전역 리스너는 확대창을 닫을 때 반드시 떼어낸다 (계속 쌓이면 느려짐)
    const onMove = (e) => {
      if (!drag) return;
      moved = true; tx = e.clientX - sx; ty = e.clientY - sy;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(); });
    };
    const onUp = () => { drag = false; img.style.cursor = 'grab'; };
    addEventListener('mousemove', onMove, { passive: true });
    addEventListener('mouseup', onUp, { passive: true });
    layer._cleanup = () => {
      removeEventListener('mousemove', onMove);
      removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
    };
    layer.addEventListener('click', () => { if (!moved) closeZoom(); });
    document.body.appendChild(layer);
    zoomLayer = layer;
  }

  function openOverlay(imgEl) {
    closeOverlay();
    const theme = detectTheme();
    const root = el('div', { class: 'imv-root' + (theme === 'dark' ? ' dark' : '') });
    const card = el('div', { class: 'imv-card' });

    const stage = el('div', { class: 'imv-stage' });
    const view = el('img', { src: imgEl.currentSrc || imgEl.src, alt: '', decoding: 'async' });
    const stagebar = el('div', { class: 'imv-stagebar' }, el('span', { text: '클릭하면 확대' }));
    stage.appendChild(view); stage.appendChild(stagebar);

    const side = el('div', { class: 'imv-side' });
    const nm = el('div', { class: 'nm', text: '불러오는 중…' });
    side.appendChild(el('div', { class: 'imv-shead' }, nm,
      el('button', { class: 'imv-x', text: '×', title: '닫기 (Esc)', onclick: closeOverlay })));
    const badges = el('div', { class: 'imv-badges' });
    const tabs = el('div', { class: 'imv-tabs' });
    const pane = el('div', { class: 'imv-pane' });
    const foot = el('div', { class: 'imv-foot' });
    side.appendChild(badges); side.appendChild(tabs); side.appendChild(pane); side.appendChild(foot);

    pane.appendChild(el('div', { class: 'imv-msg' }, el('div', { class: 'imv-spin' }), '원본을 받아 메타데이터를 읽는 중…'));

    card.appendChild(stage); card.appendChild(side);
    root.appendChild(card);
    root.addEventListener('mousedown', (e) => { if (e.target === root) closeOverlay(); });
    document.body.appendChild(root);
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    overlay = root;

    view.addEventListener('click', () => openZoom(view.currentSrc || view.src));
    run(imgEl, { root, nm, stage, view, badges, tabs, pane, foot, theme });
  }

  // 서버가 알려준 이름 > 링크에서 얻은 이름 > 주소 마지막 조각 순으로 파일명을 정한다
  function pickFileName(res) {
    const clean = (n) => (n || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (res.filename) return clean(res.filename);
    const hint = NAME_HINT.get(res.url);
    if (hint) return clean(hint);
    let base = '';
    try { base = decodeURIComponent(res.url.split('?')[0].split('/').pop() || ''); } catch (e) { base = ''; }
    // viewimage.php / download.php 처럼 경로가 파일명이 아닌 경우
    if (!base || /\.(php|asp|jsp|cgi)$/i.test(base)) return '이미지';
    return clean(base);
  }

  // 메타데이터는 대부분 파일 앞쪽에 있으므로 우선 이만큼만 받는다
  const HEAD_BYTES = 384 * 1024;
  // 앞부분에서 아무것도 못 찾았을 때 전체를 다시 확인하는 크기 한도
  // (메타데이터를 파일 뒤쪽에 붙여 저장하는 프로그램도 있다)
  const FULL_RETRY_MAX = 30 * 1024 * 1024;
  // 이보다 큰 파일은 은닉 메타데이터 검사를 자동으로 하지 않는다 (버튼으로 넘김)
  const STEALTH_AUTO_MAX = 12 * 1024 * 1024;

  async function run(imgEl, ui) {
    const urls = candidateUrls(imgEl);
    let picked;
    try { picked = await resolveBest(urls, HEAD_BYTES); }
    catch (e) {
      ui.nm.textContent = '원본을 가져오지 못했습니다';
      ui.pane.innerHTML = '';
      ui.pane.appendChild(sec(null, null,
        el('div', { class: 'imv-msg', text: e.message + ' — 사이트가 외부 접근을 막았거나 주소가 만료됐을 수 있습니다.' }),
        el('a', { class: 'imv-btn grow', href: urls[0] || '#', target: '_blank', rel: 'noreferrer', text: '원본 주소 새 탭으로 열기' })));
      return;
    }

    const res = picked.res;
    let bytes = res.u8;
    let full = !res.partial;
    let info = picked.info;

    const totalSize = res.total || bytes.length;
    const fileName = pickFileName(res);

    const getFull = async () => {
      if (!full) { const r2 = await fetchBytes(res.url); bytes = r2.u8; full = true; }
      return bytes;
    };

    // 앞부분만 받았는데 아무것도 못 찾았으면 파일 전체를 다시 살펴본다.
    // 메타데이터가 파일 끝쪽에 붙어 있는 경우가 있다.
    if (!full && !info.gen && !info.exif && totalSize <= FULL_RETRY_MAX) {
      try {
        await getFull();
        const again = await analyze(bytes, null);
        if (metaScore(again) >= metaScore(info)) info = again;
      } catch (e) { /* 앞부분 결과로 진행 */ }
    }

    // 은닉 메타데이터 확인은 파일 전체가 필요하다.
    // 파일이 크면 자동으로 받지 않고 버튼으로 넘긴다.
    const checkStealth = async () => {
      await getFull();
      const bu = URL.createObjectURL(new Blob([bytes]));
      if (ui.root._blobUrl) URL.revokeObjectURL(ui.root._blobUrl);
      ui.root._blobUrl = bu;
      ui.view.src = bu;             // 이미 받은 바이트를 표시에도 재사용
      const next = await analyze(bytes, bu);
      next.size = totalSize;
      render(ui, next, res, fileName, ctx);
    };

    if (info.needStealth) {
      if (totalSize <= STEALTH_AUTO_MAX) {
        await getFull();
        const bu = URL.createObjectURL(new Blob([bytes]));
        ui.root._blobUrl = bu;
        ui.view.src = bu;          // 이미 받은 바이트를 표시에도 재사용 (중복 다운로드 없음)
        info = await analyze(bytes, bu);
      } else {
        info.stealthDeferred = totalSize;
      }
    }
    // 전체를 받지 않았다면 원본 주소로 표시 (브라우저 캐시를 탄다)
    if (!ui.root._blobUrl) ui.view.src = res.url;
    info.size = totalSize;

    ui.nm.textContent = fileName;
    ui.nm.title = res.url;

    const ctx = {
      url: res.url, fileName, checkStealth,
      async download() {
        // 확장프로그램 환경에서는 브라우저 기본 다운로드를 쓴다 (전체 전송 불필요)
        const hook = typeof window !== 'undefined' && window.__imvDownload;
        if (hook) { hook(res.url, fileName); return; }
        await getFull();
        const bu = URL.createObjectURL(new Blob([bytes]));
        const a = el('a', { href: bu, download: fileName });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(bu), 10000);
      },
    };
    render(ui, info, res, fileName, ctx);
  }

  /* =========================================================
   * 14. 탭 구성
   * ======================================================= */

  function render(ui, info, res, fileName, ctx) {
    const gen = info.gen;
    const chars = (gen && gen.characters) || [];

    // 배지
    ui.badges.innerHTML = '';
    ui.badges.appendChild(el('span', {
      class: 'imv-bdg' + (gen ? '' : ' plain'), text: gen ? gen.source : '생성 메타데이터 없음',
    }));
    if (chars.length) ui.badges.appendChild(el('span', { class: 'imv-bdg plain', text: `캐릭터 ${chars.length}` }));
    if (info.exif) ui.badges.appendChild(el('span', { class: 'imv-bdg plain', text: 'EXIF' }));
    if (info.c2pa) ui.badges.appendChild(el('span', { class: 'imv-bdg plain', text: 'C2PA' }));
    ui.badges.appendChild(el('span', {
      class: 'imv-bdg plain',
      text: `${info.format} · ${info.width || '?'}×${info.height || '?'} · ${bytesHuman(info.size)}`,
    }));

    // 이미지 위 정보줄
    ui.stage.querySelector('.imv-stagebar').firstChild.textContent =
      `${info.width || '?'} × ${info.height || '?'} · 클릭하면 확대`;

    // 하단 버튼
    ui.foot.innerHTML = '';
    ui.foot.appendChild(el('button', { class: 'imv-btn grow', text: '주소 복사', onclick: () => copy(res.url, '주소') }));
    const saveBtn = el('button', { class: 'imv-btn grow', text: '이미지 저장' });
    saveBtn.onclick = async () => {
      saveBtn.textContent = '받는 중…'; saveBtn.disabled = true;
      try { await ctx.download(); toast('저장 시작'); }
      catch (e) { toast('저장 실패'); }
      saveBtn.textContent = '이미지 저장'; saveBtn.disabled = false;
    };
    ui.foot.appendChild(saveBtn);
    ui.foot.appendChild(el('button', { class: 'imv-btn grow', text: '전체 복사', onclick: () => copy(report(info, res), '전체 정보') }));

    // ── 탭 정의 ──────────────────────────────────────────
    const TABS = [];

    if (gen && (gen.prompt || gen.negative)) {
      TABS.push({ name: '프롬프트', build: () => {
        const f = document.createDocumentFragment();
        if (gen.prompt) f.appendChild(promptSection(chars.length ? '공통 프롬프트' : '프롬프트', gen.prompt, false));
        if (gen.negative) f.appendChild(promptSection(chars.length ? '공통 네거티브' : '네거티브 프롬프트', gen.negative, true));
        return f;
      } });
    }

    if (chars.length) {
      TABS.push({ name: '캐릭터', count: chars.length, build: () => {
        const f = document.createDocumentFragment();
        chars.forEach((ch, i) => {
          const box = el('div', { class: 'imv-char' });
          const head = el('div', { class: 'h' },
            el('span', { class: 'no', text: String(i + 1) }),
            el('span', { style: 'font-size:12.5px;font-weight:600', text: `캐릭터 ${i + 1}` }));
          if (ch.center) {
            head.appendChild(el('span', {
              class: 'pos', text: `위치 ${(ch.center.x * 100).toFixed(0)}%, ${(ch.center.y * 100).toFixed(0)}%`,
            }));
            const map = el('div', { class: 'imv-map' });
            const dot = el('i');
            dot.style.left = (ch.center.x * 100) + '%';
            dot.style.top = (ch.center.y * 100) + '%';
            map.appendChild(dot);
            head.appendChild(map);
          } else {
            head.appendChild(el('span', { class: 'pos', text: '위치 지정 없음' }));
          }
          box.appendChild(head);

          const addSub = (label, text, isNeg) => {
            const pv = promptView(text, isNeg);
            const row = el('div', { class: 'sub' },
              el('span', { class: 'lbl', text: label }), el('span', { class: 'sp' }));
            if (pv._hasTags) {
              const tg = el('button', { class: 'imv-btn mini', text: '원문' });
              tg.onclick = () => { const on = pv._toggleRaw(); tg.classList.toggle('on', !!on); };
              row.appendChild(tg);
            }
            row.appendChild(el('button', {
              class: 'imv-btn mini', text: '복사',
              onclick: () => copy(text, `캐릭터 ${i + 1} ${label}`),
            }));
            box.appendChild(row);
            box.appendChild(pv);
          };
          if (ch.prompt) addSub('프롬프트', ch.prompt, false);
          if (ch.negative) addSub('네거티브', ch.negative, true);
          box.appendChild(el('div', { style: 'display:flex;gap:5px;margin-top:9px' },
            el('button', { class: 'imv-btn grow', text: '이 캐릭터 복사',
              onclick: () => copy(ch.prompt + (ch.negative ? '\n\n[네거티브]\n' + ch.negative : ''), `캐릭터 ${i + 1}`) })));
          f.appendChild(box);
        });
        f.appendChild(el('button', {
          class: 'imv-btn grow', text: '캐릭터 전체 복사',
          onclick: () => copy(chars.map((ch, i) =>
            `[캐릭터 ${i + 1}]\n${ch.prompt}${ch.negative ? '\n네거티브: ' + ch.negative : ''}`).join('\n\n'), '캐릭터 전체'),
        }));
        return f;
      } });
    }

    if (gen && Object.keys(gen.settings || {}).length) {
      TABS.push({ name: '설정', build: () => {
        const f = document.createDocumentFragment();
        const core = ['모델', '스텝', '샘플러', 'CFG', '시드'];
        f.appendChild(sec('주요 설정', null, grid(core.map((k) => [k, gen.settings[k]]))));
        const rest = Object.entries(gen.settings).filter(([k]) => !core.includes(k));
        if (rest.length) f.appendChild(sec(`그 밖의 설정 ${rest.length}개`, null, grid(rest)));
        return f;
      } });
    }

    if (info.exif) {
      TABS.push({ name: '촬영', build: () => {
        const e = info.exif;
        const f = document.createDocumentFragment();
        const fmt = (v, fn) => (v === undefined || v === null || v === '' ? '' : fn(v));
        f.appendChild(sec('카메라', null, grid([
          ['카메라', [e.Make, e.Model].filter(Boolean).join(' ')],
          ['렌즈', e.LensModel || e.LensMake],
          ['촬영일시', (e.DateTimeOriginal || e.DateTime || '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')],
          ['편집 앱', e.Software],
        ])));
        f.appendChild(sec('노출', null, grid([
          ['셔터', fmt(e.ExposureTime, (v) => (v < 1 ? `1/${Math.round(1 / v)}초` : `${v}초`))],
          ['조리개', fmt(e.FNumber, (v) => 'f/' + (+v).toFixed(1))],
          ['ISO', e.ISO],
          ['초점거리', fmt(e.FocalLength, (v) => `${(+v).toFixed(0)}mm`)],
          ['노출보정', fmt(e.ExposureBias, (v) => `${v > 0 ? '+' : ''}${v} EV`)],
          ['플래시', fmt(e.Flash, (v) => (v & 1 ? '발광' : '미발광'))],
          ['화이트밸런스', fmt(e.WhiteBalance, (v) => (v === 0 ? '자동' : '수동'))],
          ['방향', fmt(e.Orientation, (v) => ORIENTATION[v] || v)],
        ])));
        if (e.GPSLatitude && e.GPSLongitude) {
          const dms = (a) => (Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : +a);
          const lat = dms(e.GPSLatitude) * (e.GPSLatitudeRef === 'S' ? -1 : 1);
          const lon = dms(e.GPSLongitude) * (e.GPSLongitudeRef === 'W' ? -1 : 1);
          const coord = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
          f.appendChild(sec('위치', null, grid([['좌표', coord]]),
            el('div', { style: 'display:flex;gap:5px;margin-top:9px' },
              el('a', { class: 'imv-btn grow', target: '_blank', rel: 'noreferrer',
                href: `https://www.google.com/maps?q=${lat},${lon}`, text: '지도에서 보기' }),
              el('button', { class: 'imv-btn grow', text: '좌표 복사', onclick: () => copy(coord, '좌표') }))));
        }
        return f;
      } });
    }

    TABS.push({ name: '파일', build: () => {
      const f = document.createDocumentFragment();
      const fileSec = sec('파일', null, grid([
        ['파일명', fileName],
        ['형식', info.format],
        ['해상도', info.width && info.height ? `${info.width} × ${info.height}` : ''],
        ['용량', bytesHuman(info.size)],
        ['색상', info.colorType],
        ['투명도', info.hasAlpha === undefined ? '' : (info.hasAlpha ? '있음' : '없음')],
        ['비트 심도', info.bitDepth ? info.bitDepth + ' bit' : ''],
      ]));
      // 파일명은 길면 잘리므로 전체를 따로 한 번 더 보여준다
      if (fileName.length > 24) {
        fileSec.appendChild(el('pre', { class: 'imv-raw', text: fileName, style: 'max-height:none' }));
      }
      f.appendChild(fileSec);
      f.appendChild(sec('주소',
        el('button', { class: 'imv-btn', text: '복사', onclick: () => copy(res.url, '주소') }),
        el('pre', { class: 'imv-raw', text: res.url })));
      return f;
    } });

    const keys = Object.keys(info.displayText || {});
    const rawItems = [];
    if (keys.length) rawItems.push(['저장된 원본 텍스트', keys.map((k) => `[${k}]\n${info.displayText[k]}`).join('\n\n')]);
    if (info.comments && info.comments.length) rawItems.push(['이미지 주석', info.comments.join('\n')]);
    if (info.xmp) rawItems.push(['XMP', info.xmp]);
    if (info.exif) rawItems.push(['EXIF 전체', Object.entries(info.exif).map(([k, v]) => `${k}: ${v}`).join('\n')]);
    if (info.stealth) rawItems.push(['알파 채널 은닉 데이터', info.stealth.magic + '\n\n' + info.stealth.text]);

    if (rawItems.length) {
      TABS.push({ name: '원본', build: () => {
        const f = document.createDocumentFragment();
        for (const [t, bodyText] of rawItems) {
          f.appendChild(sec(t,
            el('button', { class: 'imv-btn', text: '복사', onclick: () => copy(bodyText, t) }),
            el('pre', { class: 'imv-raw', text: bodyText })));
        }
        return f;
      } });
    }

    if (info.stealthDeferred) {
      TABS.unshift({ name: '숨은 정보', build: () => {
        const btn = el('button', { class: 'imv-btn grow', text: `알파 채널 확인하기 (${bytesHuman(info.stealthDeferred)} 내려받기)` });
        btn.onclick = async () => {
          btn.textContent = '확인 중…'; btn.disabled = true;
          try { await ctx.checkStealth(); }
          catch (e) { btn.textContent = '실패 — 다시 시도'; btn.disabled = false; }
        };
        return sec(null, null,
          el('div', { class: 'imv-msg', text: '이 PNG는 알파 채널에 메타데이터가 숨어 있을 수 있습니다. 확인하려면 파일 전체를 받아야 해서, 용량이 커 자동으로 진행하지 않았습니다.' }),
          btn);
      } });
    }

    if (!gen && !info.exif && !keys.length && !info.stealthDeferred) {
      TABS.unshift({ name: '안내', build: () => sec(null, null, el('div', {
        class: 'imv-msg',
        text: '이 이미지에는 남아있는 메타데이터가 없습니다. 업로드 과정에서 이미지가 다시 저장되면서 지워졌을 가능성이 큽니다.',
      })) });
    }

    // ── 탭 렌더 ─────────────────────────────────────────
    ui.tabs.innerHTML = '';
    const cache = {};
    const scrollPos = {};
    let current = -1;
    const show = (i) => {
      if (i === current) return;
      // 떠나는 탭의 스크롤 위치 기억
      if (current >= 0) scrollPos[current] = ui.pane.scrollTop;
      [...ui.tabs.children].forEach((b, k) => b.classList.toggle('on', k === i));
      // DocumentFragment는 한 번 붙이면 비워지므로 실제 요소로 감싸 캐시한다
      if (!cache[i]) {
        const box = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
        box.appendChild(TABS[i].build());
        cache[i] = box;
      }
      ui.pane.replaceChildren(cache[i]);
      ui.pane.scrollTop = scrollPos[i] || 0;
      current = i;
    };
    TABS.forEach((t, i) => {
      const b = el('button', { class: 'imv-tab' }, t.name);
      if (t.count) b.appendChild(el('span', { class: 'cnt', text: String(t.count) }));
      b.onclick = () => show(i);
      ui.tabs.appendChild(b);
    });
    show(0);

    // 좌우 방향키로 탭 이동
    ui.root._tabMove = (d) => {
      const cur = [...ui.tabs.children].findIndex((b) => b.classList.contains('on'));
      const next = (cur + d + TABS.length) % TABS.length;
      show(next);
    };
  }

  function report(info, res) {
    const L = ['[주소] ' + res.url,
      `[파일] ${info.format} · ${info.width}×${info.height} · ${bytesHuman(info.size)}`];
    if (info.gen) {
      L.push('', '[' + info.gen.source + ']');
      if (info.gen.prompt) L.push('프롬프트:\n' + info.gen.prompt);
      if (info.gen.negative) L.push('네거티브:\n' + info.gen.negative);
      (info.gen.characters || []).forEach((ch, i) => {
        L.push('', `[캐릭터 ${i + 1}]${ch.center ? ` (위치 ${(ch.center.x * 100).toFixed(0)}%, ${(ch.center.y * 100).toFixed(0)}%)` : ''}`);
        if (ch.prompt) L.push(ch.prompt);
        if (ch.negative) L.push('네거티브: ' + ch.negative);
      });
      const st = Object.entries(info.gen.settings || {});
      if (st.length) L.push('', '설정:\n' + st.map(([k, v]) => `  ${k}: ${v}`).join('\n'));
    }
    if (info.exif) {
      L.push('', '[EXIF]');
      for (const [k, v] of Object.entries(info.exif)) L.push(`  ${k}: ${v}`);
    }
    return L.join('\n');
  }

  addEventListener('keydown', (e) => {
    if (zoomLayer && e.key === 'Escape') { e.preventDefault(); closeZoom(); return; }
    if (!overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
    else if (e.key === 'ArrowRight' && overlay._tabMove) { e.preventDefault(); overlay._tabMove(1); }
    else if (e.key === 'ArrowLeft' && overlay._tabMove) { e.preventDefault(); overlay._tabMove(-1); }
  }, true);

  /* =========================================================
   * 15. 클릭 후킹
   * ======================================================= */

  const CONTENT_SEL = IS_ARCA
    ? '.article-content, .article-body, .fr-view, .comment-content, .body'
    : '.write_div, .writing_view_box, .thum-txtin, .gallview_contents, .view_content_wrap, .memo_img';

  // 디시콘 / 아카콘 / 프로필·아이콘류 판별
  const STICKER_URL = /dccon\.php|\/dccon|emoticon|sticker|\/nickicon|gallog|\/images\/(?:common|icon)/i;
  const STICKER_CLS = /emoticon|dccon|sticker|avatar|profile|badge|thumb(?:nail)?-?icon|(?:^|[-_ ])icons?(?:[-_ ]|$)/i;
  const STICKER_SEL = [
    '.emoticon', '.emoticon-wrapper', '.vc-emoticon',        // 아카라이브
    '.written_dccon', '.dccon', '.comment_dccon', '.dccon_img', // 디시인사이드
    '.avatar', '.profile-image', '.gall_profile', '.nick_img',
  ].join(', ');

  function looksLikeSticker(img) {
    const url = img.currentSrc || img.src || '';
    if (STICKER_URL.test(url)) return true;
    if (img.closest(STICKER_SEL)) return true;
    if (/디시콘|아카콘|이모티콘|emoticon|dccon/i.test((img.alt || '') + ' ' + (img.title || ''))) return true;
    // 상위 4단계까지 클래스/아이디 확인
    let n = img, d = 0;
    while (n && d < 4) {
      const cls = (n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className) || '';
      if (STICKER_CLS.test(cls + ' ' + (n.id || ''))) return true;
      n = n.parentElement; d++;
    }
    return false;
  }

  function isTargetImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (img.closest('.imv-root, .imv-zoom')) return false;
    // 지연 로딩 중인 이미지는 크기가 0/16으로 잡히므로 여러 값 중 가장 큰 것을 쓴다
    const r = img.getBoundingClientRect();
    const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0, r.width || 0, +(img.getAttribute('width') || 0));
    const h = Math.max(img.naturalHeight || 0, img.clientHeight || 0, r.height || 0, +(img.getAttribute('height') || 0));
    if (w > 0 && h > 0 && w < 50 && h < 50) return false;
    if (CFG.skipStickers && looksLikeSticker(img)) return false;
    if (img.closest(CONTENT_SEL)) return true;
    return /namu\.la|dcimg|dcinside\.com\/viewimage/i.test(img.currentSrc || img.src || '');
  }

  // Alt+클릭은 어떤 방식이든 항상 열기 (콘·아이콘도 강제로)
  function isAlt(e) { return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey; }

  // kind: 'click' | 'dblclick' — 지금 설정된 방식과 맞을 때만 연다
  function canOpen(img, e, kind) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (img.closest('.imv-root, .imv-zoom')) return false;
    if (isAlt(e)) return true;                       // Alt+클릭은 어느 설정에서든 열림
    if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
    if (CFG.openOn !== kind) return false;
    return isTargetImage(img);
  }

  // 더블클릭 방식일 때 첫 클릭으로 사이트가 반응해버리는 걸 막는다
  function shouldSwallowClick(img, e) {
    if (isAlt(e)) return true;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
    if (CFG.openOn === 'dblclick') return isTargetImage(img);
    return false;
  }

  const inViewer = (t) => (overlay && overlay.contains(t)) || (zoomLayer && zoomLayer.contains(t));

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

  document.addEventListener('click', (e) => {
    if (e.button !== 0 || inViewer(e.target)) return;
    const img = e.target.closest && e.target.closest('img');
    if (!img) return;
    if (canOpen(img, e, 'click')) { stop(e); openOverlay(img); return; }
    if (shouldSwallowClick(img, e)) stop(e);      // 더블클릭 대기
  }, true);

  document.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || inViewer(e.target)) return;
    const img = e.target.closest && e.target.closest('img');
    if (!img || !canOpen(img, e, 'dblclick')) return;
    stop(e);
    openOverlay(img);
  }, true);

  // Alt+클릭이 브라우저 기본 동작(링크 저장 등)으로 새거나, 더블클릭이 글자 선택으로 번지는 걸 막는다
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || inViewer(e.target)) return;
    const img = e.target.closest && e.target.closest('img');
    if (!img) return;
    if (canOpen(img, e, 'click') || canOpen(img, e, 'dblclick') || shouldSwallowClick(img, e)) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  document.addEventListener('dragstart', (e) => {
    if (!isAlt(e) || inViewer(e.target)) return;
    if (e.target && e.target.tagName === 'IMG') e.preventDefault();
  }, true);

  if (typeof GM_registerMenuCommand === 'function') {
    const MODES = [
      ['alt', 'Alt+클릭으로 엽니다 — 평소 클릭은 사이트 원래 동작 그대로'],
      ['dblclick', '더블클릭으로 엽니다 — 한 번 클릭은 아무 일도 일어나지 않습니다'],
      ['click', '그냥 클릭으로 엽니다 — 사이트 기본 동작을 가로챕니다'],
    ];
    GM_registerMenuCommand('여는 방법 바꾸기 (Alt+클릭 → 더블클릭 → 클릭)', () => {
      const i = MODES.findIndex(([m]) => m === CFG.openOn);
      const next = MODES[(i + 1) % MODES.length];
      CFG.openOn = next[0];
      store.set('openOn', CFG.openOn);
      toast(next[1]);
    });
    GM_registerMenuCommand('디시콘·아카콘 제외 켜기/끄기', () => {
      CFG.skipStickers = !CFG.skipStickers;
      store.set('skipStickers', CFG.skipStickers);
      toast('콘·아이콘 제외 ' + (CFG.skipStickers ? '켜짐 (게시글 사진만)' : '꺼짐 (전부 분석)')
        + ' · Alt+클릭은 언제나 열립니다');
    });
  }

  try {
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__imvDebug =
      { CFG, store, analyze, parsePNG, parseJPEG, parseWEBP, parseTIFF, detectFormat, interpretGenMeta, parseA1111, detectTheme, looksLikeSticker, isTargetImage };
  } catch (e) {}
})();
