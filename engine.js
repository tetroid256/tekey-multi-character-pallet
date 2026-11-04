/*
 * engine.js — 変数展開とコマンドの計算
 *
 * Tekey のチャットパレットと同じ {変数名} 記法を、アプリ側で数値まで計算する。
 *   - 変数の値が四則演算だけになったら数値に評価する（割り算は切り捨て）
 *   - ダイスコマンド部分は、括弧内の計算や「+3+0-1」のような定数の並びを 1 つにまとめる
 */
(function (global) {
  'use strict';

  /** 「名前=値」形式の行を解析する（行頭の // は省略可、# で始まる行はコメント） */
  function parseDefs(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      let t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (t.startsWith('//')) t = t.slice(2);
      const i = t.indexOf('=');
      if (i <= 0) continue;
      out.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
    }
    return out;
  }

  /** 四則演算だけの文字列を評価する。評価できなければ null */
  function tryEval(src) {
    const s = String(src).replace(/\s+/g, '');
    if (!s || !/\d/.test(s) || !/^[\d+\-*/().]+$/.test(s)) return null;
    let i = 0;
    const fail = () => { throw new Error('parse'); };
    function expr() {
      let v = term();
      while (s[i] === '+' || s[i] === '-') {
        const op = s[i++];
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      let v = factor();
      while (s[i] === '*' || s[i] === '/') {
        const op = s[i++];
        const r = factor();
        if (op === '*') v *= r;
        else { if (r === 0) fail(); v = Math.floor(v / r); }
      }
      return v;
    }
    function factor() {
      const c = s[i];
      if (c === '+') { i++; return factor(); }
      if (c === '-') { i++; return -factor(); }
      if (c === '(') {
        i++;
        const v = expr();
        if (s[i++] !== ')') fail();
        return v;
      }
      const m = /^\d+(?:\.\d+)?/.exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
      return Number(m[0]);
    }
    try {
      const v = expr();
      if (i !== s.length || !Number.isFinite(v)) return null;
      return v;
    } catch (e) {
      return null;
    }
  }

  /**
   * 変数表から解決器を作る。
   * map: Map<名前, 値の生文字列>
   */
  function makeResolver(map) {
    const cache = new Map();
    const missing = new Set();
    const cycles = new Set();

    function resolve(name, stack) {
      if (cache.has(name)) return cache.get(name);
      if (!map.has(name)) { missing.add(name); return null; }
      if (stack.includes(name)) { cycles.add(name); return null; }
      let v = subst(map.get(name), stack.concat(name), '');
      const n = tryEval(v);
      if (n !== null) v = String(n);
      cache.set(name, v);
      return v;
    }

    function subst(text, stack, emptyAs) {
      return String(text).replace(/\{([^{}]+)\}/g, (m, n) => {
        const r = resolve(n.trim(), stack || []);
        if (r === null) return m;
        return r === '' ? (emptyAs ?? '') : r;
      });
    }

    return {
      subst: (text, emptyAs) => subst(text, [], emptyAs),
      value: (name) => resolve(name, []),
      missing,
      cycles,
    };
  }

  /** 先頭トークンがダイスコマンドっぽいか */
  function isCommand(token) {
    return /^s?(?:\d*d\d*|k\d+|\d+b\d+|\d+r\d+|\d+u\d+|c\(|choice|[\d(])/i.test(token);
  }

  function fmtSigned(n) {
    return n < 0 ? String(n) : '+' + n;
  }

  /** コマンド中の計算できる部分をまとめる */
  function simplifyCommand(cmd) {
    let prev;
    // 1) 数値だけの括弧を計算 （例: k0[(10)] → k0[10]、h+(+0) → h+0）
    do {
      prev = cmd;
      cmd = cmd.replace(/\(([\d\s+\-*/.]*\d[\d\s+\-*/.]*)\)/g, (m, inner, off, str) => {
        const v = tryEval(inner);
        if (v === null) return m;
        const before = str[off - 1];
        if (v < 0 && (before === '*' || before === '/')) return '(' + v + ')';
        return String(v);
      });
    } while (cmd !== prev);

    // 2) +a+b-c のような定数の並びを 1 つにまとめる
    //    $（クリティカルレイ）や # の直後、[ ( の直後、掛け算・割り算に関わる部分は触らない
    cmd = cmd.replace(/(?<![$#@\[(*/=<>])((?:[+\-][+\-]?\d+)+)(?![\d*/a-zA-Z(\[.])/g, (m, run, off, str) => {
      const v = tryEval(run);
      if (v === null) return m;
      if (v === 0) {
        // 「2d+0」→「2d」。ただし先頭や記号の直後で消すと意味が変わる場合は残す
        const before = str[off - 1];
        return before === undefined ? '0' : '';
      }
      return fmtSigned(v);
    });

    // 3) クリティカルレイ 0（$+0）は付けない
    cmd = cmd.replace(/\$\+?0(?![\d.])/g, '');
    return cmd;
  }

  /**
   * パレットの 1 行を送信用の文字列にする。
   * 戻り値: { text, isCommand, missing:[…], cycles:[…] }
   */
  function processLine(raw, resolver) {
    const line = String(raw).trim();
    if (!line) return { text: '', isCommand: false, missing: [], cycles: [] };
    const m = line.match(/^((?:x|rep|repeat)\d+\s+)?(\S+)(\s[\s\S]*)?$/i);
    let text;
    let command = false;
    if (m) {
      const prefix = m[1] || '';
      const cmd = resolver.subst(m[2], '0');
      if (isCommand(cmd)) {
        command = true;
        text = prefix + simplifyCommand(cmd) + resolver.subst(m[3] || '', '');
      }
    }
    if (!command) text = resolver.subst(line, '');
    const missing = [...line.matchAll(/\{([^{}]+)\}/g)]
      .map((x) => x[1].trim())
      .filter((n) => resolver.missing.has(n));
    return { text, isCommand: command, missing, cycles: [...resolver.cycles] };
  }

  /** 複数行のテキストを行ごとに処理して結合する */
  function processText(text, resolver) {
    const results = String(text).split(/\r?\n/).map((l) => processLine(l, resolver));
    return {
      text: results.map((r) => r.text).join('\n').trim(),
      missing: [...new Set(results.flatMap((r) => r.missing))],
    };
  }

  const api = { parseDefs, tryEval, makeResolver, isCommand, simplifyCommand, processLine, processText };
  global.Engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
