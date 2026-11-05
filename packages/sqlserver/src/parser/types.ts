import type { SourceRange } from "@typed-sql/core";
export interface Token {
  readonly kind:
    | "word"
    | "identifier"
    | "string"
    | "number"
    | "binary"
    | "parameter"
    | "system"
    | "operator"
    | "punctuation"
    | "eof";
  readonly text: string;
  readonly value: string;
  readonly range: SourceRange;
}
export interface Name {
  readonly parts: readonly string[];
  readonly range: SourceRange;
}
export interface Order {
  readonly expression: Expression;
  readonly direction: "asc" | "desc";
  readonly range: SourceRange;
}
export interface Window {
  readonly partition: readonly Expression[];
  readonly order: readonly Order[];
  readonly frame?: { readonly kind: "rows" | "range"; readonly start: FrameBoundary; readonly end?: FrameBoundary };
  readonly range: SourceRange;
}
export interface FrameBoundary {
  readonly kind: "preceding" | "following" | "current";
  readonly offset?: Expression;
  readonly unbounded?: boolean;
  readonly range: SourceRange;
}
interface Node {
  readonly range: SourceRange;
}
export type Expression =
  | (Node & {
      readonly kind: "literal";
      readonly value: string | number | boolean | null;
      readonly literal: "string" | "number" | "null" | "binary";
      readonly unicode?: boolean;
    })
  | (Node & { readonly kind: "parameter"; readonly index: number; readonly name?: string })
  | (Node & { readonly kind: "column"; readonly name: Name })
  | (Node & { readonly kind: "system"; readonly name: string })
  | (Node & { readonly kind: "star"; readonly qualifier?: Name })
  | (Node & { readonly kind: "unary"; readonly operator: string; readonly argument: Expression })
  | (Node & {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: Expression;
      readonly right: Expression;
    })
  | (Node & {
      readonly kind: "call";
      readonly name: Name;
      readonly arguments: readonly Expression[];
      readonly distinct: boolean;
      readonly over?: Window;
      readonly withinGroup?: readonly Order[];
    })
  | (Node & {
      readonly kind: "cast";
      readonly argument: Expression;
      readonly databaseType: string;
      readonly try: boolean;
      readonly style?: Expression;
    })
  | (Node & {
      readonly kind: "case";
      readonly operand?: Expression;
      readonly arms: readonly { readonly when: Expression; readonly then: Expression }[];
      readonly otherwise?: Expression;
    })
  | (Node & { readonly kind: "isnull"; readonly argument: Expression; readonly not: boolean })
  | (Node & {
      readonly kind: "in";
      readonly argument: Expression;
      readonly values: readonly Expression[] | Select;
      readonly not: boolean;
    })
  | (Node & {
      readonly kind: "between";
      readonly argument: Expression;
      readonly lower: Expression;
      readonly upper: Expression;
      readonly not: boolean;
    })
  | (Node & { readonly kind: "exists"; readonly query: Select; readonly not: boolean })
  | (Node & { readonly kind: "subquery"; readonly query: Select })
  | (Node & { readonly kind: "default" });
export interface Projection extends Node {
  readonly expression: Expression;
  readonly alias?: string;
}
export type Source = Node &
  (
    | {
        readonly kind: "table";
        readonly name: Name;
        readonly alias?: string;
        readonly hints: readonly string[];
        readonly systemTime?: Expression;
      }
    | { readonly kind: "derived"; readonly query: Select; readonly alias: string; readonly columns: readonly string[] }
    | {
        readonly kind: "function";
        readonly call: Expression & { readonly kind: "call" };
        readonly alias?: string;
        readonly columns: readonly string[];
        readonly shape?: readonly {
          readonly name: string;
          readonly databaseType: string;
          readonly path?: string;
          readonly json?: boolean;
        }[];
      }
  );
export interface Join extends Node {
  readonly kind: "inner" | "left" | "right" | "full" | "cross" | "cross-apply" | "outer-apply";
  readonly source: Source;
  readonly on?: Expression;
}
export interface Cte extends Node {
  readonly name: string;
  readonly columns: readonly string[];
  readonly query: Select;
}
export interface Top extends Node {
  readonly count: Expression;
  readonly percent: boolean;
  readonly ties: boolean;
}
export interface Select extends Node {
  readonly kind: "select";
  readonly with: readonly Cte[];
  readonly distinct: boolean;
  readonly top?: Top;
  readonly projections: readonly Projection[];
  readonly from?: Source;
  readonly joins: readonly Join[];
  readonly where?: Expression;
  readonly group: readonly Expression[];
  readonly having?: Expression;
  readonly order: readonly Order[];
  readonly offset?: Expression;
  readonly fetch?: Expression;
  readonly compounds: readonly {
    readonly operator: "union" | "except" | "intersect";
    readonly all: boolean;
    readonly query: Select;
  }[];
  readonly forJson?: "path" | "auto";
  readonly includeNulls?: boolean;
}
export interface Assignment extends Node {
  readonly column: Name;
  readonly value: Expression;
}
export interface Output extends Node {
  readonly projections: readonly Projection[];
  readonly into?: Name;
  readonly columns: readonly string[];
}
export interface Insert extends Node {
  readonly kind: "insert";
  readonly with: readonly Cte[];
  readonly target: Name;
  readonly columns: readonly string[];
  readonly values: readonly (readonly Expression[])[];
  readonly query?: Select;
  readonly defaultValues: boolean;
  readonly output?: Output;
}
export interface Update extends Node {
  readonly kind: "update";
  readonly with: readonly Cte[];
  readonly target: Name;
  readonly top?: Top;
  readonly assignments: readonly Assignment[];
  readonly output?: Output;
  readonly from?: Source;
  readonly joins: readonly Join[];
  readonly where?: Expression;
}
export interface Delete extends Node {
  readonly kind: "delete";
  readonly with: readonly Cte[];
  readonly target: Name;
  readonly top?: Top;
  readonly output?: Output;
  readonly from?: Source;
  readonly joins: readonly Join[];
  readonly where?: Expression;
}
export type Statement = Select | Insert | Update | Delete;
export class SqlServerParseError extends SyntaxError {
  constructor(
    message: string,
    readonly range: SourceRange,
    readonly code = "TSQ001",
  ) {
    super(message);
    this.name = "SqlServerParseError";
  }
}
