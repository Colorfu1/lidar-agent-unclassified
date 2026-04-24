import { execSync } from "child_process";

interface BranchInfo {
  name: string;
  lastCommit: string;
}

interface FileDiff {
  path: string;
  status: string;
  diff: string;
}

export class BranchMerger {
  constructor(private repoPath: string) {}

  listBranches(): BranchInfo[] {
    const output = execSync("git branch -a --format='%(refname:short)|%(objectname:short)'", {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, lastCommit] = line.split("|");
        return { name, lastCommit };
      });
  }

  getFileDiffs(source: string, target: string): FileDiff[] {
    const files = execSync(`git diff --name-status ${target}...${source}`, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
    return files
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split("\t");
        const filePath = pathParts.join("\t");
        const diff = execSync(`git diff ${target}...${source} -- "${filePath}"`, {
          cwd: this.repoPath,
          encoding: "utf-8",
        });
        return { path: filePath, status, diff };
      });
  }

  applyFile(source: string, filePath: string): void {
    execSync(`git checkout ${source} -- "${filePath}"`, {
      cwd: this.repoPath,
      encoding: "utf-8",
    });
  }
}
