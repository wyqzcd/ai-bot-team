import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, truncate } from '../src/stringy.js';

test('slugify 把空格和大小写转成连字符 slug', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('foo_bar'), 'foo-bar');
});

test('slugify 去掉特殊字符并压缩连续连字符', () => {
  assert.equal(slugify('Hello!!! World---2026'), 'hello-world-2026');
  assert.equal(slugify('---'), '');
});

test('slugify keepChinese 为 true 时保留中文字符', () => {
  assert.equal(slugify('你好 World', true), '你好-world');
});

test('slugify keepChinese 为 true 时保留扩展区汉字', () => {
  assert.equal(slugify('𠀀𠀁', true), '𠀀𠀁');
});

test('slugify 默认仍删除中文字符', () => {
  assert.equal(slugify('你好 World'), 'world');
});

test('slugify 中文与数字、连字符混排时保持结构', () => {
  assert.equal(slugify('你好-2026 World', true), '你好-2026-world');
  assert.equal(slugify('中文_测试 2026', true), '中文-测试-2026');
});

test('slugify 在驼峰边界插入连字符', () => {
  assert.equal(slugify('fooBarBaz'), 'foo-bar-baz');
  assert.equal(slugify('FooBar'), 'foo-bar');
  assert.equal(slugify('foo2Bar'), 'foo2-bar');
  assert.equal(slugify('2Foo'), '2-foo');
  assert.equal(slugify('fooBAR'), 'foo-bar');
  assert.equal(slugify('XMLHttpRequest'), 'xmlhttp-request');
  assert.equal(slugify('FOO'), 'foo');
  assert.equal(slugify('XML'), 'xml');
  assert.equal(slugify(''), '');
  assert.equal(slugify('你好World', true), '你好world');
  assert.equal(slugify('你好World', false), 'world');
  assert.equal(slugify('foo-Bar'), 'foo-bar');
  assert.equal(slugify('foo_barBaz'), 'foo-bar-baz');
});

test('slugify 连续大写全部小写化', () => {
  assert.equal(slugify('ABC'), 'abc');
});

test('slugify 数字后接大写视为驼峰边界', () => {
  assert.equal(slugify('a1B2c3'), 'a1-b2c3');
});

test('slugify 开头数字保留', () => {
  assert.equal(slugify('123abc'), '123abc');
});

test('truncate 超长时截断加省略号', () => {
  assert.equal(truncate('abcdefghij', 5), 'ab...');
  assert.equal(truncate('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopq...');
});

test('truncate 不超长时原样返回', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('', 5), '');
});

test('truncate limit 不大于省略号长度时按 limit 硬截断', () => {
  assert.equal(truncate('abcdef', 2, '...'), 'ab');
  assert.equal(truncate('abcdef', 3, '...'), 'abc');
  assert.equal(truncate('abcdef', 0, '...'), '');
});
