import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePresets, loadPresets, savePresetList, presetColumns } from './presets.js';
const preset = { name: 'Monthly export', delimiter: 'auto', normalizeDates: false, options: {clean_headers:true,trim_cells:true,drop_empty_columns:true,remove_duplicates:true}, columns:['email'] };
test('whitelists settings and never persists file or row data',()=>{
  let stored; const safe=savePresetList({setItem:(k,v)=>stored=v},[{...preset,file:'secret.csv',rows:[['private']],options:{...preset.options,extra:'secret'}}]);
  assert.equal(safe.length,1); assert.ok(!stored.includes('secret'));assert.ok(!stored.includes('private'));assert.ok(!stored.includes('extra'));
});
test('corrupt or unavailable storage does not break startup',()=>{
 assert.deepEqual(loadPresets({getItem:()=>'{'}),[]);assert.deepEqual(loadPresets({getItem:()=>{throw Error('blocked')}}),[]);
});
test('rejects malformed settings',()=>{
 assert.deepEqual(normalizePresets([{...preset,delimiter:'|'}, {...preset,options:{}}]),[]);
});
test('deduplicates names and limits saved presets',()=>{
 assert.equal(normalizePresets([preset,{...preset,name:' MONTHLY EXPORT '}]).length,1);
 assert.equal(normalizePresets(Array.from({length:15},(_,i)=>({...preset,name:`p${i}`}))).length,10);
});
test('requires matching duplicate columns, never falls back silently',()=>{
 assert.deepEqual(presetColumns(preset,[{clean:'email'}]),['email']);
 assert.throws(()=>presetColumns(preset,[{clean:'name'}]),/missing/);
 assert.deepEqual(presetColumns({...preset,options:{...preset.options,remove_duplicates:false}},[]),[]);
});
test('round trips supported settings',()=>{
 let value;const storage={setItem:(k,v)=>value=v,getItem:()=>value};savePresetList(storage,[preset]);assert.deepEqual(loadPresets(storage),[preset]);
});
