export const postgresVersionQuery = `
    SELECT current_setting('server_version') AS server_version,
           current_setting('standard_conforming_strings') AS standard_conforming_strings,
           current_setting('search_path') AS search_path,
           ARRAY(SELECT extname || ':' || extversion FROM pg_catalog.pg_extension ORDER BY extname) AS extensions
  `;
