import type { Db } from "../db.js";

interface CreateExperiment {
  name: string;
  parent_id?: number;
  config_path: string;
  dataset_version: string;
}

interface EvalResultInput {
  task_type: string;
  metric_name: string;
  metric_value: number;
  per_class_json?: string;
}

interface Experiment {
  id: number;
  name: string;
  parent_id: number | null;
  config_path: string;
  dataset_version: string;
  status: string;
  created_at: string;
}

interface EvalResult {
  id: number;
  experiment_id: number;
  task_type: string;
  metric_name: string;
  metric_value: number;
  per_class_json: string | null;
  created_at: string;
}

interface MetricDiff {
  task_type: string;
  metric_name: string;
  value_a: number;
  value_b: number;
  delta: number;
}

interface ListFilters {
  status?: string;
  task_type?: string;
}

export class ExperimentManager {
  constructor(public db: Db) {}

  create(input: CreateExperiment): number {
    const result = this.db.raw
      .prepare(
        `INSERT INTO experiments (name, parent_id, config_path, dataset_version, status)
         VALUES (?, ?, ?, ?, 'created')`
      )
      .run(input.name, input.parent_id ?? null, input.config_path, input.dataset_version);
    return Number(result.lastInsertRowid);
  }

  get(id: number): Experiment | undefined {
    return this.db.raw.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Experiment | undefined;
  }

  list(filters?: ListFilters): Experiment[] {
    if (filters?.status) {
      return this.db.raw
        .prepare("SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC")
        .all(filters.status) as Experiment[];
    }
    return this.db.raw.prepare("SELECT * FROM experiments ORDER BY created_at DESC").all() as Experiment[];
  }

  addEvalResult(experimentId: number, input: EvalResultInput): number {
    const result = this.db.raw
      .prepare(
        `INSERT INTO eval_results (experiment_id, task_type, metric_name, metric_value, per_class_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(experimentId, input.task_type, input.metric_name, input.metric_value, input.per_class_json ?? null);
    return Number(result.lastInsertRowid);
  }

  getEvalResults(experimentId: number, taskType?: string): EvalResult[] {
    if (taskType) {
      return this.db.raw
        .prepare("SELECT * FROM eval_results WHERE experiment_id = ? AND task_type = ?")
        .all(experimentId, taskType) as EvalResult[];
    }
    return this.db.raw
      .prepare("SELECT * FROM eval_results WHERE experiment_id = ?")
      .all(experimentId) as EvalResult[];
  }

  compare(idA: number, idB: number): MetricDiff[] {
    const resultsA = this.getEvalResults(idA);
    const resultsB = this.getEvalResults(idB);
    const diffs: MetricDiff[] = [];

    const keyA = new Map(resultsA.map((r) => [`${r.task_type}:${r.metric_name}`, r.metric_value]));

    for (const rb of resultsB) {
      const key = `${rb.task_type}:${rb.metric_name}`;
      const va = keyA.get(key);
      if (va !== undefined) {
        diffs.push({
          task_type: rb.task_type,
          metric_name: rb.metric_name,
          value_a: va,
          value_b: rb.metric_value,
          delta: rb.metric_value - va,
        });
      }
    }
    return diffs;
  }
}
