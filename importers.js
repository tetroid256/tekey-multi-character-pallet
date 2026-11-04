/*
 * importers.js — Tekey パレット JSON / ゆとシートII からキャラクターを作る
 *
 * キャラクターの形:
 *   { name, color, tab, fixedText, mods:[{k,v,d}], palettes:[{label,text}], ytsheetUrl }
 */
(function (global) {
  'use strict';

  const NUM_RE = /^[+\-]?\d+(?:\.\d+)?$/;

  /* ------------------------------------------------------------------ *
   * Tekey パレット JSON
   * ------------------------------------------------------------------ */

  /**
   * Tekey から書き出したパレット JSON（{palettes:[…]}）を、パレットの name ごとにキャラへ分ける。
   * 変数名の先頭に共通の 2 桁番号（01, 02 …）があれば取り除く。
   */
  function fromTekeyPalettes(json) {
    const list = Array.isArray(json) ? json : json && json.palettes;
    if (!Array.isArray(list)) throw new Error('Tekey のパレット JSON ではありません（palettes がありません）');
    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const groups = new Map();
    for (const p of sorted) {
      const key = p.name || '名無し';
      if (!groups.has(key)) groups.set(key, { name: key, color: p.textColor || '#000000', items: [] });
      groups.get(key).items.push(p);
    }

    const chars = [];
    for (const g of groups.values()) {
      const all = g.items.map((i) => (i.stock || '')).join('\n');
      const keys = [...all.matchAll(/^\s*\/\/([^=\n]+)=/gm)].map((m) => m[1].trim());
      let prefix = '';
      if (keys.length) {
        const m = /^\d{2}/.exec(keys[0]);
        if (m && keys.every((k) => k.startsWith(m[0]))) prefix = m[0];
      }
      const stripRefs = (s) => (prefix ? s.split('{' + prefix).join('{') : s);
      const stripName = (s) => (prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s);

      const fixed = [];
      const mods = new Map();
      const palettes = [];

      for (const item of g.items) {
        const label = stripName(item.label || '');
        const isFixed = /固定/.test(label);
        const isMod = /バフ|デバフ|修正/.test(label);
        const rest = [];
        if (isFixed) fixed.push('# ■' + label);
        for (const line of String(item.stock || '').split(/\r?\n/)) {
          const t = line.trim();
          const def = t.match(/^\/\/([^=]+)=(.*)$/);
          if (def) {
            const k = stripName(def[1].trim());
            const v = stripRefs(def[2].trim());
            if (!isFixed && (isMod || NUM_RE.test(v))) mods.set(k, { k, v, d: v });
            else fixed.push(k + '=' + v);
            continue;
          }
          if (/^###/.test(t)) {
            const c = t.replace(/^#+\s*/, '');
            if (isFixed && c) fixed.push('# ' + c);
            continue;
          }
          if (isFixed) { if (t) fixed.push('# ' + t); continue; }
          rest.push(stripRefs(line));
        }
        const text = rest.join('\n').replace(/^\s*\n|\n\s*$/g, '');
        if (text.trim()) palettes.push({ label: label || 'パレット', text });
      }

      chars.push({
        name: g.name,
        color: normalizeColor(g.color),
        fixedText: fixed.join('\n'),
        mods: [...mods.values()],
        palettes,
      });
    }
    return chars;
  }

  function normalizeColor(c) {
    const s = String(c || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    return '#000000';
  }

  /* ------------------------------------------------------------------ *
   * ゆとシートII（SW2.5）
   * ------------------------------------------------------------------ */

  const YT_CLASSES = {
    Fig: 'ファイター', Gra: 'グラップラー', Fen: 'フェンサー', Sho: 'シューター', Bat: 'バトルダンサー',
    Sor: 'ソーサラー', Con: 'コンジャラー', Wiz: 'ウィザード', Pri: 'プリースト', Fai: 'フェアリーテイマー',
    Mag: 'マギテック', Dru: 'ドルイド', Dem: 'デーモンルーラー', Aby: 'アビスゲイザー',
    Sco: 'スカウト', Ran: 'レンジャー', Sag: 'セージ', Enh: 'エンハンサー', Bar: 'バード', Rid: 'ライダー',
    Alc: 'アルケミスト', War: 'ウォーリーダー', Mys: 'ミスティック', Phy: 'フィジカルマスター',
    Gri: 'グリモワール', Art: 'アーティザン', Ari: 'アリストクラシー', Geo: 'ジオマンサー', Dar: 'ダークハンター',
  };
  const YT_MAGIC = {
    Sor: '真語魔法', Con: '操霊魔法', Wiz: '深智魔法', Pri: '神聖魔法', Fai: '妖精魔法', Mag: '魔動機術',
    Dru: '森羅魔法', Dem: '召異魔法', Aby: '奈落魔法', Gri: '秘奥魔法', Bar: '奏力', Alc: '賦術',
    War: '鼓咆', Mys: '占瞳', Dar: '理力', Geo: '相域',
  };
  const YT_PACKS = { Tec: '技巧', Agi: '運動', Obs: '観察', Kno: '知識', Ini: '先制', Int: '先制(知)' };
  const STATS = [
    ['Dex', 'A', '器用度', '器用'], ['Agi', 'B', '敏捷度', '敏捷'], ['Str', 'C', '筋力', '筋力'],
    ['Vit', 'D', '生命力', '生命'], ['Int', 'E', '知力', '知力'], ['Mnd', 'F', '精神力', '精神'],
  ];

  /** ゆとシートの URL を JSON 出力の URL にする */
  function ytsheetJsonUrl(url) {
    const u = new URL(url);
    u.searchParams.set('mode', 'json');
    return u.toString();
  }

  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(/[^\d.\-+]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const str = (v) => (v === undefined || v === null ? '' : String(v).replace(/[\r\n]+/g, ' ').trim());

  /**
   * ゆとシートの JSON からキャラを作る。
   * 戻り値: { name, color, fixedText, mods, palettes, summary }
   */
  function fromYtsheet(d, url) {
    if (!d || typeof d !== 'object') throw new Error('JSON を読み取れませんでした');
    if (d.result && d.result !== 'OK' && !d.characterName) throw new Error('ゆとシートの応答: ' + d.result);
    const name = str(d.characterName) || str(d.aka) || '名無し';
    const L = [];
    const now = new Date();
    L.push('# ゆとシートII から取込（' + now.toLocaleString('ja-JP') + '）');
    if (url) L.push('# ' + url);

    L.push('# ■能力値');
    for (const [code, add, label] of STATS) {
      L.push(label + '=' + (num(d['stt' + code]) ?? 0));
    }
    for (const [, add, label] of STATS) {
      L.push(label + '増強=' + (num(d['sttAdd' + add]) ?? 0));
    }

    L.push('# ■技能レベル');
    L.push('冒険者レベル=' + (num(d.level) ?? 0));
    const classes = [];
    for (const k of Object.keys(d)) {
      const m = /^lv([A-Z][a-z]{2})$/.exec(k);
      if (!m) continue;
      const lv = num(d[k]);
      if (!lv) continue;
      const nm = YT_CLASSES[m[1]] || m[1];
      classes.push({ code: m[1], name: nm, lv });
      L.push(nm + '=' + lv);
    }

    L.push('# ■代入パラメータ');
    L.push('冒険者={冒険者レベル}');
    for (const [, , label, short] of STATS) {
      L.push(short + 'B=(({' + label + '}+{' + label + '増強})/6)');
    }
    const vitRes = num(d.vitResistTotal);
    const mndRes = num(d.mndResistTotal);
    L.push('生命抵抗=' + (vitRes !== null ? vitRes : '{冒険者}+{生命B}'));
    L.push('精神抵抗=' + (mndRes !== null ? mndRes : '{冒険者}+{精神B}'));
    if (num(d.hpTotal) !== null) L.push('最大HP=' + num(d.hpTotal));
    if (num(d.mpTotal) !== null) L.push('最大MP=' + num(d.mpTotal));
    if (num(d.monsterLore) !== null) L.push('魔物知識=' + num(d.monsterLore));
    if (num(d.initiative) !== null) L.push('先制力=' + num(d.initiative));

    // 判定パッケージ（スカウト技巧 など）
    const packs = [];
    for (const k of Object.keys(d)) {
      const m = /^pack([A-Z][a-z]{2})([A-Z][a-z]{2})$/.exec(k);
      if (!m) continue;
      const v = num(d[k]);
      if (v === null || !classes.some((c) => c.code === m[1])) continue;
      const nm = (YT_CLASSES[m[1]] || m[1]) + (YT_PACKS[m[2]] || m[2]);
      packs.push(nm);
      L.push(nm + '=' + v);
    }

    // 魔力
    const magics = [];
    for (const k of Object.keys(d)) {
      const m = /^magicPower([A-Z][a-z]{2})$/.exec(k);
      if (!m) continue;
      const v = num(d[k]);
      if (v === null || v === 0) continue;
      const nm = YT_MAGIC[m[1]] || '魔力' + m[1];
      magics.push(nm);
      L.push(nm + '=' + v + '+{魔力修正}');
    }

    // 武器
    L.push('# ■武器');
    const weapons = [];
    const wn = Math.max(num(d.weaponNum) || 0, 0);
    for (let i = 1; i <= Math.max(wn, 5); i++) {
      const wname = str(d['weapon' + i + 'Name']);
      const rate = num(d['weapon' + i + 'Rate']);
      if (!wname && rate === null) continue;
      const usage = str(d['weapon' + i + 'Usage']);
      const n = weapons.length + 1;
      weapons.push(n);
      L.push('武器' + n + '=' + (wname || '武器' + n) + (usage ? '（' + usage + '）' : ''));
      L.push('命中' + n + '=' + (num(d['weapon' + i + 'AccTotal']) ?? 0));
      L.push('威力' + n + '=' + (rate ?? 0));
      L.push('C値' + n + '=' + (num(d['weapon' + i + 'Crit']) ?? 10));
      L.push('追加D' + n + '=' + (num(d['weapon' + i + 'DmgTotal']) ?? 0));
    }

    // 回避・防護
    L.push('# ■防具');
    const eva = num(d.defenseTotal1Eva) ?? num(d.defenseTotalAllEva) ?? 0;
    const def = num(d.defenseTotal1Def) ?? num(d.defenseTotalAllDef) ?? 0;
    L.push('回避1=' + eva);
    L.push('防護1=' + def);

    return {
      name,
      color: '#000000',
      ytsheetUrl: url || '',
      fixedText: L.join('\n'),
      mods: defaultMods(magics.length > 0),
      palettes: defaultPalettes({ weapons, magics, packs, hasLore: num(d.monsterLore) !== null, hasInit: num(d.initiative) !== null }),
      summary: { name, classes, weapons: weapons.length, magics, packs },
    };
  }

  function defaultMods(withMagic) {
    const m = [
      ['命中修正', 0], ['C修正', 0], ['追加D修正', 0], ['クリレイ', 0],
      ['回避修正', 0], ['生命抵抗修正', 0], ['精神抵抗修正', 0],
    ];
    if (withMagic) m.push(['魔力修正', 0], ['行使修正', 0], ['魔法C', 10], ['魔法D修正', 0], ['回復量修正', 0]);
    else m.push(['魔力修正', 0]);
    return m.map(([k, v]) => ({ k, v: String(v), d: String(v) }));
  }

  function defaultPalettes({ weapons, magics, packs, hasLore, hasInit }) {
    const out = [];
    const t = ['■冒険者判定'];
    for (const [, , , short] of STATS) t.push('2d+{冒険者}+{' + short + 'B} 冒険者＋' + short);
    if (packs.length || hasLore || hasInit) t.push('', '■判定パッケージ');
    for (const p of packs) t.push('2d+{' + p + '} ' + p);
    if (hasLore) t.push('2d+{魔物知識} 魔物知識');
    if (hasInit) t.push('2d+{先制力} 先制力');
    out.push({ label: '探索', text: t.join('\n') });

    if (weapons.length) {
      const b = [];
      for (const n of weapons) {
        b.push('■{武器' + n + '}');
        b.push('2d+{命中' + n + '}+{命中修正} 命中力／{武器' + n + '}');
        b.push('k{威力' + n + '}[({C値' + n + '}+{C修正})]+{追加D' + n + '}+{追加D修正}$+{クリレイ} ダメージ／{武器' + n + '}');
        b.push('');
      }
      out.push({ label: '戦闘', text: b.join('\n').trim() });
    }

    if (magics.length) {
      const m = [];
      for (const nm of magics) {
        m.push('■' + nm);
        m.push('2d+{' + nm + '}+{行使修正} ' + nm + '行使');
        m.push('k10[({魔法C})]+{' + nm + '}+{魔法D修正} ダメージ／' + nm);
        m.push('k10[(13)]+{' + nm + '}h+({魔法D修正}) 半減／' + nm);
        m.push('');
      }
      out.push({ label: '魔法', text: m.join('\n').trim() });
    }

    out.push({
      label: '抵抗/回避',
      text: [
        '2d+{生命抵抗}+{生命抵抗修正} 生命抵抗力',
        '2d+{精神抵抗}+{精神抵抗修正} 精神抵抗力',
        '2d+{回避1}+{回避修正} 回避力',
      ].join('\n'),
    });
    return out;
  }

  const api = { fromTekeyPalettes, fromYtsheet, ytsheetJsonUrl, normalizeColor, defaultMods };
  global.Importers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
