// util.js の、文字数・日付・CSV・URL の小さな道具を確かめる。npm test で流す。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, count, csvCell, cut, isDate, jstTime, originOf, personName, yearRange,
} from '../src/util.js';

test('文字数は見た目の1文字で数え、絵文字の途中で切らない', () => {
  assert.equal(count('あいう'), 3);
  assert.equal(count('👨‍👩‍👧‍👦'), 1); // 組み合わせてできる絵文字も1文字
  assert.equal(count('😀😀'), 2);
  assert.equal(cut('あ'.repeat(5), 3), 'あああ');
  assert.equal(cut('あ'.repeat(199) + '😀' + 'い', 200), 'あ'.repeat(199) + '😀');
  assert.equal(cut('😀😀', 1), '😀');
  assert.equal(cut('短い', 10), '短い');
});

test('入力の前後の空白と制御文字を除く', () => {
  assert.equal(cleanText('  メモ  ', 10), 'メモ');
  assert.equal(cleanText('1行目\n2行目', 20), '1行目\n2行目');
  assert.equal(cleanText('a\u0000b\u007fc', 10), 'abc');
  assert.equal(cleanText('あ'.repeat(5), 3), 'あああ');
  assert.equal(cleanText(null, 10), '');
});

test('姓と名をスペースなしでつなぎ、それぞれの上限で切る', () => {
  assert.deepEqual(personName({ sei: ' 宮教 ', mei: ' 太郎 ' }), { name: '宮教太郎', sei: '宮教', mei: '太郎' });
  assert.deepEqual(personName({ sei: '宮教', mei: ' ' }), { name: '', sei: '宮教', mei: '' });
  assert.equal(personName({ sei: '姓'.repeat(31), mei: '名'.repeat(30) }).name, '姓'.repeat(30) + '名'.repeat(30));
});

test('日付と年度の形を確かめる', () => {
  assert.equal(isDate('2026-10-20'), true);
  assert.equal(isDate('2026-02-29'), false); // 2026年はうるう年ではない
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(isDate('2026-13-01'), false);
  assert.equal(isDate('2026-1-1'), false);
  assert.deepEqual(yearRange(2026), ['2026-04-01', '2027-03-31']);
});

test('記録の日時は日本時間の形にする', () => {
  assert.equal(jstTime('2026-10-20T05:20:48.000Z'), '2026-10-20 14:20:48');
  assert.equal(jstTime(''), '');
  assert.equal(jstTime('不正'), '');
});

test('CSV の値を引用し、式としては動かさない', () => {
  assert.equal(csvCell('ふつう'), 'ふつう');
  assert.equal(csvCell('カンマ, と "引用"'), '"カンマ, と ""引用"""');
  assert.equal(csvCell('改行\nあり'), '"改行\nあり"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(null), '');
});

test('サイトの起点をそろえ、正しくなければ空にする', () => {
  assert.equal(originOf('https://Example.COM/path/'), 'https://example.com');
  assert.equal(originOf('  https://orch.example.org  '), 'https://orch.example.org');
  assert.equal(originOf('not a url'), '');
  assert.equal(originOf(''), '');
});
