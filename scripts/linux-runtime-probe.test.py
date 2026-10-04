import hashlib
import importlib.util
import contextlib
import io
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('linux-runtime-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def exchange(self, reply):
        with tempfile.TemporaryDirectory(prefix='tx-', dir='/tmp') as directory:
            endpoint = str(Path(directory) / 'rpc.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(endpoint)
                server.listen(1)
                server.settimeout(2)
                errors = []

                def serve():
                    try:
                        connection, _ = server.accept()
                        with connection:
                            connection.settimeout(2)
                            with connection.makefile('rb') as stream:
                                request = json.loads(stream.readline())
                            self.assertEqual(request['method'], 'status.get')
                            self.assertEqual(request['authToken'], 'private-token')
                            connection.sendall(reply(request))
                    except Exception as error:
                        errors.append(error)

                worker = threading.Thread(target=serve)
                worker.start()
                try:
                    return probe.runtime_status({'authToken': 'private-token', 'runtimeId': 'runtime-1',
                                                 'transports': [{'kind': 'unix', 'endpoint': endpoint}]}, 1)
                finally:
                    worker.join(3)
                    self.assertFalse(worker.is_alive())
                    if errors:
                        raise errors[0]

    def frame(self, request, **overrides):
        frame = {'id': request['id'], 'ok': True,
                 'result': {'runtimeId': 'runtime-1', 'appVersion': '1.2.3',
                            'runtimeProtocolVersion': 1, 'capabilities': ['terminal.binary-stream.v1'],
                            'authToken': 'must-not-be-reported'}}
        frame.update(overrides)
        return (json.dumps(frame) + '\n').encode()

    def test_reads_live_socket_with_keepalive_and_projects_only_public_fields(self):
        result = self.exchange(lambda request: b'{"_keepalive":true}\n' + self.frame(request))
        self.assertEqual(result['appVersion'], '1.2.3')
        self.assertEqual(result['runtimeIdentitySha256'], hashlib.sha256(b'runtime-1').hexdigest())
        self.assertNotIn('must-not-be-reported', json.dumps(result))
        self.assertNotIn('authToken', result)

    def test_rejects_changed_runtime(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: self.frame(request, _meta={'runtimeId': 'replacement'}))

    def test_rejects_wrong_response_id(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: self.frame(request, id='another-request'))

    def test_rejects_authentication_error(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: self.frame(request, ok=False))

    def test_rejects_clean_close_without_response(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: b'')

    def test_rejects_missing_version_and_capabilities(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: self.frame(request, result={'runtimeId': 'runtime-1'}))

    def test_rejects_invalid_envelope_metadata(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: self.frame(request, _meta=None))

    def test_rejects_oversized_reply(self):
        with patch.object(probe, 'LIMIT', 32), self.assertRaises(ValueError):
            self.exchange(lambda request: self.frame(request))

    def test_rejects_malformed_json(self):
        with self.assertRaises(ValueError):
            self.exchange(lambda request: b'{broken\n')

    def test_main_reports_failed_artifact_without_contacting_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / 'runtime'
            artifact.write_bytes(b'wrong')
            output = io.StringIO()
            with patch('sys.argv', ['probe', '--sha256', '0' * 64,
                                    '--artifact', str(artifact), '--metadata', '/unused']), \
                    patch.object(probe.platform, 'system', return_value='Linux'), \
                    patch.object(probe, 'runtime_status') as rpc, \
                    contextlib.redirect_stdout(output):
                self.assertEqual(probe.main(), 1)
            rpc.assert_not_called()
            report = json.loads(output.getvalue())
            self.assertEqual(report['artifact'], 'fail')
            self.assertEqual(report['rpc'], 'not-run')

    def test_main_rejects_non_linux_without_reading_files(self):
        output = io.StringIO()
        with patch('sys.argv', ['probe', '--sha256', '0' * 64, '--metadata', '/unused']), \
                patch.object(probe.platform, 'system', return_value='Darwin'), \
                patch.object(probe, 'artifact_matches') as artifact, \
                contextlib.redirect_stdout(output):
            self.assertEqual(probe.main(), 1)
        artifact.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['result'], 'blocked-non-linux-host')

    def test_main_does_not_print_failure_secrets(self):
        output = io.StringIO()
        with patch('sys.argv', ['probe', '--sha256', '0' * 64, '--metadata', '/unused']), \
                patch.object(probe.platform, 'system', return_value='Linux'), \
                patch.object(probe, 'artifact_matches', return_value=True), \
                patch.object(probe, 'read_json', side_effect=ValueError('secret-token')), \
                contextlib.redirect_stdout(output):
            self.assertEqual(probe.main(), 1)
        self.assertNotIn('secret-token', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['rpc'], 'fail')

    def test_hashes_artifact_bytes_not_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / 'runtime'
            artifact.write_bytes(b'approved-artifact')
            expected = hashlib.sha256(artifact.read_bytes()).hexdigest()
            self.assertTrue(probe.artifact_matches(artifact, expected))
            artifact.write_bytes(b'corrupt-artifact')
            self.assertFalse(probe.artifact_matches(artifact, expected))

    def test_corrupt_metadata_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / 'state.json'
            metadata.write_bytes(b'{broken')
            with self.assertRaises(ValueError):
                probe.read_json(metadata)
            self.assertEqual(metadata.read_bytes(), b'{broken')


if __name__ == '__main__':
    unittest.main()
