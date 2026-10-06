import test from 'node:test';
import assert from 'node:assert/strict';
import {contractPage,contractPages,contractCursorSection,CONTRACT_PAGE_BYTES} from './contract-transport.ts';

test('UTF-8 bounded contract transport is lossless, snapshot-scoped and resumable without mutable read state',()=>{
 const text='🧭'.repeat(7000)+'\nEND_NATIVE_AND_CATALOG';
 const pages=contractPages(text);assert.equal(pages.join(''),text);
 for(const page of pages)assert.ok(Buffer.byteLength(page)<=CONTRACT_PAGE_BYTES);
 const first=contractPage(text,'captainA/homeA','7,9');
 const cursor=/\{"cursor":"([A-Za-z0-9_-]+)"\}/.exec(first)[1];
 assert.equal(contractCursorSection(cursor),'7,9');
 const second=contractPage(text,'captainA/homeA','7,9',cursor);
 assert.equal(contractPage(text,'captainA/homeA','7,9',cursor),second,'lost response is retryable without skip or acknowledgement');
 assert.throws(()=>contractPage(text,'captainB/homeB','7,9',cursor),/another captain/);
 assert.throws(()=>contractPage(text+'changed','captainA/homeA','7,9',cursor),/changed selected-runtime/);
 assert.throws(()=>contractPage(text,'captainA/homeA','all',cursor),/changed selected-runtime/);
 const section='界'.repeat(200),unicodePage=contractPage(text,'captainA/homeA',section);
 const unicodeCursor=/\{"cursor":"([A-Za-z0-9_-]+)"\}/.exec(unicodePage)[1];
 assert.ok(unicodeCursor.length>600);assert.equal(contractCursorSection(unicodeCursor),section);
 assert.match(contractPage(text,'captainA/homeA',section,unicodeCursor),/FIRSTMATE_CONTRACT_PAGE 2\//);
 assert.throws(()=>contractPage(text,'captainA/homeA',section+'界'),/exceeds 200/);
 for(const cursor of ['../escape','a'.repeat(1201),Buffer.from('{"snapshot":"x","page":1}').toString('base64url')])assert.throws(()=>contractCursorSection(cursor),/Invalid contract cursor/);
});
