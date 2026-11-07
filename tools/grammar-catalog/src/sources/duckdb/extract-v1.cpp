#include "duckdb.hpp"
#include "duckdb/catalog/catalog.hpp"
#include "duckdb/catalog/catalog_entry/schema_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/scalar_function_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/aggregate_function_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/table_function_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/pragma_function_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/scalar_macro_catalog_entry.hpp"
#include "duckdb/catalog/catalog_entry/table_macro_catalog_entry.hpp"
#include "duckdb/parser/expression/columnref_expression.hpp"
#include "duckdb/parser/expression/window_expression.hpp"
#include "duckdb/function/scalar_macro_function.hpp"
#include "duckdb/function/table_macro_function.hpp"
#include "duckdb/main/client_context.hpp"
#include <iostream>
using namespace duckdb;
static idx_t registration_count = 0;
static void quoted(const string &s) {
  std::cout << '"';
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') std::cout << '\\' << c;
    else if (c < 32) { const char *hex = "0123456789abcdef"; std::cout << "\\u00" << hex[c >> 4] << hex[c & 15]; }
    else std::cout << c;
  }
  std::cout << '"';
}
static void result(const ScalarFunction &f) { quoted(f.return_type.ToString()); }
static void result(const AggregateFunction &f) { quoted(f.return_type.ToString()); }
static void result(const TableFunction &) { std::cout << "null"; }
static void result(const PragmaFunction &) { std::cout << "null"; }
static void options(const SimpleFunction &) { }
static void options(const SimpleNamedParameterFunction &f) {
  bool first = true;
  for (auto &p : f.named_parameters) {
    if (!first) std::cout << ','; first = false;
    std::cout << "{\"name\":"; quoted(p.first);
    std::cout << ",\"type\":"; quoted(p.second.ToString());
    std::cout << ",\"aliases\":[]}";
  }
}
template <class T> static void emit(CatalogEntry &raw, const char *kind) {
  auto &entry = raw.Cast<T>();
  for (idx_t i = 0; i < entry.functions.Size(); i++) {
    registration_count++;
    auto f = entry.functions.GetFunctionByOffset(i);
    std::cout << "{\"schema\":"; quoted(entry.schema.name);
    std::cout << ",\"name\":"; quoted(entry.name);
    std::cout << ",\"kind\":"; quoted(kind);
    std::cout << ",\"overload\":" << i << ",\"definition\":null,\"macroDefaults\":[],\"result\":"; result(f);
    std::cout << ",\"parameters\":[";
    bool first = true;
    for (auto &type : f.arguments) {
      if (!first) std::cout << ','; first = false;
      std::cout << "{\"name\":null,\"type\":"; quoted(type.ToString());
      std::cout << ",\"kind\":null,\"default\":null}";
    }
    if (f.HasVarArgs()) {
      if (!first) std::cout << ',';
      std::cout << "{\"name\":null,\"type\":"; quoted(f.varargs.ToString());
      std::cout << ",\"kind\":2,\"default\":null}";
    }
    std::cout << "],\"options\":["; options(f);
    std::cout << "]}\n";
  }
}
template <class T> static void emitMacro(CatalogEntry &raw, const char *kind) {
  auto &entry = raw.Cast<T>();
  for (idx_t i = 0; i < entry.macros.size(); i++) {
    registration_count++;
    auto &macro = *entry.macros[i];
    std::cout << "{\"schema\":"; quoted(entry.schema.name);
    std::cout << ",\"name\":"; quoted(entry.name);
    std::cout << ",\"kind\":"; quoted(kind);
    std::cout << ",\"overload\":" << i << ",\"result\":null,\"definition\":";
    if (macro.type == MacroType::SCALAR_MACRO) quoted(macro.template Cast<ScalarMacroFunction>().expression->ToString());
    else quoted(macro.template Cast<TableMacroFunction>().query_node->ToString());
    std::cout << ",\"parameters\":[";
    bool first = true;
    for (idx_t p = 0; p < macro.parameters.size(); p++) {
      if (!first) std::cout << ','; first = false;
      std::cout << "{\"name\":"; quoted(macro.parameters[p]->template Cast<ColumnRefExpression>().GetColumnName());
      std::cout << ",\"type\":";
      if (!macro.types.empty() && macro.types[p] != LogicalType::UNKNOWN) quoted(macro.types[p].ToString());
      else std::cout << "null";
      std::cout << ",\"kind\":1,\"default\":null}";
    }
    std::cout << "],\"macroDefaults\":["; first = true;
    for (auto &p : macro.default_parameters) {
      if (!first) std::cout << ','; first = false;
      std::cout << "{\"name\":"; quoted(p.first);
      std::cout << ",\"expression\":"; quoted(p.second->ToString());
      std::cout << '}';
    }
    std::cout << "],\"options\":[]}\n";
  }
}
int main() {
  std::cout << "{\"version\":"; quoted(DuckDB::LibraryVersion());
  std::cout << ",\"sourceId\":"; quoted(DuckDB::SourceID()); std::cout << "}\n";
  DuckDB db(nullptr); Connection con(db);
  auto counted = con.Query("SELECT count(*) FROM duckdb_functions() WHERE database_name='system'");
  if (counted->HasError()) throw std::runtime_error(counted->GetError());
  auto count_chunk = counted->Fetch();
  if (!count_chunk || count_chunk->size() != 1) throw std::runtime_error("Missing catalog count");
  auto expected_count = count_chunk->GetValue(0, 0).GetValue<int64_t>();
  con.context->RunFunctionInTransaction([&]() {
    for (auto &schema : Catalog::GetAllSchemas(*con.context)) {
      if (schema.get().catalog.GetName() != "system") continue;
      for (auto type : {CatalogType::SCALAR_FUNCTION_ENTRY, CatalogType::TABLE_FUNCTION_ENTRY, CatalogType::PRAGMA_FUNCTION_ENTRY})
        schema.get().Scan(*con.context, type, [&](CatalogEntry &entry) {
          switch(entry.type) {
          case CatalogType::SCALAR_FUNCTION_ENTRY: emit<ScalarFunctionCatalogEntry>(entry, "scalar"); break;
          case CatalogType::AGGREGATE_FUNCTION_ENTRY: emit<AggregateFunctionCatalogEntry>(entry, "aggregate"); break;
          case CatalogType::TABLE_FUNCTION_ENTRY: emit<TableFunctionCatalogEntry>(entry, "table"); break;
          case CatalogType::PRAGMA_FUNCTION_ENTRY: emit<PragmaFunctionCatalogEntry>(entry, "pragma"); break;
          case CatalogType::MACRO_ENTRY: emitMacro<ScalarMacroCatalogEntry>(entry, "macro"); break;
          case CatalogType::TABLE_MACRO_ENTRY: emitMacro<TableMacroCatalogEntry>(entry, "table_macro"); break;
          default: throw std::runtime_error("Unaccounted function catalog kind");
          }
        });
    }
  });
  for (auto window = WindowExpression::WindowFunctions(); window->name; ++window) {
    registration_count++;
    std::cout << "{\"schema\":\"main\",\"name\":"; quoted(window->name);
    std::cout << ",\"kind\":\"window\",\"overload\":0,\"result\":null,\"definition\":null,\"parameters\":null,\"macroDefaults\":[],\"options\":[]}\n";
  }
  if (registration_count != static_cast<idx_t>(expected_count)) throw std::runtime_error("Incomplete catalog scan " + std::to_string(registration_count) + "/" + std::to_string(expected_count));
  std::cout << "{\"registrations\":" << registration_count << "}\n";
}
