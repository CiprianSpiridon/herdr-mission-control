import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..'),read=file=>fs.readFile(path.join(root,file),'utf8');
const DOCS=['README.md','docs/access.md','docs/configuration.md'];

test('README and access docs describe resume after restart as built', async()=>{
  const readme=await read('README.md'),access=await read('docs/access.md');
  for(const phrase of ['Agents come back after a restart','Agents you quit stay closed','Set up Codex resume','--no-daemon','looks exactly like quitting','claude --resume <id>','running-agents.json','hc send'])assert.ok(readme.includes(phrase),'README: '+phrase);
  for(const phrase of ['## Resume after restart (Tabs and Reopen)','running-agents.json','lsof','/proc/<pid>/fd','holds open','Transcripts and session contents are never read','restart-claims','hc send','mission-control.codex-session','hooks.json','first line','never writes Codex','Network:** none'])assert.ok(access.includes(phrase),'access: '+phrase);
  assert.ok(!access.includes('or change global tool configuration'),'the old blanket claim is replaced by the Codex hook exception');
});

test('configuration documents the setting, the Codex hook and the offer rules', async()=>{
  const config=await read('docs/configuration.md');
  for(const phrase of ['## Resume after restart','"resumeAfterRestart": false','on by default','less than 15 minutes','Time powered off does not expire','overnight','Resume N','Dismiss','24 hours','Set up Codex resume','$CODEX_HOME','trust the hook','--no-daemon','running-agents.json'])assert.ok(config.includes(phrase),'configuration: '+phrase);
});

test('no doc promises resuming quit agents, or any fallback to the last conversation', async()=>{
  for(const file of DOCS){
    const text=await read(file);
    for(const line of text.split('\n').filter(l=>/restart|resume/i.test(l))){
      assert.ok(!/\b(?:quit|closed)\b[^.]*\b(?:come back|are resumed|is resumed|resume)\b/i.test(line.replace(/stay closed|stays closed|not resumed|never resumed|are forgotten/gi,'')),file+': '+line);
      assert.ok(!/(?:uses?|falls? back to|with) `?--(?:last|continue)`?/i.test(line)||/never/i.test(line),file+': '+line);
    }
  }
});
