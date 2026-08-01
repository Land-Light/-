/* namehint.js — 氏名の「表記」から外国人名の候補を拾い出す
 *
 * ここで判定できるのはあくまで表記（どの文字種で書かれているか）であって、
 * 国籍そのものではない。漢字・かな表記の氏名は原理的に区別できないため
 * 'unknown'（判定できない）として返し、除外するかどうかは利用者が決める。
 */
(function (global) {
  'use strict';

  const RE = {
    latin: /[A-Za-zÀ-ɏ]/,
    hangul: /[ᄀ-ᇿ㄰-㆏가-힯]/,
    cyrillic: /[Ѐ-ӿ]/,
    otherScript: /[Ͱ-Ͽ֐-׿؀-ۿऀ-ॿ฀-๿]/,
    katakana: /[ァ-ヺーｦ-ﾝ]/,
    hiragana: /[ぁ-ゟ]/,
    kanji: /[一-鿿㐀-䶿]/,
  };

  /* 日本語では使わない簡体字（中国語表記の手がかり）。
     林・高・田のように日中で共通する姓は、区別できないので入れていない。 */
  const SIMPLIFIED = '张陈刘杨赵吴郑冯邓韩谢罗吕卢钟苏龙华贾孙马严兰冈齐邹汤泽滨顾贺龚邝乔项闫蓝陆东广义亚';

  function hasSimplified(text) {
    for (const ch of text) if (SIMPLIFIED.includes(ch)) return true;
    return false;
  }

  const LEVEL = {
    FOREIGN: 'foreign',   // 日本語の氏名表記ではない文字が含まれる
    DOT: 'dot',           // 氏名に「・」が入っている
    KATAKANA: 'katakana', // カタカナ表記（外来名の可能性／日本人のカナ書きの可能性）
    RARE: 'rare',         // 漢字表記だが、日本で多い姓の一覧に無い
    COMMON: 'common',     // 日本で多い姓。名前だけでは判定できない（通名を含む）
    UNKNOWN: 'unknown',   // 判定材料が無い
    EMPTY: 'empty',
  };

  const MIDDLE_DOT = /[・･]/g;

  /** 氏名 1 件を表記から分類する */
  function classifyName(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { level: LEVEL.EMPTY, reason: '空欄' };

    if (RE.hangul.test(text)) return { level: LEVEL.FOREIGN, reason: 'ハングル' };
    if (RE.cyrillic.test(text)) return { level: LEVEL.FOREIGN, reason: 'キリル文字' };
    if (RE.otherScript.test(text)) return { level: LEVEL.FOREIGN, reason: '日本語以外の文字' };
    if (RE.latin.test(text)) return { level: LEVEL.FOREIGN, reason: 'アルファベット' };
    if (hasSimplified(text)) return { level: LEVEL.FOREIGN, reason: '簡体字' };

    // 「・」を含む氏名は、漢字混じりであっても除外する
    MIDDLE_DOT.lastIndex = 0;
    if (MIDDLE_DOT.test(text)) {
      const rest = text.replace(MIDDLE_DOT, '');
      const kanaOnly = RE.katakana.test(rest) && !RE.kanji.test(rest) && !RE.hiragana.test(rest);
      return { level: LEVEL.DOT, reason: '「・」を含む', kanaOnly };
    }

    const kana = RE.katakana.test(text);
    const kanji = RE.kanji.test(text);
    const hira = RE.hiragana.test(text);

    if (kana && !kanji && !hira) return { level: LEVEL.KATAKANA, reason: 'カタカナ' };

    const dict = global.Surnames;
    const surname = dict && dict.matchSurname(text);
    if (surname) return { level: LEVEL.COMMON, reason: '「' + surname + '」は日本で多い姓', surname };

    const dropped = dict && dict.matchDropped(text);
    if (dropped) {
      return { level: LEVEL.RARE, reason: '「' + dropped + '」は中韓系として一覧から外し中', surname: dropped, dropped: true };
    }
    return { level: LEVEL.RARE, reason: '日本で多い姓の一覧に無い' };
  }

  /**
   * 列全体をまとめて分類する。
   * 列そのものがフリガナ列（ほぼカタカナ）やローマ字列の場合は、
   * 表記が手がかりにならないので判定できない扱いに落とす。
   */
  function classifyColumn(entries) {
    const base = entries.map((e) => ({ value: e.value, count: e.count, ...classifyName(e.value) }));
    const named = base.filter((r) => r.level !== LEVEL.EMPTY);
    const total = named.reduce((a, r) => a + r.count, 0) || 1;

    // 「セイ・メイ」形式のフリガナ列もカタカナ列として数える
    const kanaCount = named
      .filter((r) => r.level === LEVEL.KATAKANA || (r.level === LEVEL.DOT && r.kanaOnly))
      .reduce((a, r) => a + r.count, 0);
    const latinCount = named.filter((r) => r.reason === 'アルファベット').reduce((a, r) => a + r.count, 0);

    const warnings = [];
    const kanaColumn = kanaCount / total >= 0.8;
    const romajiColumn = latinCount / total >= 0.8;

    if (kanaColumn) {
      warnings.push('この列はほとんどがカタカナです（フリガナ列の可能性）。カタカナかどうかは手がかりになりません。');
    }
    if (romajiColumn) {
      warnings.push('この列はほとんどがアルファベットです（ローマ字表記の名簿の可能性）。アルファベットかどうかは手がかりになりません。');
    }

    const results = base.map((r) => {
      if (kanaColumn && (r.level === LEVEL.KATAKANA || (r.level === LEVEL.DOT && r.kanaOnly))) {
        return { ...r, level: LEVEL.UNKNOWN, reason: 'カタカナ列のため判定不可' };
      }
      if (romajiColumn && r.reason === 'アルファベット') return { ...r, level: LEVEL.UNKNOWN, reason: 'ローマ字列のため判定不可' };
      return r;
    });

    const counts = { foreign: 0, dot: 0, katakana: 0, rare: 0, common: 0, unknown: 0, empty: 0 };
    results.forEach((r) => { counts[r.level] += r.count; });

    return { results, counts, warnings, kanaColumn, romajiColumn };
  }

  /** 既定で除外候補にする水準（＝姓の一覧に一致しなかったもの） */
  function isCandidate(level) {
    return level === LEVEL.FOREIGN || level === LEVEL.DOT
      || level === LEVEL.KATAKANA || level === LEVEL.RARE;
  }

  /* 画面上のまとまり。上から順に「候補」「一致」「判定不可」 */
  const GROUPS = [
    { key: LEVEL.FOREIGN, title: '日本語の氏名表記ではない', note: 'ハングル・アルファベット・簡体字など' },
    { key: LEVEL.DOT, title: '氏名に「・」が入っている', note: '漢字混じりでも除外します（フリガナ列と判定された場合を除く）' },
    { key: LEVEL.KATAKANA, title: 'カタカナ表記', note: '日本国籍の方をカナで登録している名簿もあります' },
    { key: LEVEL.RARE, title: '姓の一覧に無い', note: '珍しい日本の姓か、中国・韓国系の姓かは名前では区別できません' },
    { key: LEVEL.COMMON, title: '姓の一覧にある', note: '通名を使う外国籍の方もここに入ります（名前では判別できません）' },
    { key: LEVEL.UNKNOWN, title: '判定できない', note: '' },
    { key: LEVEL.EMPTY, title: '空欄', note: '' },
  ];

  const NAME_COL = /氏名|名前|姓名|フルネーム|受験者|生徒名|社員名|学生名|選手名|name/i;
  const KANA_COL = /ふりがな|フリガナ|ふり仮名|振り仮名|カナ|かな|よみ|ヨミ|読み|kana|ruby/i;

  /** 氏名らしい列を探す。フリガナ列は避ける */
  function findNameColumn(columns) {
    const named = columns.filter((c) => NAME_COL.test(c.name) && !KANA_COL.test(c.name));
    if (named.length) return named[0];
    // 見出しで見つからないときは、文字列が入っていて値がほぼ重複しない列を氏名とみなす
    return columns.find((c) => !c.isNumeric && c.filled > 0 && c.uniqueCount >= c.filled * 0.9) || null;
  }

  global.NameHint = { classifyName, classifyColumn, isCandidate, findNameColumn, LEVEL, GROUPS };
})(window);
