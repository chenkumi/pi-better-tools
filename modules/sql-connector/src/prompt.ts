import type { SqlConnectorConfig } from "./types.js";

export function buildSqlConnectorPrompt(config: SqlConnectorConfig): string | undefined {
  const sections: string[] = [];
  const databaseName = (database: string | undefined) => database ?? "(server default)";

  if (config.mysql) {
    sections.push(`- MySQL: database \`${databaseName(config.mysql.database)}\`. Available tools: mysql_state, mysql_query, mysql_update.
  mysql_query/mysql_update use \`?\` SQL placeholders and an ordered JSON array for \`params\`.
  MySQL SELECT/CTE queries must include a literal \`LIMIT\` from 1 to 200.
  Example: \`SELECT * FROM users WHERE id = ? LIMIT 1\` with \`params: [42]\`.`);
  }
  if (config.mssql) {
    sections.push(`- Microsoft SQL Server: database \`${databaseName(config.mssql.database)}\`. Available tools: mssql_state, mssql_query, mssql_update.
  mssql_query/mssql_update use \`@name\` SQL placeholders and a JSON object for \`params\`; keys must not include \`@\`.
  MSSQL SELECT/CTE queries must use \`TOP n\` from 1 to 200.
  Example: \`SELECT TOP 1 * FROM orders WHERE id = @orderId\` with \`params: {"orderId": 42}\`.`);
  }
  if (config.pgsql) {
    sections.push(`- PostgreSQL: database \`${databaseName(config.pgsql.database)}\`. Available tools: pgsql_state, pgsql_query, pgsql_update.
  pgsql_query/pgsql_update use \`$1\`, \`$2\`, … SQL placeholders and an ordered JSON array for \`params\`.
  PostgreSQL SELECT/CTE queries must include a literal \`LIMIT\` from 1 to 200.
  Example: \`SELECT * FROM events WHERE account_id = $1 LIMIT 1\` with \`params: [42]\`.`);
  }

  if (sections.length === 0) return undefined;
  return `## SQL Connector

Configured databases:\n${sections.join("\n\n")}

Use *_state to verify a connection before querying. Use *_query for reads and *_update for INSERT, UPDATE, or DELETE only. Every update requires user confirmation. Never place passwords or connection strings in SQL, tool arguments, or responses.`;
}
