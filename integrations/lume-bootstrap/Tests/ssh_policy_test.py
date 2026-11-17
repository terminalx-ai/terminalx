#!/usr/bin/env python3
"""The options Lume's system ssh and scp fallback use.

Two kinds of check, neither of which touches a VM, the user's ~/.ssh or the
real pin file:

- `ssh -G` only evaluates configuration and exits. It shows the options win
  over a hostile ssh_config; the destination is a TEST-NET address and `-F`
  always names the file read.
- Host key pinning is checked for real, against an sshd this test starts on
  the loopback interface with a host key it has just generated, in a
  disposable directory. That sshd accepts no login at all, so every connection
  ends at host key verification or at authentication, and which one shows
  whether the key was accepted.
"""
import json
import os
import pwd
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

BINARY = Path(sys.argv.pop(1))
DESTINATION = 'lume@192.0.2.10'
HOSTILE = '''Host *
  ForwardAgent yes
  IdentityAgent /private/tmp/hostile-agent.sock
  RemoteForward 9000 127.0.0.1:22
  LocalForward 9001 127.0.0.1:22
  DynamicForward 9002
  SendEnv HOSTILE_*
  SetEnv HOSTILE=1
  PermitLocalCommand yes
  LocalCommand /usr/bin/true
  ProxyCommand /usr/bin/nc %h %p
  ProxyJump hostile.invalid
  ControlMaster auto
  ControlPath /private/tmp/hostile-%C
  ForwardX11 yes
  Tunnel yes
  PubkeyAuthentication yes
  GSSAPIAuthentication yes
  StrictHostKeyChecking no
  UserKnownHostsFile /private/tmp/hostile-known-hosts
  GlobalKnownHostsFile /private/tmp/hostile-global-known-hosts
  KnownHostsCommand /usr/bin/true
  UpdateHostKeys yes
  VerifyHostKeyDNS yes
  NoHostAuthenticationForLocalhost yes
  HostKeyAlgorithms ssh-rsa,ssh-ed25519
'''
HOST_KEY_OPTIONS = ['stricthostkeychecking', 'userknownhostsfile', 'globalknownhostsfile', 'knownhostscommand',
                    'updatehostkeys', 'verifyhostkeydns', 'nohostauthenticationforlocalhost', 'hostkeyalgorithms']

def fixture(*arguments, env=None):
    out = subprocess.run([str(BINARY), *arguments], check=True, capture_output=True, text=True, env=env).stdout
    return json.loads(out)

def evaluate(arguments):
    out = subprocess.run(['/usr/bin/ssh', '-G', *arguments, DESTINATION], check=True, capture_output=True,
        text=True, stdin=subprocess.DEVNULL).stdout
    config = {}
    for line in out.splitlines():
        key, _, value = line.partition(' ')
        config.setdefault(key, []).append(value)
    return config

class SSHPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tx-ssh-policy-', dir='/private/tmp')
        self.hostile = Path(self.temp.name) / 'hostile.conf'
        self.hostile.write_text(HOSTILE)
        self.addCleanup(self.temp.cleanup)
        self.policy = fixture('ssh-policy')
        self.arguments = self.policy['arguments']

    def test_the_fixture_is_hostile(self):
        c = evaluate(['-F', str(self.hostile)])
        self.assertEqual((c['forwardagent'], c['identityagent'], c['sendenv'], c['setenv']),
            (['yes'], ['/private/tmp/hostile-agent.sock'], ['HOSTILE_*'], ['HOSTILE=1']))
        for key in ['remoteforward', 'localforward', 'dynamicforward', 'proxycommand', 'controlpath']:
            self.assertIn(key, c)
        # It also turns host key checking off, as upstream Lume did.
        self.assertEqual((c['stricthostkeychecking'], c['userknownhostsfile'], c['updatehostkeys'], c['verifyhostkeydns'],
            c['knownhostscommand']), (['false'], ['/private/tmp/hostile-known-hosts'], ['true'], ['true'], ['/usr/bin/true']))

    def test_lume_reads_no_ssh_config_and_forwards_nothing(self):
        self.assertEqual(self.arguments[:2], ['-F', '/dev/null'], 'no user or system ssh_config')
        c = evaluate(self.arguments)
        self.assertEqual({k: c[k] for k in ['forwardagent', 'identityagent', 'forwardx11', 'clearallforwardings', 'tunnel',
            'permitlocalcommand', 'controlmaster', 'pubkeyauthentication', 'hostbasedauthentication', 'gssapiauthentication']},
            {'forwardagent': ['no'], 'identityagent': ['none'], 'forwardx11': ['no'], 'clearallforwardings': ['yes'],
             'tunnel': ['false'], 'permitlocalcommand': ['no'], 'controlmaster': ['false'], 'pubkeyauthentication': ['false'],
             'hostbasedauthentication': ['no'], 'gssapiauthentication': ['no']})
        for key in ['remoteforward', 'localforward', 'dynamicforward', 'sendenv', 'setenv', 'localcommand',
                    'proxycommand', 'proxyjump', 'controlpath']:
            self.assertNotIn(key, c)

    def test_each_option_wins_over_a_hostile_file_but_only_ignoring_it_drops_its_environment(self):
        swapped = ['-F', str(self.hostile)] + self.arguments[2:]
        c = evaluate(swapped)
        self.assertEqual((c['forwardagent'], c['identityagent'], c['clearallforwardings'], c['tunnel'], c['controlmaster']),
            (['no'], ['none'], ['yes'], ['false'], ['false']))
        for key in ['remoteforward', 'localforward', 'dynamicforward', 'proxycommand', 'proxyjump', 'controlpath']:
            self.assertNotIn(key, c)
        # Command-line options cannot clear SendEnv or SetEnv; `-F /dev/null` is what removes them.
        self.assertEqual((c['sendenv'], c['setenv']), (['HOSTILE_*'], ['HOSTILE=1']))
        # The host key options win over the file too, one by one.
        self.assertEqual({k: c.get(k) for k in HOST_KEY_OPTIONS}, self.host_key_options(self.policy['knownHosts']))

    def host_key_options(self, pins):
        return {'stricthostkeychecking': ['true'], 'userknownhostsfile': [pins], 'globalknownhostsfile': ['/dev/null'],
                # `ssh -G` prints no line for a command that is `none`.
                'knownhostscommand': None, 'updatehostkeys': ['false'], 'verifyhostkeydns': ['false'],
                'nohostauthenticationforlocalhost': ['no'], 'hostkeyalgorithms': ['ssh-ed25519']}

    def test_the_host_key_is_checked_strictly_against_one_pin_file_and_no_other_source(self):
        c = evaluate(self.arguments)
        self.assertEqual({k: c.get(k) for k in HOST_KEY_OPTIONS}, self.host_key_options(self.policy['knownHosts']))
        # Upstream's two options that turned the check off are gone, not merely preceded.
        options = [b for a, b in zip(self.arguments, self.arguments[1:]) if a == '-o']
        self.assertEqual([o for o in options if o.startswith(('StrictHostKeyChecking=', 'UserKnownHostsFile='))],
            ['StrictHostKeyChecking=yes', 'UserKnownHostsFile=' + self.policy['knownHosts']])
        self.assertEqual(len(options), len({o.split('=')[0] for o in options}), 'no option is given twice')

    def test_the_pin_file_is_in_the_account_home_and_no_environment_variable_moves_it(self):
        home = pwd.getpwuid(os.getuid()).pw_dir
        self.assertEqual((self.policy['accountHome'], self.policy['knownHosts']), (home, home + '/.lume/ssh_known_hosts'))
        hostile = dict(os.environ, HOME='/private/tmp/hostile-home', CFFIXED_USER_HOME='/private/tmp/hostile-home',
            XDG_CONFIG_HOME='/private/tmp/hostile-home', LUME_HOME='/private/tmp/hostile-home')
        self.assertEqual(fixture('ssh-policy', env=hostile), self.policy)
        # A home ssh would split, expand or read as relative names no pin file,
        # and with none every host is refused.
        no_pin = self.policy['noPin']
        self.assertFalse(Path(no_pin).exists())
        for bad in ['', 'relative/home', '/Users/a b', '/Users/%h', '/Users/~x', '/Users/a/', '/Users//a', '/Users/a"b', '/Users/a$b', '~']:
            self.assertEqual(fixture('ssh-policy', bad)['knownHosts'], no_pin, bad)
        self.assertEqual(fixture('ssh-policy', '/Users/dev_user-1.x')['knownHosts'], '/Users/dev_user-1.x/.lume/ssh_known_hosts')


