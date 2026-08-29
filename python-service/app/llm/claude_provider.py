import os

from anthropic import Anthropic

from app.llm.base import LLMProvider


class ClaudeProvider(LLMProvider):
    def __init__(self, model: str = "claude-sonnet-5"):
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY is not defined in environment variables"
            )

        self.client = Anthropic(api_key=api_key)
        self.model = model

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self.client.messages.create(
            model=self.model,
            max_tokens=2000,
            system=system_prompt,
            messages=[
                {"role": "user", "content": user_prompt},
            ],
        )

        content = "".join(
            block.text
            for block in response.content
            if getattr(block, "type", None) == "text"
        )
        if not content:
            raise ValueError("Claude response did not contain any text")
        return content
