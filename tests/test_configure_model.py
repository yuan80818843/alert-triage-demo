import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("configure_model", Path(__file__).resolve().parents[1] / "scripts" / "configure-model.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigureModelTests(unittest.TestCase):
    def args(self, **overrides):
        return types.SimpleNamespace(**{"base_url": "https://api.deepseek.com", "protocol": "chat_completions", **overrides})

    @patch.object(module.sys.stdin, "isatty", return_value=False)
    def test_noninteractive_input_is_refused(self, _):
        with self.assertRaisesRegex(module.SetupError, "interactive SSH"):
            module.configure(self.args())

    @patch.object(module.sys.stdin, "isatty", return_value=True)
    def test_url_credentials_are_refused(self, _):
        with self.assertRaisesRegex(module.SetupError, "HTTPS"):
            module.configure(self.args(base_url="https://user:password@example.invalid"))

    @patch.object(module.sys.stdin, "isatty", return_value=True)
    @patch.object(module, "read_admin_token", return_value="test-admin-token-not-real")
    @patch.object(module.getpass, "getpass", return_value="test-key-not-real")
    def test_real_rpc_shape_and_no_key_in_output(self, _input, _token, _tty):
        calls = []

        def rpc(method, payload, token):
            calls.append((method, module.json.loads(module.json.dumps(payload))))
            if method == "ListProviders":
                return {"providers": []}
            if method == "GetProvider":
                return {"provider": {"enabled": True, "apiKeySet": True}}
            return {}

        with patch.object(module, "rpc", side_effect=rpc), patch("builtins.print") as output:
            module.configure(self.args())
        create = next(payload for method, payload in calls if method == "CreateProvider")
        self.assertEqual(create["provider"]["models"]["models"][0]["id"], "deepseek-v4-flash")
        self.assertEqual(create["provider"]["apiKey"], "test-key-not-real")
        self.assertNotIn("test-key-not-real", str(output.call_args_list))
        self.assertTrue(any(method == "SetDefaultModel" for method, _ in calls))


if __name__ == "__main__":
    unittest.main()
