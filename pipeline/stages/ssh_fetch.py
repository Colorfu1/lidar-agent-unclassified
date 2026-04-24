import os
import subprocess
from typing import Any

from stages.base import Stage


class SSHFetchStage(Stage):
    def run(self) -> dict[str, Any]:
        remote_path = self.inputs["remote_path"]
        local_dir = self.inputs.get("local_dir", "/tmp/lidar-agent-fetch")
        os.makedirs(local_dir, exist_ok=True)

        ssh_host = os.environ.get("SSH_HOST", "root@localhost")
        ssh_port = os.environ.get("SSH_PORT", "3333")
        filename = os.path.basename(remote_path)
        local_path = os.path.join(local_dir, filename)

        cmd = ["scp", "-P", ssh_port, f"{ssh_host}:{remote_path}", local_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"SCP failed: {result.stderr}")
        return {"local_path": local_path}
