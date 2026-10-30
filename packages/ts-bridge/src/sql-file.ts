import { loadBuildProject, type BuildProject as SqlFileProject } from "@typed-sql/build";
import { type CompileSqlFileResult, compileSqlFile } from "@typed-sql/compiler";

export type { SqlFileProject };
export const loadSqlFileProject = loadBuildProject;

export interface SqlFileAnalysis extends CompileSqlFileResult {}

export function analyzeSqlFile(content: string, project: SqlFileProject): SqlFileAnalysis {
  const { dialect, typePolicy } = project.loaded.config;
  return compileSqlFile({
    source: content,
    dialect,
    schema: project.snapshot,
    ...(typePolicy === undefined ? {} : { typePolicy }),
  });
}
