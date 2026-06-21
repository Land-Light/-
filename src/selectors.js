/**
 * オフィスステーション勤怠「スケジュール申請」画面のセレクタ定義。
 * 実画面のHTML（captures/ に保存したもの）を解析して設定済み。
 *
 * 画面の作り：
 *  - 日付ごとに行があり、シフトを選ぶプルダウンの id は日付入り
 *    例: #requestedSchedulePatternList_20260710
 *  - 「申請する」ボタンは1つで、入力した全日付をまとめて送信する
 *
 * {ymd} は applySchedule.js が "20260710" のような値に置換します。
 */

export const selectors = {
  // 申請可能な状態か（＝ログイン済みで申請画面が出ているか）の目印
  loggedInMarker: 'button:has-text("申請する")',
  // ログイン画面に飛ばされた場合の検知用
  loginPasswordField: 'input[type="password"]',

  // 日付ごとの「申請スケジュール」プルダウン（シフトパターンを選ぶ）
  patternSelect: '#requestedSchedulePatternList_{ymd}',
  // 全日付分のシフトプルダウン（日付の並び順を把握するのに使う）
  patternSelectAll: 'select[name="requested_schedule_pattern_list"]',

  // 日付ごとの「勤務日種別」プルダウン（任意。平日/法定休日/法定外休日）
  workingDayTypeSelect: '#requested_working_day_type_list_{ymd}',

  // 申請メッセージ欄（各行に1つ。日付idが無いので行の並び順=patternSelectの順で対応づける）
  remarkInputAll: 'input[name="remark_list"]',

  // 申請（送信）ボタン。画面上下に同じものがあるため first() を使う。
  submitButton: 'button.htBlock-buttonSave:has-text("申請する")',
};

/** "{ymd}" などのプレースホルダを置換する */
export function fillSelector(template, vars) {
  if (!template) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
