import importlib
import os
import sys
import types
import unittest
from unittest.mock import patch


class ProviderFactoryTests(unittest.TestCase):
    def setUp(self):
        self.factory = importlib.import_module("app.llm.provider_factory")

    def test_groq_is_the_default_provider(self):
        fake_module = types.ModuleType("app.llm.groq_provider")

        class FakeGroqProvider:
            def __init__(self, model):
                self.model = model

        fake_module.GroqProvider = FakeGroqProvider

        with patch.dict(os.environ, {}, clear=True), patch.dict(
            sys.modules, {"app.llm.groq_provider": fake_module}
        ):
            provider = self.factory.get_llm_provider()

        self.assertIsInstance(provider, FakeGroqProvider)
        self.assertEqual(provider.model, "qwen/qwen3.6-27b")

    def test_claude_provider_uses_configured_model(self):
        fake_module = types.ModuleType("app.llm.claude_provider")

        class FakeClaudeProvider:
            def __init__(self, model):
                self.model = model

        fake_module.ClaudeProvider = FakeClaudeProvider

        environment = {
            "LLM_PROVIDER": "claude",
            "CLAUDE_MODEL": "claude-test-model",
        }
        with patch.dict(os.environ, environment, clear=True), patch.dict(
            sys.modules, {"app.llm.claude_provider": fake_module}
        ):
            provider = self.factory.get_llm_provider()

        self.assertIsInstance(provider, FakeClaudeProvider)
        self.assertEqual(provider.model, "claude-test-model")

    def test_unknown_provider_is_rejected(self):
        with patch.dict(os.environ, {"LLM_PROVIDER": "unknown"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Unsupported LLM_PROVIDER"):
                self.factory.get_llm_provider()


class ClaudeProviderTests(unittest.TestCase):
    def _load_provider_module(self, response_content=None):
        fake_anthropic = types.ModuleType("anthropic")

        class FakeMessages:
            def create(self, **kwargs):
                self.last_request = kwargs
                return types.SimpleNamespace(content=response_content or [])

        class FakeAnthropic:
            def __init__(self, api_key):
                self.api_key = api_key
                self.messages = FakeMessages()

        fake_anthropic.Anthropic = FakeAnthropic

        with patch.dict(sys.modules, {"anthropic": fake_anthropic}):
            sys.modules.pop("app.llm.claude_provider", None)
            module = importlib.import_module("app.llm.claude_provider")

        return module

    def test_api_key_is_required(self):
        module = self._load_provider_module()

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "ANTHROPIC_API_KEY"):
                module.ClaudeProvider()

    def test_generate_returns_only_text_blocks(self):
        blocks = [
            types.SimpleNamespace(type="thinking", thinking="internal"),
            types.SimpleNamespace(type="text", text="Bonjour "),
            types.SimpleNamespace(type="text", text="Robia"),
        ]
        module = self._load_provider_module(blocks)

        with patch.dict(
            os.environ, {"ANTHROPIC_API_KEY": "test-key"}, clear=True
        ):
            provider = module.ClaudeProvider(model="claude-test-model")
            result = provider.generate("system", "user")

        self.assertEqual(result, "Bonjour Robia")
        self.assertEqual(provider.client.messages.last_request["system"], "system")
        self.assertEqual(
            provider.client.messages.last_request["model"], "claude-test-model"
        )


if __name__ == "__main__":
    unittest.main()
