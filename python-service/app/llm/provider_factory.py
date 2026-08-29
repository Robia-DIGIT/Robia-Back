import os

from app.llm.base import LLMProvider


def get_llm_provider() -> LLMProvider:
    provider_name = os.getenv("LLM_PROVIDER", "groq").strip().lower()

    if provider_name == "groq":
        from app.llm.groq_provider import GroqProvider

        model = os.getenv("GROQ_MODEL", "qwen/qwen3.6-27b")
        return GroqProvider(model=model)

    if provider_name in {"claude", "anthropic"}:
        from app.llm.claude_provider import ClaudeProvider

        model = os.getenv("CLAUDE_MODEL", "claude-sonnet-5")
        return ClaudeProvider(model=model)

    raise ValueError(
        "Unsupported LLM_PROVIDER. Expected one of: groq, claude, anthropic"
    )
