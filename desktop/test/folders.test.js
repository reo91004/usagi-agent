import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshConfigHosts, homeUser, candidateHosts, remoteUrl } from '../src/folders.js';

const CFG = `
Host *
  ServerAliveInterval 30
Host pacl-reo
  HostName 10.0.0.1
  User reo
Host pacl-205 pacl-208 # 같은 계정
  User user
Host pacl-ugrp
  User ugrp
  Port 50000
Host gpu-*
  User x
`;

test('sshConfigHosts: 별칭과 User, 패턴은 제외', () => {
  assert.deepEqual(sshConfigHosts(CFG), [
    { host: 'pacl-reo', user: 'reo' }, { host: 'pacl-205', user: 'user' }, { host: 'pacl-208', user: 'user' }, { host: 'pacl-ugrp', user: 'ugrp' },
  ]);
});

test('homeUser·candidateHosts: /home/<user>/ 와 같은 User 의 서버만', () => {
  const hosts = sshConfigHosts(CFG);
  assert.equal(homeUser('/home/user/reo/dp'), 'user');
  assert.equal(homeUser('/Users/me/app'), '');
  assert.deepEqual(candidateHosts('/home/user/reo/dp', hosts), ['pacl-205', 'pacl-208']);
  assert.deepEqual(candidateHosts('/srv/x', hosts), []);
});

test('remoteUrl: 별칭만, 절대 경로만, 조각마다 인코딩', () => {
  const hosts = sshConfigHosts(CFG);
  assert.equal(remoteUrl('pacl-205', '/home/user/reo/dp', hosts), 'vscode://vscode-remote/ssh-remote+pacl-205/home/user/reo/dp');
  assert.equal(remoteUrl('pacl-205', '/home/user/my dir/a#b?c', hosts), 'vscode://vscode-remote/ssh-remote+pacl-205/home/user/my%20dir/a%23b%3Fc');
  assert.equal(remoteUrl('evil', '/x', hosts), null);
  assert.equal(remoteUrl('pacl-205', 'relative/x', hosts), null);
  assert.equal(remoteUrl('pacl-205', '/x\n/y', hosts), null);
});
