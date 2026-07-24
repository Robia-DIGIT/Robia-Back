from abc import ABC, abstractmethod


class LLMProvider(ABC):
    @abstractmethod
    def generate(self, system_prompt: str, user_prompt: str) -> str:
        """
        Génère du texte à partir d'un prompt système et d'un prompt utilisateur.
        Toute implémentation concrète (Groq, Claude, OpenAI...) doit respecter
        cette signature pour rester interchangeable.
        """
        raise NotImplementedError