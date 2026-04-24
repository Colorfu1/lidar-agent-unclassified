from abc import ABC, abstractmethod
from typing import Any


class Stage(ABC):
    def __init__(self, stage_id: str, inputs: dict[str, Any]):
        self.stage_id = stage_id
        self.inputs = inputs

    @abstractmethod
    def run(self) -> dict[str, Any]:
        """Execute stage. Returns outputs dict. Raises on failure."""
        ...
