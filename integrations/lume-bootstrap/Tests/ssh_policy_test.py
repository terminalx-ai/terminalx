#!/usr/bin/env python3
"""The fixed options Lume's system ssh and scp fallback use, against a hostile
ssh_config. `ssh -G` only evaluates the configuration and exits: no connection
is made, the destination is a TEST-NET address, and `-F` always names the file
read, so the user's own ~/.ssh/config is never read."""
import json
import subprocess
import sys
import tempfile
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
'''

def policy():
    out = subprocess.run([str(BINARY), 'ssh-policy'], check=True, capture_output=True, text=True).stdout
    return json.loads(out)['arguments']

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
        self.arguments = policy()

    def test_the_fixture_is_hostile(self):
        c = evaluate(['-F', str(self.hostile)])
        self.assertEqual((c['forwardagent'], c['identityagent'], c['sendenv'], c['setenv']),
            (['yes'], ['/private/tmp/hostile-agent.sock'], ['HOSTILE_*'], ['HOSTILE=1']))
        for key in ['remoteforward', 'localforward', 'dynamicforward', 'proxycommand', 'controlpath']:
            self.assertIn(key, c)

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

if __name__ == '__main__':
    unittest.main()
