import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDiagrams } from '../bin/editor-discovery.mjs';

test('project discovery finds typed sources, honors delivery/session pairs, and ignores dependencies', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archify-discover-'));
 try {
  const source=path.join(root,'system.json'), output=path.join(root,'delivered.html');
  const spec={diagram_type:'architecture',components:[],meta:{title:'System'}};
  fs.writeFileSync(source,JSON.stringify(spec));
  assert.equal(discoverDiagrams(root)[0].output,path.join(root,'system.html'));
  fs.mkdirSync(path.join(root,'node_modules'));
  fs.writeFileSync(path.join(root,'node_modules','ignored.json'),JSON.stringify(spec));
  fs.writeFileSync(output,'artifact');
  fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify({ok:true,command:'deliver',type:'architecture',input:source,output}));
  assert.equal(discoverDiagrams(root).length,1);
  assert.equal(discoverDiagrams(root)[0].output,output);
  fs.writeFileSync(output+'.editor-session.json',JSON.stringify({input:source,output,quality:'standard'}));
  assert.equal(discoverDiagrams(root)[0].quality,'standard');
  fs.writeFileSync(path.join(root,'second.json'),JSON.stringify(spec));
  assert.equal(discoverDiagrams(root).length,2);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