class PinnedHostKey(unittest.TestCase):
    """Against a real sshd on loopback with a throwaway host key."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tx-ssh-pin-', dir='/private/tmp')
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        for name in ['guest', 'other']:
            subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', str(self.dir / name)], check=True)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        # No login can succeed: no authorized keys, no passwords, no PAM.
        self.log = (self.dir / 'sshd.log').open('w')
        self.sshd = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', '/dev/null', '-o', f'Port={self.port}',
            '-o', 'ListenAddress=127.0.0.1', '-o', f'HostKey={self.dir / "guest"}', '-o', 'PidFile=none', '-o', 'UsePAM=no',
            '-o', 'AuthorizedKeysFile=none', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'],
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 15
        while True:
            try:
                socket.create_connection(('127.0.0.1', self.port), timeout=1).close()
                break
            except OSError:
                self.assertIsNone(self.sshd.poll(), 'sshd exited: ' + (self.dir / 'sshd.log').read_text())
                self.assertLess(time.monotonic(), deadline, 'sshd did not listen')
                time.sleep(0.1)

    def stop(self):
        self.sshd.terminate()
        self.sshd.wait(timeout=10)
        self.log.close()

    def key(self, name):
        kind, blob = (self.dir / f'{name}.pub').read_text().split()[:2]
        return f'{kind} {blob}'

    def pins(self, name, text):
        path = self.dir / name
        path.write_text(text)
        return path

    def closed(self):
        """sshd's own record of each connection that ended before a login."""
        return re.findall(r'^Connection (?:closed|reset) by (.*) \[preauth\]$', (self.dir / 'sshd.log').read_text(), re.M)

    def connect(self, pins, program='ssh'):
        """One connection with the policy's options over `pins`, as
        SystemSSHClient builds them plus the port and no way to answer a
        prompt. Returns whether the host key was accepted, which sshd records:
        only a client that accepted it goes on to name a user."""
        arguments = fixture('ssh-policy-with', str(pins))['arguments']
        before = len(self.closed())
        if program == 'ssh':
            command = ['/usr/bin/ssh', *arguments, '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
                '-p', str(self.port), 'lume@127.0.0.1', 'true']
        else:
            payload = self.pins('payload', 'x')
            command = ['/usr/bin/scp', '-q', '-r', *arguments, '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10',
                '-o', 'BatchMode=yes', '-P', str(self.port), '--', str(payload), 'lume@127.0.0.1:drop/']
        result = subprocess.run(command, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
        self.assertNotEqual(result.returncode, 0, 'this sshd accepts no login')
        deadline = time.monotonic() + 10
        while len(self.closed()) == before:
            self.assertLess(time.monotonic(), deadline, 'sshd recorded no connection: ' + result.stderr)
            time.sleep(0.05)
        peer = self.closed()[before]
        accepted = ' user ' in peer
        if program == 'ssh':
            # ssh says the same thing itself (scp -q prints neither).
            self.assertEqual('Host key verification failed' in result.stderr, not accepted, result.stderr)
            self.assertEqual('Permission denied' in result.stderr, accepted, result.stderr)
        return accepted

    def test_only_the_pinned_host_key_is_accepted(self):
        address = f'[127.0.0.1]:{self.port}'
        pinned = self.pins('pinned', f'{address} {self.key("guest")}\n')
        for program in ['ssh', 'scp']:
            # Past host key verification: what fails is the login this sshd never grants.
            self.assertTrue(self.connect(pinned, program), program)
        cases = {
            'no pin at all': '',
            'another key for this guest': f'{address} {self.key("other")}\n',
            'this key for another address': f'[127.0.0.2]:{self.port} {self.key("guest")}\n',
            'this key for another port': f'[127.0.0.1]:{self.port + 1} {self.key("guest")}\n',
        }
        for name, text in cases.items():
            pins = self.pins('candidate', text)
            for program in ['ssh', 'scp']:
                self.assertFalse(self.connect(pins, program), f'{name}: {program}')
            # Nothing is learned on first use and no pin is replaced.
            self.assertEqual(pins.read_text(), text, name)
        self.assertEqual(pinned.read_text(), f'{address} {self.key("guest")}\n')

    def test_without_a_pin_file_every_host_is_refused_and_none_is_created(self):
        missing = self.dir / 'absent' / 'ssh_known_hosts'
        self.assertFalse(self.connect(missing))
        self.assertFalse(missing.parent.exists())
        no_pin = Path(fixture('ssh-policy')['noPin'])
        self.assertFalse(self.connect(no_pin))
        self.assertFalse(no_pin.exists())


if __name__ == '__main__':
    unittest.main()
