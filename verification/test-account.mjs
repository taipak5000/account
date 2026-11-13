// 使い捨て検証: 旧形式データを新index.htmlで開き、操作しても
// 保存キー・JSON形状が変わらないこと、集計・エスケープ・新機能を確認する
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error('FAIL', label, '\n  actual  =', a, '\n  expected=', e); failures++; }
  else console.log('pass:', label);
}
function ok(cond, label) { eq(!!cond, true, label); }

// 旧バージョンが保存したのと同形式のフィクスチャ
// （名前にHTML文字を含むアカウント、グループ複数、nextIdが進んだ状態）
const FIXTURE = {
  accounts: [
    { id: 1, name: 'サブ1号機', device: 'iPhone 15', group: 'メイン', candles: 120 },
    { id: 2, name: '<b>悪意</b>テスト', device: 'Android', group: 'メイン', candles: 45 },
    { id: 3, name: 'サブ3号機', device: '未指定', group: '予備', candles: 0 },
  ],
  nextId: 99,
};

const dom = new JSDOM(html, {
  url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(window) {
    window.localStorage.setItem('ios_account_manager_data_v3', JSON.stringify(FIXTURE));
  },
});
const { window } = dom;
// スクリプトは読み込み時に実行される（jsdomが自動実行）。少し待ってから検証
await new Promise(r => setTimeout(r, 100));
const doc = window.document;

// 1) 旧データがそのまま読めて集計が合う
eq(doc.getElementById('stat-total').textContent, '165', 'total = 120+45+0');
eq(doc.getElementById('stat-accounts').textContent, '3', 'account count');
eq(doc.getElementById('stat-groups').textContent, '2', 'group count');
eq(doc.querySelectorAll('.account-item').length, 3, 'rows rendered');

// 2) エスケープ: 名前のHTMLが実行されず、文字として表示される
const names = Array.from(doc.querySelectorAll('.account-name')).map(el => el.textContent);
ok(names.includes('<b>悪意</b>テスト'), 'name shown as literal text');
eq(doc.querySelectorAll('#account-list b').length, 0, 'no injected <b> elements in list');
eq(doc.querySelectorAll('#account-list img').length, 0, 'no injected elements');

// 3) 読み込みだけでは保存データが書き換わらない
eq(JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3')), FIXTURE, 'load does not rewrite data');

// 4) 一括変更 +2（全体）→ 全員+2、保存形式は同一
window.applyBatchChange(2);
let saved = JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3'));
eq(saved.accounts.map(a => a.candles), [122, 47, 2], 'batch +2 applied');
eq(Object.keys(saved).sort(), ['accounts', 'nextId'], 'saved top-level keys unchanged');
eq(Object.keys(saved.accounts[0]).sort(), ['candles', 'device', 'group', 'id', 'name'], 'account object keys unchanged');
eq(saved.nextId, 99, 'nextId preserved');

// 5) 元に戻す → 復元
window.undoLast();
saved = JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3'));
eq(saved.accounts.map(a => a.candles), [120, 45, 0], 'undo restores candles');

// 6) 大きなマイナス → 0で止まる（旧版はマイナスになっていた問題の修正）
window.applyBatchChange(-1000);
saved = JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3'));
eq(saved.accounts.map(a => a.candles), [0, 0, 0], 'batch clamps at 0');
window.undoLast();

// 7) ステッパー +1 / -1
window.stepCandle(1, 1);
window.stepCandle(1, -1);
window.stepCandle(3, -1); // 0から減らしても0
saved = JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3'));
eq(saved.accounts.map(a => a.candles), [120, 45, 0], 'stepper works and clamps');

// 8) 並び替え（表示のみ）: キャンドル多い順にしても保存順は変わらない
window.onSortChange('candles-desc');
const rowOrder = Array.from(doc.querySelectorAll('.account-name')).map(el => el.textContent);
eq(rowOrder[0], 'サブ1号機', 'sorted view puts 120 first');
saved = JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3'));
eq(saved.accounts.map(a => a.id), [1, 2, 3], 'stored order untouched by sort view');
ok(window.localStorage.getItem('subcandle_ui_v1') !== null, 'ui prefs saved to separate key');
window.onSortChange('manual');

// 9) 検索フィルター（表示のみ）
window.onSearchInput('予備');
eq(doc.querySelectorAll('.account-item').length, 1, 'search filters to 1 row');
window.onSearchInput('');

// 10) 新規追加は nextId=99 を使う（旧データの引き継ぎ確認）
doc.getElementById('input-name').value = '新規サブ';
doc.getElementById('input-device').value = '';
doc.getElementById('input-group').value = '';
doc.getElementById('input-candles').value = '7';
window.handleSubmit({ preventDefault() {} });
saved = JSON.parse(window.localStorage.getItem('ios_account_manager_data_v3'));
eq(saved.accounts.length, 4, 'account added');
eq(saved.accounts[3].id, 99, 'new account uses preserved nextId');
eq(saved.accounts[3].device, '未指定', 'device default preserved');
eq(saved.accounts[3].group, '未分類', 'group default preserved');
eq(saved.nextId, 100, 'nextId incremented');

// 11) バックアップ読み込みの検証関数: 旧形式OK / 壊れた形式は弾く
ok(window.validateImport(FIXTURE) !== null, 'validateImport accepts old shape');
eq(window.validateImport(FIXTURE).accounts.length, 3, 'validateImport keeps accounts');
eq(window.validateImport({ foo: 1 }), null, 'validateImport rejects wrong shape');
eq(window.validateImport({ accounts: [{ id: 'x', name: 'a' }] }), null, 'validateImport rejects bad id');
eq(window.validateImport({ accounts: [{ id: 5, name: 'a', candles: -3 }] }).accounts[0].candles, 0, 'validateImport clamps negatives');

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
