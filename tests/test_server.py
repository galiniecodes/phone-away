"""HTTP contracts for the loopback-only static server; no camera or network APIs."""
import http.client
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import server


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.make_server(0)
        cls.port = cls.httpd.server_port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_binds_to_loopback_only(self):
        self.assertEqual(self.httpd.server_address[0], '127.0.0.1')

    def test_static_app_and_security_headers(self):
        status, headers, raw = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertIn(b'Phone Away', raw)
        self.assertIn(b'value="0.25" selected', raw)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertIn("connect-src 'self'", headers['Content-Security-Policy'])
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertIn('microphone=()', headers['Permissions-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_head_matches_get_without_response_body(self):
        _, get_headers, content = self.request('GET', '/app.js')
        status, headers, raw = self.request('HEAD', '/app.js')
        self.assertEqual(status, 200)
        self.assertEqual(raw, b'')
        self.assertEqual(int(headers['Content-Length']), len(content))
        self.assertEqual(headers['Content-Type'], get_headers['Content-Type'])
        self.assertEqual(self.request('HEAD', '/missing')[0], 404)

    def test_runtime_assets_have_correct_mime_types(self):
        for path, expected in [('/vendor/onnxruntime/ort.webgpu.min.mjs', 'text/javascript'),
                               ('/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.wasm', 'application/wasm'),
                               ('/models/yolo26/yolo26n.onnx', 'application/octet-stream')]:
            with self.subTest(path=path):
                status, headers, _ = self.request('HEAD', path)
                self.assertEqual(status, 200)
                self.assertEqual(headers['Content-Type'], expected)
                self.assertGreater(int(headers['Content-Length']), 0)

    def test_removed_api_routes_are_unavailable(self):
        for path in ['/api/status', '/api/analyze']:
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 404)
                self.assertEqual(self.request('POST', path, '{}')[0], 405)

    def test_uploads_are_rejected_before_reading_body(self):
        status, _, _ = self.request('POST', '/', headers={'Content-Length': '999999999'})
        self.assertEqual(status, 405)

    def test_dns_rebinding_host_denied(self):
        for method in ['GET', 'POST']:
            with self.subTest(method=method):
                status, _, _ = self.request(method, '/', headers={'Host': 'evil.example:' + str(self.port)})
                self.assertEqual(status, 403)
        self.assertEqual(self.request('GET', '/', headers={'Host': 'localhost:' + str(self.port)})[0], 200)

    def test_static_root_and_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            public = root / 'public'
            public.mkdir()
            (public / 'index.html').write_text('<h1>Phone Away</h1>')
            (root / 'secret.txt').write_text('secret')
            (public / 'link.txt').symlink_to(root / 'secret.txt')
            with patch.object(server, 'PUBLIC_DIR', public):
                self.assertEqual(self.request('GET', '/')[0], 200)
                for path in ['/../secret.txt', '/%2e%2e/secret.txt', '/link.txt', '/server.py', '/%00', '/a%5cb']:
                    with self.subTest(path=path):
                        self.assertEqual(self.request('GET', path)[0], 404)


if __name__ == '__main__':
    unittest.main()
