import test from 'node:test';
import assert from 'node:assert/strict';
import {npmCiInvocation} from './grindzone-npm-command.mjs';

test('Linux host keeps its existing npm ci command and arguments',()=>{
  assert.deepEqual(npmCiInvocation('linux','/usr/bin/node'),{command:'npm',args:['ci','--prefix','cloud','--ignore-scripts','--no-audit','--no-fund']});
});

test('Windows host invokes npm CLI through Node rather than spawning npm.cmd',()=>{
  const node='C:\\Program Files\\nodejs\\node.exe',cli='C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(npmCiInvocation('win32',node,cli),{command:node,args:[cli,'ci','--prefix','cloud','--ignore-scripts','--no-audit','--no-fund']});
  assert.equal(npmCiInvocation('win32',node,'C:\\tools\\pnpm.cmd').args[0],cli);
});
