import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFile(path.join(root,file),'utf8');

test('README tells people what the Control panel shows, does, reads, changes, reaches and never touches',async()=>{
  const readme=await read('README.md');
  assert.match(readme,/\*\*Keep your mods and layouts up to date\.\*\*/,'feature bullet');
  assert.match(readme,/\| \[`mission-control-control-panel\/`\]\(mission-control-control-panel\/RECIPE\.md\) \| <a href="mission-control-control-panel\/preview\.png"><img src="mission-control-control-panel\/preview\.png"[^|]*\| [^|]*disable, enable, uninstall and restore/,'package row with its screenshot');
  const section=readme.slice(readme.indexOf('### The Control panel'),readme.indexOf('## Good to know'));assert.ok(section.length>200,'the Control panel section');
  for(const state of ['Up to date','Edited by you','Update available','Conflict','Source unknown','Disabled','Built into Herdr','Managed by the installer'])assert.ok(section.includes(state),'status '+state);
  for(const statement of ['only when you click a button and confirm','`installed.json`','`keys.json`','only the keys that item added','never replaced','built-in mods and layouts','the layout on screen','kept for 30 days so you can restore them, and then deleted','https://assets.herdr.dev/','https://github.com/','No account or token'])
    assert.ok(section.includes(statement),statement);
  assert.match(readme,/sessions and Control panel mods/,'the layouts include the Control panel mod');
});

test('docs/access.md has the Control panel row: files, programs, network and what it never changes',async()=>{
  const access=await read('docs/access.md'),row=access.split('\n').find(line=>line.startsWith('| Control panel |'));
  assert.ok(row,'Control panel row');
  for(const part of ['`appHome()/mods/`','`appHome()/layouts/`','`installed.json`','`keys.json`','only the keys that item added','kept 30 days, then deleted','`appHome()/mission-control/control-panel/`','Never changes built-in or installer-managed items','`git`','`herdr-app check`','Node.js 22+','https://assets.herdr.dev/','https://github.com/','no account or token'])
    assert.ok(row.includes(part),part);
});
