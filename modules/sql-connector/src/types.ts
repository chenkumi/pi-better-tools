export const ENGINES = ["mysql", "mssql", "pgsql"] as const;

export type Engine = (typeof ENGINES)[number];
export type SqlScalar = null | boolean | number | string;

export interface DatabaseConfig {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl: boolean;
  windowsAuth: boolean;
  instanceName?: string;
  odbcDriver?: string;
  trustServerCertificate: boolean;
}

export type SqlConnectorConfig = Partial<Record<Engine, DatabaseConfig>>;

export interface QueryExecution {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface UpdateExecution {
  affectedRows: number;
}

export interface StateExecution {
  engine: Engine;
  database: string | null;
  version: string | null;
}

export class SqlConnectorError extends Error {
  constructor(
    public readonly code:
      | "CONFIG_INVALID"
      | "SECRET_MISSING"
      | "ENGINE_NOT_CONFIGURED"
      | "POLICY_DENIED"
      | "CONFIRMATION_DENIED"
      | "CONNECTIVITY"
      | "AUTH_OR_TLS"
      | "TIMEOUT"
      | "SQL_SYNTAX"
      | "SQL_CONSTRAINT"
      | "DRIVER_INTERNAL",
    message: string,
  ) {
    super(message);
    this.name = "SqlConnectorError";
  }
}
