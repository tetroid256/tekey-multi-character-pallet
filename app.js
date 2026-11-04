/*
 * app.js — 画面と保存・送信
 */
(function () {
  'use strict';

  const { parseDefs, makeResolver, processLine, processText, tryEval } = window.Engine;
  const { fromTekeyPalettes, fromYtsheet, ytsheetJsonUrl, normalizeColor, defaultMods } = window.Importers;

  const STORAGE_KEY = 'tekey-multi-palette:v1';
  const SETTINGS_TAB = '__settings';
  const SECRET_KEYS = ['apiKey', 'roomPassword'];

  const SETTINGS_VERSION = 2;
  // https://helps.tekey.jp/api-about/ の sendChat 仕様に合わせた既定値
  const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    sendMode: 'copy',
    copyOnFail: true,
    clickAction: 'fill',
    withName: true,
    isDirection: false,
    endpoint: 'https://tekey.jp/api',
    apiKey: '',
    roomId: '',
    roomPassword: '',
    tab: '',
    system: '',
    method: 'POST',
    readResponse: false,
    params: {
      apiKey: 'apikey',
      command: 'command',
      commandValue: 'sendChat',
      roomId: 'room',
      roomPassword: 'password',
      message: 'message',
      name: 'name',
      color: 'color',
      tab: 'tab',
      system: 'bot',
      isDirection: 'isDirection',
    },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const uid = () => Math.random().toString(36).slice(2, 10);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------------ *
   * 状態
   * ------------------------------------------------------------------ */

  function normChar(c) {
    c = c || {};
    return {
      id: c.id || uid(),
      name: c.name || '名無し',
      color: normalizeColor(c.color || '#000000'),
      tab: c.tab || '',
      ytsheetUrl: c.ytsheetUrl || '',
      fixedText: c.fixedText || '',
      mods: (Array.isArray(c.mods) ? c.mods : []).map((m) => ({ k: String(m.k), v: String(m.v ?? '0'), d: String(m.d ?? m.v ?? '0') })),
      palettes: (Array.isArray(c.palettes) ? c.palettes : []).map((p) => ({ id: p.id || uid(), label: p.label || 'パレット', text: p.text || '' })),
      currentPalette: c.currentPalette || null,
    };
  }

  function normState(s) {
    s = s || {};
    const saved = s.settings || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if ((saved.version || 1) < 2) {
      // v1 は API パラメータ名が仮の値だったので、正式な仕様の値に置き換える
      settings.params = Object.assign({}, DEFAULT_SETTINGS.params);
      settings.withName = saved.nameMode !== 'none';
      delete settings.nameMode;
      delete settings.colorHash;
      settings.version = SETTINGS_VERSION;
    } else {
      settings.params = Object.assign({}, DEFAULT_SETTINGS.params, saved.params || {});
    }
    const characters = (Array.isArray(s.characters) ? s.characters : []).map(normChar);
    return {
      settings,
      characters,
      currentId: characters.some((c) => c.id === s.currentId) ? s.currentId : (characters[0] && characters[0].id) || null,
      log: Array.isArray(s.log) ? s.log.slice(0, 100) : [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normState(JSON.parse(raw));
    } catch (e) {
      console.warn(e);
    }
    return normState({});
  }

  let state = load();
  let saveTimer = null;
  const ui = { editingPalette: false, editingMods: false };

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        toast('ブラウザへの保存に失敗しました: ' + e.message, 'error');
      }
    }, 150);
  }
  window.addEventListener('beforeunload', () => {
    if (saveTimer) { clearTimeout(saveTimer); try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
  });

  const current = () => state.characters.find((c) => c.id === state.currentId) || null;

  /* ------------------------------------------------------------------ *
   * 変数解決
   * ------------------------------------------------------------------ */

  function varMap(ch) {
    const m = new Map();
    for (const [k, v] of parseDefs(ch.fixedText)) m.set(k, v);
    for (const p of ch.palettes) {
      for (const line of p.text.split(/\r?\n/)) {
        const d = line.trim().match(/^\/\/([^=]+)=(.*)$/);
        if (d) m.set(d[1].trim(), d[2].trim());
      }
    }
    for (const md of ch.mods) m.set(md.k, md.v === '' ? '0' : md.v);
    return m;
  }

  const resolverFor = (ch) => makeResolver(varMap(ch));

  /* ------------------------------------------------------------------ *
   * 描画
   * ------------------------------------------------------------------ */

  function renderAll() {
    const has = state.characters.length > 0;
    $('#layout').hidden = !has;
    $('#emptyState').hidden = has;
    renderModeIndicator();
    renderCharTabs();
    if (!has) return;
    renderPaletteTabs();
    renderPaletteBody();
    renderMods();
    renderComposerPreview();
    renderLog();
  }

  function renderModeIndicator() {
    const s = state.settings;
    const el = $('#modeIndicator');
    if (s.sendMode === 'api') {
      const ready = s.apiKey && s.roomId && s.roomPassword;
      el.textContent = ready ? 'API 送信' : 'API 送信（未設定）';
      el.className = 'mode-indicator ' + (ready ? 'ok' : 'warn');
    } else {
      el.textContent = 'コピー送信';
      el.className = 'mode-indicator';
    }
  }

  function renderCharTabs() {
    const nav = $('#charTabs');
    nav.innerHTML = state.characters.map((c) => `
      <button type="button" class="char-tab${c.id === state.currentId ? ' active' : ''}" data-id="${c.id}" style="--char-color:${esc(c.color)}">
        <span class="swatch"></span>${esc(c.name)}
      </button>`).join('') +
      '<button type="button" class="char-tab add" data-action="addChar" title="キャラを追加">＋</button>';
  }

  function renderPaletteTabs() {
    const ch = current();
    if (!ch) return;
    if (!ch.currentPalette || (ch.currentPalette !== SETTINGS_TAB && !ch.palettes.some((p) => p.id === ch.currentPalette))) {
      ch.currentPalette = ch.palettes[0] ? ch.palettes[0].id : SETTINGS_TAB;
    }
    $('#paletteTabs').innerHTML = ch.palettes.map((p) => `
      <button type="button" role="tab" class="ptab${p.id === ch.currentPalette ? ' active' : ''}" data-id="${p.id}">${esc(p.label)}</button>`).join('') +
      '<button type="button" class="ptab add" data-action="addPalette" title="パレットを追加">＋</button>' +
      `<button type="button" role="tab" class="ptab settings${ch.currentPalette === SETTINGS_TAB ? ' active' : ''}" data-id="${SETTINGS_TAB}">キャラ設定・固定値</button>`;
  }

  function renderPaletteBody() {
    const ch = current();
    const body = $('#paletteBody');
    if (!ch) { body.innerHTML = ''; return; }
    if (ch.currentPalette === SETTINGS_TAB) return renderCharSettings(ch, body);
    const p = ch.palettes.find((x) => x.id === ch.currentPalette);
    if (!p) { body.innerHTML = '<p class="hint pad">パレットがありません。「＋」で追加してください。</p>'; return; }

    if (ui.editingPalette) {
      body.innerHTML = `
        <div class="editor">
          <div class="editor-head">
            <label>タブ名 <input type="text" id="palLabel" value="${esc(p.label)}"></label>
            <div class="spacer"></div>
            <button type="button" data-action="movePalette" data-dir="-1" title="左へ">◀</button>
            <button type="button" data-action="movePalette" data-dir="1" title="右へ">▶</button>
            <button type="button" class="danger" data-action="deletePalette">削除</button>
            <button type="button" class="primary" data-action="doneEdit">完了</button>
          </div>
          <textarea id="palText" class="code" spellcheck="false">${esc(p.text)}</textarea>
          <p class="hint">1 行 = 1 つの送信内容。<code>{変数名}</code> は固定値・バフデバフの値に置き換わります。<code>■</code> で始まる行は見出しになります。</p>
        </div>`;
      $('#palText').focus();
      return;
    }

    const res = resolverFor(ch);
    const rows = [];
    p.text.split(/\r?\n/).forEach((raw, idx) => {
      const t = raw.trim();
      if (!t) { rows.push('<li class="gap"></li>'); return; }
      if (/^\/\/[^=]+=/.test(t) || /^###/.test(t)) return;
      if (t.startsWith('■')) { rows.push(`<li class="heading">${esc(res.subst(t.slice(1), ''))}</li>`); return; }
      const r = processLine(raw, res);
      const warn = r.isCommand && r.missing.length ? `<span class="warn-badge" title="未定義の変数: ${esc(r.missing.join(', '))}">未定義: ${esc(r.missing.join(', '))}</span>` : '';
      rows.push(`
        <li class="line${r.isCommand ? ' cmd' : ''}" data-idx="${idx}">
          <button type="button" class="line-main" data-action="lineClick" title="${esc(raw)}">${esc(r.text)}${warn}</button>
          <button type="button" class="line-send" data-action="lineSend" title="すぐに送信">▶</button>
        </li>`);
    });
    body.innerHTML = `
      <div class="palette-toolbar">
        <span class="hint">クリック: ${state.settings.clickAction === 'send' ? '即送信' : '入力欄へ'}（Shift+クリックで逆）</span>
        <div class="spacer"></div>
        <button type="button" data-action="editPalette">パレットを編集</button>
      </div>
      <ul class="lines">${rows.join('')}</ul>`;
  }

  function renderCharSettings(ch, body) {
    const res = resolverFor(ch);
    const defs = parseDefs(ch.fixedText);
    const preview = defs.map(([k]) => {
      const v = res.value(k);
      return `<tr><th>${esc(k)}</th><td>${esc(v === null ? '（循環参照）' : v)}</td></tr>`;
    }).join('');
    body.innerHTML = `
      <div class="char-settings">
        <div class="grid2">
          <label class="field">キャラ名（送信時の名前）<input type="text" id="chName" value="${esc(ch.name)}"></label>
          <label class="field">文字色
            <span class="color-row"><input type="color" id="chColor" value="${esc(ch.color)}"><input type="text" id="chColorText" value="${esc(ch.color)}" maxlength="7"></span>
          </label>
          <label class="field">送信先タブ（空欄で設定の既定）<input type="text" id="chTab" value="${esc(ch.tab)}"></label>
          <label class="field">ゆとシート URL
            <span class="color-row"><input type="url" id="chYtUrl" value="${esc(ch.ytsheetUrl)}" placeholder="https://..."><button type="button" data-action="ytReimport">再取込</button></span>
          </label>
        </div>
        <div class="fixed-wrap">
          <div class="fixed-edit">
            <h3>固定値 <span class="hint">（1 行に <code>名前=値</code>。<code>#</code> で始まる行はコメント）</span></h3>
            <textarea id="chFixed" class="code" spellcheck="false">${esc(ch.fixedText)}</textarea>
          </div>
          <div class="fixed-preview">
            <h3>計算結果</h3>
            <div class="table-scroll"><table class="vars">${preview || '<tr><td class="hint">まだありません</td></tr>'}</table></div>
          </div>
        </div>
        <div class="danger-zone">
          <button type="button" data-action="moveChar" data-dir="-1">◀ タブを左へ</button>
          <button type="button" data-action="moveChar" data-dir="1">タブを右へ ▶</button>
          <button type="button" data-action="duplicateChar">複製</button>
          <div class="spacer"></div>
          <button type="button" class="danger" data-action="deleteChar">このキャラを削除</button>
        </div>
      </div>`;
  }

  function renderMods() {
    const ch = current();
    const body = $('#modsBody');
    $('#btnModsEdit').textContent = ui.editingMods ? '完了' : '編集';
    $('#btnModsReset').hidden = ui.editingMods;
    if (!ch) { body.innerHTML = ''; return; }
    if (ui.editingMods) {
      const text = ch.mods.map((m) => `${m.k}=${m.d}`).join('\n');
      body.innerHTML = `
        <textarea id="modsText" class="code" rows="12" spellcheck="false">${esc(text)}</textarea>
        <p class="hint">1 行に <code>名前=初期値</code>。パレットからは <code>{名前}</code> で参照します。今の値は名前が同じなら引き継がれます。</p>`;
      return;
    }
    if (!ch.mods.length) {
      body.innerHTML = '<p class="hint">修正値がありません。「編集」で追加してください。</p>';
      return;
    }
    body.innerHTML = '<div class="mods">' + ch.mods.map((m, i) => {
      const changed = m.v !== m.d;
      const numeric = tryEval(m.v === '' ? '0' : m.v) !== null;
      return `
        <div class="mod${changed ? ' changed' : ''}" data-i="${i}">
          <span class="mod-name" title="{${esc(m.k)}}">${esc(m.k)}</span>
          <button type="button" class="step" data-action="modStep" data-d="-1"${numeric ? '' : ' disabled'}>−</button>
          <input type="text" class="mod-input" inputmode="numeric" value="${esc(m.v)}" aria-label="${esc(m.k)}">
          <button type="button" class="step" data-action="modStep" data-d="1"${numeric ? '' : ' disabled'}>＋</button>
        </div>`;
    }).join('') + '</div>';
  }

  function renderComposerPreview() {
    const ch = current();
    const input = $('#composerInput');
    const out = $('#composerPreview');
    const raw = input.value;
    if (!ch || !raw.trim()) { out.innerHTML = ''; out.hidden = true; return; }
    const r = processText(raw, resolverFor(ch));
    out.hidden = false;
    out.innerHTML = `<span class="label">送信内容</span> ${esc(r.text)}` +
      (r.missing.length ? ` <span class="warn-badge">未定義: ${esc(r.missing.join(', '))}</span>` : '');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function renderLog() {
    $('#logList').innerHTML = state.log.map((e, i) => `
      <li class="log-item ${e.ok ? '' : 'failed'}" data-i="${i}" title="クリックで入力欄へ">
        <span class="log-meta"><span class="swatch" style="--char-color:${esc(e.color || '#888')}"></span>${esc(e.name || '')} · ${esc(e.time)} · ${esc(e.via)}</span>
        <span class="log-text">${esc(e.text)}</span>
      </li>`).join('') || '<li class="hint">まだ送信していません</li>';
  }

  /** 値が変わったときに再描画が必要な部分 */
  function refreshValues() {
    const ch = current();
    if (ch && ch.currentPalette !== SETTINGS_TAB && !ui.editingPalette) renderPaletteBody();
    renderComposerPreview();
  }

  /* ------------------------------------------------------------------ *
   * 送信
   * ------------------------------------------------------------------ */

  /** コピー送信用: 名前と色を末尾コマンド（@[name]:名前@#色）で付ける */
  function decorate(text, ch) {
    if (!ch || !state.settings.withName) return text;
    return text + '@[name]:' + ch.name + (ch.color ? '@' + ch.color.toUpperCase() : '');
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function buildApiParams(message, ch) {
    const s = state.settings;
    const p = s.params;
    const q = new URLSearchParams();
    const put = (key, val) => { if (key && val !== undefined && val !== null && val !== '') q.set(key, val); };
    put(p.apiKey, s.apiKey);
    put(p.command, p.commandValue);
    put(p.roomId, s.roomId);
    put(p.roomPassword, s.roomPassword);
    put(p.message, message);
    if (ch && s.withName) {
      put(p.name, ch.name);
      put(p.color, ch.color.replace('#', '').toUpperCase()); // 仕様: 先頭の # は不要
    }
    put(p.tab, (ch && ch.tab) || s.tab);
    put(p.system, s.system);
    if (s.isDirection) put(p.isDirection, 'true');
    return q;
  }

  async function postApi(message, ch) {
    const s = state.settings;
    const q = buildApiParams(message, ch);
    const isGet = s.method === 'GET';
    const url = isGet ? s.endpoint + (s.endpoint.includes('?') ? '&' : '?') + q.toString() : s.endpoint;
    const opts = isGet ? { method: 'GET' } : { method: 'POST', body: q };
    if (!s.readResponse) {
      opts.mode = 'no-cors';
      await fetch(url, opts);
      return { ok: true, note: '送信しました（応答は確認していません）' };
    }
    const r = await fetch(url, opts);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* JSON でない応答 */ }
    if (r.ok && (!j || j.result === 'OK')) return { ok: true, note: '送信しました' };
    if (r.status === 429) {
      const wait = r.headers.get('Retry-After') || (j && j.retryAfter) || '';
      return { ok: false, note: '送信回数の上限に達しました' + (wait ? '（' + wait + ' 秒後に再試行できます）' : '') };
    }
    const msg = (j && (j.message || j.result)) || text.slice(0, 200) || 'HTTP ' + r.status;
    return { ok: false, note: '送信エラー: ' + msg };
  }

  function pushLog(entry) {
    const d = new Date();
    entry.time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    state.log.unshift(entry);
    state.log = state.log.slice(0, 100);
    save();
    renderLog();
  }

  /** raw: パレットの行または入力欄の生テキスト（{変数} を含む） */
  async function send(raw, ch) {
    ch = ch || current();
    if (!raw || !raw.trim()) return false;
    const r = ch ? processText(raw, resolverFor(ch)) : { text: raw.trim(), missing: [] };
    if (!r.text) return false;
    if (r.missing.length) toast('未定義の変数があります: ' + r.missing.join(', '), 'warn');
    const message = decorate(r.text, ch); // コピー用（API は name / color パラメータで指定）
    const s = state.settings;
    const base = { name: ch && ch.name, color: ch && ch.color, text: r.text, raw };

    if (s.sendMode === 'api') {
      if (!s.apiKey || !s.roomId || !s.roomPassword) {
        toast('API キー・ルーム ID・ルームパスワードを設定してください', 'error');
        if (s.copyOnFail && await copyText(message)) {
          toast('代わりにクリップボードへコピーしました');
          pushLog({ ...base, via: 'コピー', ok: true });
        }
        return false;
      }
      try {
        const res = await postApi(r.text, ch);
        if (!res.ok) throw new Error(res.note);
        pushLog({ ...base, via: 'API', ok: true });
        toast(res.note);
        return true;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (s.copyOnFail && await copyText(message)) {
          toast('API 送信に失敗したのでコピーしました（' + msg + '）', 'warn');
          pushLog({ ...base, via: 'コピー', ok: true });
        } else {
          toast('API 送信に失敗しました: ' + msg, 'error');
          pushLog({ ...base, via: 'API', ok: false });
        }
        return false;
      }
    }

    if (await copyText(message)) {
      toast('コピーしました。Tekey のチャット欄に貼り付けてください');
      pushLog({ ...base, via: 'コピー', ok: true });
      return true;
    }
    toast('コピーできませんでした', 'error');
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 取込・書き出し
   * ------------------------------------------------------------------ */

  function addCharacters(list, { select = true } = {}) {
    const added = list.map((c) => normChar(c));
    state.characters.push(...added);
    if (select && added[0]) state.currentId = added[0].id;
    save();
    renderAll();
    return added;
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function exportApp() {
    const settings = Object.assign({}, state.settings);
    for (const k of SECRET_KEYS) delete settings[k];
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    downloadJson({ app: 'tekey-multi-palette', version: 1, settings, characters: state.characters }, `tekey-palette-${stamp}.json`);
    toast('書き出しました（API キーとパスワードは含みません）');
  }

  async function readFile(input) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return null;
    return JSON.parse(await f.text());
  }

  async function importApp(json) {
    if (!json || !Array.isArray(json.characters)) throw new Error('このアプリで書き出した JSON ではありません');
    const replace = state.characters.length === 0 ||
      confirm('今のキャラクターを置き換えますか？\n［OK］置き換える　［キャンセル］追加する');
    const chars = json.characters.map((c) => normChar({ ...c, id: replace ? c.id : undefined }));
    if (replace) {
      const secrets = {};
      for (const k of SECRET_KEYS) secrets[k] = state.settings[k];
      state = normState({ settings: Object.assign({}, json.settings || state.settings, secrets), characters: chars, log: state.log });
    } else {
      state.characters.push(...chars);
    }
    state.currentId = chars[0] ? chars[0].id : state.currentId;
    save();
    renderAll();
    toast(chars.length + ' 人のキャラクターを読み込みました');
  }

  async function fetchYtsheet(url) {
    const res = await fetch(ytsheetJsonUrl(url), { mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function applyYtsheet(data, url, target) {
    const c = fromYtsheet(data, url);
    const ch = current();
    if (target === 'update' && ch) {
      ch.fixedText = c.fixedText;
      ch.ytsheetUrl = url || ch.ytsheetUrl;
      for (const m of c.mods) if (!ch.mods.some((x) => x.k === m.k)) ch.mods.push(m);
      save();
      renderAll();
      toast(ch.name + ' の固定値を更新しました');
    } else {
      addCharacters([c]);
      toast(c.name + ' を取り込みました（技能 ' + c.summary.classes.length + ' / 武器 ' + c.summary.weapons + '）');
    }
  }

  function openYtsheetDialog(target) {
    const ch = current();
    $('#ytUrl').value = target === 'update' && ch ? ch.ytsheetUrl : '';
    $('#ytJson').value = '';
    $('#ytError').hidden = true;
    $('#ytTargetUpdate').disabled = !ch;
    $$('input[name=ytTarget]').forEach((r) => { r.checked = r.value === (target === 'update' && ch ? 'update' : 'new'); });
    updateYtLink();
    $('#importDialog').close();
    $('#ytsheetDialog').showModal();
  }

  function updateYtLink() {
    const a = $('#ytJsonLink');
    try { a.href = ytsheetJsonUrl($('#ytUrl').value.trim()); a.removeAttribute('aria-disabled'); } catch (e) { a.href = '#'; a.setAttribute('aria-disabled', 'true'); }
  }

  async function runYtImport() {
    const url = $('#ytUrl').value.trim();
    const pasted = $('#ytJson').value.trim();
    const target = ($('input[name=ytTarget]:checked') || {}).value || 'new';
    const err = $('#ytError');
    err.hidden = true;
    const btn = $('#btnYtImport');
    btn.disabled = true;
    try {
      let data;
      if (pasted) data = JSON.parse(pasted);
      else if (url) {
        try {
          data = await fetchYtsheet(url);
        } catch (e) {
          throw new Error('キャラシートを取得できませんでした（' + e.message + '）。ブラウザの制限の可能性があります。「JSON 出力」リンクを開いて中身を貼り付けてください。');
        }
      } else throw new Error('URL を入力するか JSON を貼り付けてください');
      applyYtsheet(data, url, target);
      $('#ytsheetDialog').close();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * トースト
   * ------------------------------------------------------------------ */

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    // モーダルの上にも出るように、開いているダイアログがあればその中に置く
    const dlg = document.querySelector('dialog[open]');
    let host = $('#toasts');
    if (dlg) {
      host = dlg.querySelector('.toasts') || dlg.appendChild(Object.assign(document.createElement('div'), { className: 'toasts' }));
    }
    host.appendChild(el);
    setTimeout(() => el.classList.add('out'), kind === 'error' ? 5000 : 2500);
    setTimeout(() => el.remove(), kind === 'error' ? 5400 : 2900);
  }

  /* ------------------------------------------------------------------ *
   * 操作
   * ------------------------------------------------------------------ */

  function newCharacter() {
    const n = state.characters.length + 1;
    addCharacters([{
      name: 'PC' + n,
      color: '#000000',
      fixedText: '# ■固定値\n冒険者レベル=1\n',
      mods: defaultMods(false),
      palettes: [{ label: '基本', text: '2d+{冒険者レベル}+{命中修正} 命中力\n「セリフ」' }],
    }]);
    const ch = current();
    ch.currentPalette = SETTINGS_TAB;
    renderAll();
  }

  function selectChar(id) {
    if (state.currentId === id) return;
    state.currentId = id;
    ui.editingPalette = false;
    ui.editingMods = false;
    save();
    renderAll();
  }

  function move(arr, idx, dir) {
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= arr.length) return false;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    return true;
  }

  // キャラタブ
  $('#charTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.action === 'addChar') { $('#importDialog').showModal(); return; }
    selectChar(b.dataset.id);
  });

  // パレットタブ
  $('#paletteTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const ch = current();
    if (!b || !ch) return;
    if (b.dataset.action === 'addPalette') {
      const p = { id: uid(), label: 'パレット' + (ch.palettes.length + 1), text: '' };
      ch.palettes.push(p);
      ch.currentPalette = p.id;
      ui.editingPalette = true;
    } else {
      if (ch.currentPalette === b.dataset.id) return;
      ch.currentPalette = b.dataset.id;
      ui.editingPalette = false;
    }
    save();
    renderPaletteTabs();
    renderPaletteBody();
  });

  // パレット本体
  const body = $('#paletteBody');
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    const ch = current();
    if (!b || !ch) return;
    const p = ch.palettes.find((x) => x.id === ch.currentPalette);
    const act = b.dataset.action;
    if (act === 'lineClick' || act === 'lineSend') {
      const idx = Number(b.closest('.line').dataset.idx);
      const raw = p.text.split(/\r?\n/)[idx];
      let doSend = act === 'lineSend' || state.settings.clickAction === 'send';
      if (act === 'lineClick' && e.shiftKey) doSend = !doSend;
      if (doSend) send(raw, ch);
      else {
        const input = $('#composerInput');
        input.value = raw.trim();
        renderComposerPreview();
        input.focus();
      }
      return;
    }
    if (act === 'editPalette') { ui.editingPalette = true; renderPaletteBody(); return; }
    if (act === 'doneEdit') { ui.editingPalette = false; renderPaletteTabs(); renderPaletteBody(); return; }
    if (act === 'movePalette') {
      const i = ch.palettes.indexOf(p);
      if (move(ch.palettes, i, Number(b.dataset.dir))) { save(); renderPaletteTabs(); }
      return;
    }
    if (act === 'deletePalette') {
      if (!confirm(`パレット「${p.label}」を削除しますか？`)) return;
      ch.palettes = ch.palettes.filter((x) => x !== p);
      ch.currentPalette = null;
      ui.editingPalette = false;
      save();
      renderPaletteTabs();
      renderPaletteBody();
      return;
    }
    if (act === 'moveChar') {
      const i = state.characters.indexOf(ch);
      if (move(state.characters, i, Number(b.dataset.dir))) { save(); renderCharTabs(); }
      return;
    }
    if (act === 'duplicateChar') {
      const copy = JSON.parse(JSON.stringify(ch));
      delete copy.id;
      copy.palettes.forEach((x) => delete x.id);
      copy.name += '（コピー）';
      addCharacters([copy]);
      return;
    }
    if (act === 'deleteChar') {
      if (!confirm(`「${ch.name}」を削除しますか？（元に戻せません）`)) return;
      state.characters = state.characters.filter((x) => x !== ch);
      state.currentId = state.characters[0] ? state.characters[0].id : null;
      save();
      renderAll();
      return;
    }
    if (act === 'ytReimport') {
      const url = $('#chYtUrl').value.trim();
      ch.ytsheetUrl = url;
      save();
      openYtsheetDialog('update');
    }
  });

  body.addEventListener('input', (e) => {
    const ch = current();
    if (!ch) return;
    const t = e.target;
    const p = ch.palettes.find((x) => x.id === ch.currentPalette);
    switch (t.id) {
      case 'palText': p.text = t.value; break;
      case 'palLabel': p.label = t.value || 'パレット'; break;
      case 'chName': ch.name = t.value || '名無し'; renderCharTabs(); break;
      case 'chColor': ch.color = t.value; $('#chColorText').value = t.value; renderCharTabs(); break;
      case 'chColorText':
        if (/^#?[0-9a-f]{6}$/i.test(t.value)) { ch.color = normalizeColor(t.value); $('#chColor').value = ch.color; renderCharTabs(); }
        break;
      case 'chTab': ch.tab = t.value.trim(); break;
      case 'chYtUrl': ch.ytsheetUrl = t.value.trim(); break;
      case 'chFixed': ch.fixedText = t.value; scheduleFixedPreview(); break;
      default: return;
    }
    save();
    renderComposerPreview();
  });

  let fixedTimer = null;
  function scheduleFixedPreview() {
    clearTimeout(fixedTimer);
    fixedTimer = setTimeout(() => {
      const ch = current();
      if (!ch) return;
      const res = resolverFor(ch);
      const rows = parseDefs(ch.fixedText).map(([k]) => {
        const v = res.value(k);
        return `<tr><th>${esc(k)}</th><td>${esc(v === null ? '（循環参照）' : v)}</td></tr>`;
      }).join('');
      const table = $('.fixed-preview table');
      if (table) table.innerHTML = rows || '<tr><td class="hint">まだありません</td></tr>';
    }, 250);
  }

  // バフ・デバフ
  $('#modsBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action=modStep]');
    const ch = current();
    if (!b || !ch) return;
    const row = b.closest('.mod');
    const m = ch.mods[Number(row.dataset.i)];
    const n = tryEval(m.v === '' ? '0' : m.v);
    if (n === null) return;
    m.v = String(n + Number(b.dataset.d));
    row.querySelector('.mod-input').value = m.v;
    row.classList.toggle('changed', m.v !== m.d);
    save();
    refreshValues();
  });

  $('#modsBody').addEventListener('input', (e) => {
    const ch = current();
    if (!ch) return;
    if (e.target.id === 'modsText') return; // 「完了」で反映
    if (!e.target.classList.contains('mod-input')) return;
    const row = e.target.closest('.mod');
    const m = ch.mods[Number(row.dataset.i)];
    m.v = e.target.value.trim();
    row.classList.toggle('changed', m.v !== m.d);
    const numeric = tryEval(m.v === '' ? '0' : m.v) !== null;
    row.querySelectorAll('.step').forEach((s) => { s.disabled = !numeric; });
    save();
    refreshValues();
  });

  $('#modsBody').addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('mod-input')) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const btn = e.target.parentElement.querySelector(`[data-d="${e.key === 'ArrowUp' ? 1 : -1}"]`);
      if (btn && !btn.disabled) btn.click();
    }
  });

  $('#btnModsEdit').addEventListener('click', () => {
    const ch = current();
    if (!ch) return;
    if (ui.editingMods) {
      const old = new Map(ch.mods.map((m) => [m.k, m]));
      ch.mods = parseDefs($('#modsText').value).map(([k, d]) => {
        const prev = old.get(k);
        return { k, d, v: prev && prev.d === d ? prev.v : d };
      });
      save();
      ui.editingMods = false;
      renderMods();
      refreshValues();
    } else {
      ui.editingMods = true;
      renderMods();
      $('#modsText').focus();
    }
  });

  $('#btnModsReset').addEventListener('click', () => {
    const ch = current();
    if (!ch) return;
    ch.mods.forEach((m) => { m.v = m.d; });
    save();
    renderMods();
    refreshValues();
    toast('バフ・デバフを初期値に戻しました');
  });

  // 入力欄
  const input = $('#composerInput');
  input.addEventListener('input', renderComposerPreview);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (await send(input.value)) { input.value = ''; renderComposerPreview(); }
    } else if (e.key === 'Escape') {
      input.value = '';
      renderComposerPreview();
    }
  });
  $('#btnSend').addEventListener('click', async () => {
    if (await send(input.value)) { input.value = ''; renderComposerPreview(); }
    input.focus();
  });

  // 履歴
  $('#logList').addEventListener('click', (e) => {
    const li = e.target.closest('.log-item');
    if (!li) return;
    const entry = state.log[Number(li.dataset.i)];
    input.value = entry.raw ? entry.raw.trim() : entry.text;
    renderComposerPreview();
    input.focus();
  });
  $('#btnLogClear').addEventListener('click', () => {
    state.log = [];
    save();
    renderLog();
  });

  // 取込メニュー
  function handleMenuAction(act) {
    if (act === 'ytsheet') openYtsheetDialog('new');
    else if (act === 'tekeyJson') $('#fileTekey').click();
    else if (act === 'newChar') { $('#importDialog').close(); newCharacter(); }
    else if (act === 'exportApp') exportApp();
    else if (act === 'importApp') $('#fileApp').click();
  }
  $('#btnImportMenu').addEventListener('click', () => $('#importDialog').showModal());
  $('#importDialog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b) handleMenuAction(b.dataset.action);
  });
  $('#emptyState').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b) handleMenuAction(b.dataset.action);
  });

  $('#fileTekey').addEventListener('change', async (e) => {
    try {
      const json = await readFile(e.target);
      if (!json) return;
      const chars = fromTekeyPalettes(json);
      if (!chars.length) throw new Error('パレットが見つかりませんでした');
      addCharacters(chars);
      $('#importDialog').close();
      toast(chars.length + ' 人のキャラクターを読み込みました: ' + chars.map((c) => c.name).join('、'));
    } catch (err) {
      toast('読み込めませんでした: ' + err.message, 'error');
    }
  });

  $('#fileApp').addEventListener('change', async (e) => {
    try {
      const json = await readFile(e.target);
      if (!json) return;
      await importApp(json);
      $('#importDialog').close();
    } catch (err) {
      toast('読み込めませんでした: ' + err.message, 'error');
    }
  });

  $('#ytUrl').addEventListener('input', updateYtLink);
  $('#btnYtImport').addEventListener('click', runYtImport);

  // 設定
  function fillSettings() {
    const s = state.settings;
    const f = $('#settingsForm');
    for (const name of ['sendMode', 'clickAction']) {
      $$(`input[name=${name}]`, f).forEach((r) => { r.checked = r.value === s[name]; });
    }
    $$('[data-setting]', f).forEach((el) => {
      const k = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else el.value = s[k] ?? '';
    });
    $$('[data-param]', f).forEach((el) => { el.value = s.params[el.dataset.param] ?? ''; });
  }

  $('#btnSettings').addEventListener('click', () => {
    fillSettings();
    $('#settingsDialog').showModal();
  });

  $('#settingsForm').addEventListener('input', (e) => {
    const el = e.target;
    const s = state.settings;
    if (el.type === 'radio') s[el.name] = el.value;
    else if (el.dataset.setting) s[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.value.trim();
    else if (el.dataset.param) s.params[el.dataset.param] = el.value.trim();
    else return;
    save();
    renderModeIndicator();
    if (el.name === 'clickAction') renderPaletteBody();
  });
  $('#settingsForm').addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') {
      state.settings[e.target.dataset.setting] = e.target.value;
      save();
    }
  });

  $('#btnTestSend').addEventListener('click', async () => {
    const ch = current();
    await send('「テスト送信です」', ch);
  });

  // 起動
  renderAll();
})();
