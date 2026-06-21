/**
 * 画面のセレクタを一元管理するファイル。
 *
 * ★ ここが「あとで埋める」中心地です。
 *   実際の申請画面のHTMLを確認しながら、各 TODO を本物のセレクタに置き換えます。
 *   （`npm run dump` でログイン後のHTMLを保存できます）
 *
 * Playwright のセレクタは CSS / text= / role= などが使えます。
 *   例: '#loginId' , 'input[name="password"]' , 'text=申請する' ,
 *       'button:has-text("登録")' , 'role=button[name="保存"]'
 *
 * 値が null の項目は「未設定」として扱われ、その操作はスキップ or エラーになります。
 */

export const selectors = {
  // --- ログイン画面 ---
  login: {
    idInput: null,        // TODO: ログインID入力欄  例: 'input[name="login_id"]'
    passwordInput: null,  // TODO: パスワード入力欄  例: 'input[name="password"]'
    submitButton: null,   // TODO: ログインボタン     例: 'button:has-text("ログイン")'
    // ログイン成功の目印になる要素（これが見えたら成功とみなす）
    loggedInMarker: null, // TODO: 例: 'text=ダッシュボード'
  },

  // --- スケジュール申請画面への遷移 ---
  nav: {
    // 申請画面へ行くためのリンク/ボタンを上から順にクリックしていく
    // 例: ['text=勤怠', 'text=スケジュール申請']
    toScheduleApply: [],  // TODO
  },

  // --- 1日分のスケジュール申請フォーム ---
  // {date},{start},{end} は applySchedule.js が実際の値に置換します。
  form: {
    // 対象日のセル/行を開くための要素（日付で特定）。{date} は YYYY-MM-DD。
    openDayFor: null,     // TODO: 例: '[data-date="{date}"]'
    startInput: null,     // TODO: 出勤時刻の入力欄
    endInput: null,       // TODO: 退勤時刻の入力欄
    breakStartInput: null,// TODO: 休憩開始（任意）
    breakEndInput: null,  // TODO: 休憩終了（任意）
    noteInput: null,      // TODO: 申請メッセージ（任意）
    submitButton: null,   // TODO: 申請/登録 ボタン
    // 申請成功の目印（トースト等）。任意。
    successMarker: null,  // TODO: 例: 'text=申請しました'
  },
};

/** "{date}" などのプレースホルダを置換するヘルパー */
export function fillSelector(template, vars) {
  if (!template) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
