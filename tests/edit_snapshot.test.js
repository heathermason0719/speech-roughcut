'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeExportRevision } = require('../scripts/lib/export_revision');

test('第三份快照持久化失败时不发布 revision，先前版本保持完整', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'roughcut-snapshot-atomic-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const names={fcpxmlName:'sample.fcpxml',learningDiffName:'learning_diff.json',snapshotName:'edit_snapshot.json'};
  const write=directory=>{
    for(const name of Object.values(names)) fs.writeFileSync(path.join(directory,name),name);
    return names;
  };
  const first=writeExportRevision(root,write);
  const failingFs={...fs,openSync(file,...args){
    if(String(file).endsWith('/edit_snapshot.json')) throw Object.assign(new Error('snapshot fsync unavailable'),{code:'EIO'});
    return fs.openSync(file,...args);
  }};
  assert.throws(()=>writeExportRevision(root,write,{fsModule:failingFs}),{code:'EIO'});
  assert.deepEqual(fs.readdirSync(path.join(root,'exports')),[first.revision]);
  for(const name of Object.values(names)) assert.equal(fs.readFileSync(path.join(first.directory,name),'utf8'),name);
});
